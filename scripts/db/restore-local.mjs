import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import pg from 'pg'

const backupPath = process.env.BACKUP_PATH
const identityPath = process.env.AGE_IDENTITY_FILE
const connectionString = process.env.RECOVERY_DATABASE_URL
if (!backupPath || !identityPath || !connectionString) {
  throw new Error('BACKUP_PATH, AGE_IDENTITY_FILE, and RECOVERY_DATABASE_URL are required')
}
const url = new URL(connectionString)
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
  throw new Error('Local restore drill refuses non-local database targets')
}
const { Pool } = pg
const schema = process.env.MOVY_DB_SCHEMA ?? 'public'
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('MOVY_DB_SCHEMA is invalid')
const pool = new Pool({ connectionString, max: 1, options: `-c search_path=${schema},public` })
try {
  const targetTables = await pool.query(`
    SELECT COUNT(*)::int AS count FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = ANY($2::text[])
  `, [schema, [
    'schema_migrations', 'chain_cursor', 'enrollment_event_cursor', 'enrollment_history_cursor',
    'enrollment_state_history', 'payment_history_replay', 'worker_locks', 'api_rate_limits',
    'enrollments', 'observed_payments', 'roundup_jobs',
  ]])
  if (targetTables.rows[0].count !== 0) throw new Error('Restore target is not empty; refusing to overwrite data')
} finally {
  await pool.end()
}

const pgEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGSSLMODE: url.searchParams.get('sslmode') ?? 'disable',
  PGCONNECT_TIMEOUT: '5',
}
delete pgEnv.RECOVERY_DATABASE_URL
const decrypt = spawn('age', ['--decrypt', '--identity', identityPath, backupPath], {
  shell: false,
  stdio: ['ignore', 'pipe', 'ignore'],
})
const restore = spawn('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error'], {
  shell: false,
  env: pgEnv,
  stdio: ['pipe', 'ignore', 'ignore'],
})
const exitCode = (child) => new Promise((resolve, reject) => {
  child.once('error', () => reject(new Error('Restore process could not start')))
  child.once('close', (code) => resolve(code ?? 1))
})
const streamResult = pipeline(decrypt.stdout, restore.stdin).catch(() => {
  decrypt.kill('SIGTERM')
  restore.kill('SIGTERM')
  throw new Error('Restore stream failed')
})
const [decryptCode, restoreCode] = await Promise.all([exitCode(decrypt), exitCode(restore), streamResult])
  .then(([ageExit, pgExit]) => [ageExit, pgExit])
if (decryptCode !== 0 || restoreCode !== 0) throw new Error('Restore failed; the target was not activated')
const verify = spawn(process.execPath, ['scripts/db/verify-recovery.mjs'], {
  shell: false,
  env: { ...process.env, DATABASE_URL: connectionString, MOVY_DB_SCHEMA: schema },
  stdio: 'inherit',
})
if (await exitCode(verify) !== 0) throw new Error('Restore verification failed')
console.log('Isolated local PostgreSQL restore verified')
