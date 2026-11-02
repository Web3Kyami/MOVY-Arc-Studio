import { DatabaseSync } from 'node:sqlite'
import { stat } from 'node:fs/promises'
import pg from 'pg'

const { Pool } = pg
const sourcePath = process.env.MOVY_SQLITE_SOURCE
const databaseUrl = process.env.DATABASE_URL
if (!sourcePath || !databaseUrl) throw new Error('MOVY_SQLITE_SOURCE and DATABASE_URL are required')
const url = new URL(databaseUrl)
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
  throw new Error('SQLite import rehearsal is restricted to a local PostgreSQL database; production migration requires a separately reviewed procedure')
}
const schema = process.env.MOVY_DB_SCHEMA ?? 'public'
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('MOVY_DB_SCHEMA is invalid')
await stat(sourcePath)

const source = new DatabaseSync(sourcePath, { readOnly: true })
source.exec('PRAGMA query_only = ON')
const target = new Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema},public` })
const tables = [
  'chain_cursor', 'enrollment_event_cursor', 'enrollment_history_cursor', 'enrollment_state_history',
  'payment_history_replay', 'worker_locks', 'api_rate_limits', 'enrollments', 'observed_payments', 'roundup_jobs',
]
const insertRows = async (client, table, columns, rows, transform = (row) => columns.map((column) => row[column])) => {
  if (rows.length === 0) return
  const columnList = columns.join(', ')
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
  const statement = `INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`
  for (const row of rows) await client.query(statement, transform(row))
}

const imports = [
  ['chain_cursor', ['chain_id', 'last_processed_block', 'updated_at']],
  ['enrollment_event_cursor', ['chain_id', 'last_processed_block', 'updated_at']],
  ['enrollment_history_cursor', ['chain_id', 'last_processed_block', 'updated_at']],
  ['enrollment_state_history', ['chain_id', 'wallet', 'block_number', 'log_index', 'destination', 'max_roundup_6', 'daily_cap_6', 'config_epoch', 'status'], (row) => [row.chain_id, row.wallet.toLowerCase(), row.block_number, row.log_index, row.destination, row.max_roundup_6, row.daily_cap_6, row.config_epoch, row.status]],
  ['payment_history_replay', ['chain_id', 'next_block', 'target_block', 'completed'], (row) => [row.chain_id, row.next_block, row.target_block, Boolean(row.completed)]],
  ['worker_locks', ['lock_name', 'owner_token', 'lease_expires_at', 'fencing_token']],
  ['api_rate_limits', ['rate_key', 'window_started_at', 'request_count']],
  ['enrollments', ['chain_id', 'wallet', 'destination', 'max_roundup_6', 'daily_cap_6', 'config_epoch', 'status', 'enrolled_at', 'updated_at'], (row) => [row.chain_id, row.wallet.toLowerCase(), row.destination, row.max_roundup_6, row.daily_cap_6, row.config_epoch, row.status, row.enrolled_at, row.updated_at]],
  ['observed_payments', ['payment_key', 'chain_id', 'tx_hash', 'log_index', 'block_number', 'payer', 'recipient', 'amount_6', 'roundup_6', 'is_eligible', 'exclusion_reason', 'created_at'], (row) => [row.payment_key, row.chain_id, row.tx_hash, row.log_index, row.block_number, row.payer.toLowerCase(), row.recipient, row.amount_6, row.roundup_6, Boolean(row.is_eligible), row.exclusion_reason, row.created_at]],
  ['roundup_jobs', ['job_id', 'payment_key', 'chain_id', 'wallet', 'destination', 'roundup_amount_6', 'config_epoch', 'status', 'skip_reason', 'relayer_tx_hash', 'attempts', 'last_error', 'created_at', 'updated_at'], (row) => [row.job_id, row.payment_key, row.chain_id, row.wallet.toLowerCase(), row.destination, row.roundup_amount_6, row.config_epoch, row.status, row.skip_reason, row.relayer_tx_hash, row.attempts, row.last_error, row.created_at, row.updated_at]],
]

try {
  const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
  for (const table of tables) if (!sourceTables.has(table)) throw new Error(`SQLite source is missing required table: ${table}`)
  const client = await target.connect()
  try {
    await client.query('BEGIN')
    const migration = await client.query('SELECT MAX(version)::int AS version FROM schema_migrations')
    if (Number(migration.rows[0]?.version ?? 0) < 1) throw new Error('Target database must be migrated before import')
    for (const table of tables) {
      const existing = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)
      if (existing.rows[0].count !== 0) throw new Error(`Target table ${table} is not empty; import is refused`)
    }
    for (const [table, columns, transform] of imports) {
      const rows = source.prepare(`SELECT * FROM ${table}`).all()
      await insertRows(client, table, columns, rows, transform)
      console.log(`Imported ${rows.length} ${table} rows`)
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('roundup_jobs', 'job_id'), COALESCE(MAX(job_id), 1), MAX(job_id) IS NOT NULL) FROM roundup_jobs`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
} finally {
  source.close()
  await target.end()
}
console.log('Local-only SQLite migration rehearsal completed. Source was opened read-only.')
