import { spawn } from 'node:child_process'
import { chmod, rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

const connectionString = process.env.DATABASE_URL
const recipient = process.env.AGE_RECIPIENT
const outputPath = process.env.BACKUP_PATH
if (!connectionString || !recipient || !outputPath) {
  throw new Error('DATABASE_URL, AGE_RECIPIENT, and BACKUP_PATH are required')
}
const url = new URL(connectionString)
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech')) {
  throw new Error('Encrypted backups require a Neon PostgreSQL connection')
}
if (!['require', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')) {
  throw new Error('Neon backup connections must require TLS')
}
try {
  await stat(outputPath)
  throw new Error('Backup path already exists; refusing to overwrite')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const pgEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGSSLMODE: url.searchParams.get('sslmode'),
  PGCONNECT_TIMEOUT: '5',
}
delete pgEnv.DATABASE_URL
process.umask(0o077)
const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges'], {
  shell: false,
  env: pgEnv,
  stdio: ['ignore', 'pipe', 'ignore'],
})
const encrypt = spawn('age', ['--recipient', recipient, '--output', outputPath], {
  shell: false,
  env: process.env,
  stdio: ['pipe', 'ignore', 'ignore'],
})
const exitCode = (child) => new Promise((resolve, reject) => {
  child.once('error', () => reject(new Error('Backup process could not start')))
  child.once('close', (code) => resolve(code ?? 1))
})
try {
  const streamResult = pipeline(dump.stdout, encrypt.stdin).catch(() => {
    dump.kill('SIGTERM')
    encrypt.kill('SIGTERM')
    throw new Error('Encrypted backup stream failed')
  })
  const [dumpCode, encryptCode] = await Promise.all([exitCode(dump), exitCode(encrypt), streamResult]).then(([dumpExit, ageExit]) => [dumpExit, ageExit])
  if (dumpCode !== 0 || encryptCode !== 0) throw new Error('Encrypted backup failed; no plaintext dump was written')
  await chmod(outputPath, 0o600)
  console.log(`Encrypted MOVY database backup created: ${outputPath}`)
} catch (error) {
  await rm(outputPath, { force: true })
  throw error instanceof Error && error.message === 'Backup path already exists; refusing to overwrite'
    ? error
    : new Error('Encrypted backup failed; verify the database and age configuration without exposing credentials')
}
