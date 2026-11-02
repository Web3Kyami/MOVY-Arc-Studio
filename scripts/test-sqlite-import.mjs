import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

const { Pool } = pg
const url = new URL(process.env.DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('SQLite import tests require local PostgreSQL')
const directory = mkdtempSync(join(tmpdir(), 'movy-sqlite-import-'))
const sourcePath = join(directory, 'legacy.sqlite')
const source = new DatabaseSync(sourcePath)
source.exec(`
  CREATE TABLE chain_cursor(chain_id INTEGER PRIMARY KEY,last_processed_block INTEGER NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE enrollment_event_cursor(chain_id INTEGER PRIMARY KEY,last_processed_block INTEGER NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE enrollment_history_cursor(chain_id INTEGER PRIMARY KEY,last_processed_block INTEGER NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE enrollment_state_history(chain_id INTEGER,wallet TEXT,block_number INTEGER,log_index INTEGER,destination TEXT,max_roundup_6 TEXT,daily_cap_6 TEXT,config_epoch INTEGER,status TEXT);
  CREATE TABLE payment_history_replay(chain_id INTEGER PRIMARY KEY,next_block INTEGER,target_block INTEGER,completed INTEGER);
  CREATE TABLE worker_locks(lock_name TEXT PRIMARY KEY,owner_token TEXT,lease_expires_at INTEGER,fencing_token INTEGER);
  CREATE TABLE api_rate_limits(rate_key TEXT PRIMARY KEY,window_started_at INTEGER,request_count INTEGER);
  CREATE TABLE enrollments(chain_id INTEGER,wallet TEXT,destination TEXT,max_roundup_6 TEXT,daily_cap_6 TEXT,config_epoch INTEGER,status TEXT,enrolled_at TEXT,updated_at TEXT);
  CREATE TABLE observed_payments(payment_key TEXT PRIMARY KEY,chain_id INTEGER,tx_hash TEXT,log_index INTEGER,block_number INTEGER,payer TEXT,recipient TEXT,amount_6 TEXT,roundup_6 TEXT,is_eligible INTEGER,exclusion_reason TEXT,created_at TEXT);
  CREATE TABLE roundup_jobs(job_id INTEGER PRIMARY KEY,payment_key TEXT UNIQUE,chain_id INTEGER,wallet TEXT,destination TEXT,roundup_amount_6 TEXT,config_epoch INTEGER,status TEXT,skip_reason TEXT,relayer_tx_hash TEXT,attempts INTEGER,last_error TEXT,created_at TEXT,updated_at TEXT);
`)
const timestamp = '2026-10-09T00:00:00.000Z'
const paymentKey = 'legacy-payment-key'
const wallet = '0x1111111111111111111111111111111111111111'
const destination = '0x2222222222222222222222222222222222222222'
source.prepare('INSERT INTO chain_cursor VALUES(5042002, 900, ?)').run(timestamp)
source.prepare('INSERT INTO enrollment_event_cursor VALUES(5042002, 890, ?)').run(timestamp)
source.prepare('INSERT INTO enrollment_history_cursor VALUES(5042002, 890, ?)').run(timestamp)
source.prepare('INSERT INTO enrollment_state_history VALUES(5042002, ?, 850, 2, ?, ?, ?, 3, ?)').run(wallet, destination, '500000', '2000000', 'active')
source.prepare('INSERT INTO payment_history_replay VALUES(5042002, 700, 900, 0)').run()
source.prepare('INSERT INTO worker_locks VALUES(?, ?, ?, ?)').run('arc-testnet-worker', '00000000-0000-4000-8000-000000000123', Date.now() + 60_000, 9)
source.prepare('INSERT INTO api_rate_limits VALUES(?, ?, ?)').run('enrollment:test', Date.now(), 2)
source.prepare('INSERT INTO enrollments VALUES(5042002, ?, ?, ?, ?, 3, ?, ?, ?)').run(wallet, destination, '500000', '2000000', 'active', timestamp, timestamp)
source.prepare('INSERT INTO observed_payments VALUES(?, 5042002, ?, 2, 860, ?, ?, ?, ?, 1, NULL, ?)').run(paymentKey, `0x${'1'.repeat(64)}`, wallet, '0x3333333333333333333333333333333333333333', '1000000', '10000', timestamp)
source.prepare("INSERT INTO roundup_jobs VALUES(99, ?, 5042002, ?, ?, ?, 3, 'submitting', NULL, NULL, 1, NULL, ?, ?)")
  .run(paymentKey, wallet, destination, '10000', timestamp, timestamp)
source.close()

const child = spawnSync(process.execPath, ['scripts/db/import-sqlite-local.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, MOVY_SQLITE_SOURCE: sourcePath },
  encoding: 'utf8',
})
if (child.status !== 0) throw new Error(`SQLite import rehearsal failed with exit ${child.status}: ${child.stderr}`)
assert.match(child.stdout, /Local-only SQLite migration rehearsal completed/)

const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${process.env.MOVY_DB_SCHEMA},public` })
try {
  const [paymentCursor, enrollment, history, replay, lock, job, counts] = await Promise.all([
    pool.query('SELECT last_processed_block FROM chain_cursor WHERE chain_id=$1', [5042002]),
    pool.query('SELECT max_roundup_6, daily_cap_6 FROM enrollments WHERE chain_id=$1 AND lower(wallet)=lower($2)', [5042002, wallet]),
    pool.query('SELECT status, config_epoch FROM enrollment_state_history WHERE chain_id=$1 AND lower(wallet)=lower($2)', [5042002, wallet]),
    pool.query('SELECT next_block, target_block, completed FROM payment_history_replay WHERE chain_id=$1', [5042002]),
    pool.query('SELECT fencing_token FROM worker_locks WHERE lock_name=$1', ['arc-testnet-worker']),
    pool.query('SELECT job_id, status, attempts, relayer_tx_hash FROM roundup_jobs WHERE payment_key=$1', [paymentKey]),
    pool.query('SELECT (SELECT COUNT(*) FROM observed_payments) AS payments, (SELECT COUNT(*) FROM api_rate_limits) AS rate_limits'),
  ])
  assert.equal(paymentCursor.rows[0].last_processed_block, '900')
  assert.deepEqual(enrollment.rows[0], { max_roundup_6: '500000', daily_cap_6: '2000000' })
  assert.deepEqual(history.rows[0], { status: 'active', config_epoch: '3' })
  assert.deepEqual(replay.rows[0], { next_block: '700', target_block: '900', completed: false })
  assert.equal(lock.rows[0].fencing_token, '9')
  assert.deepEqual(job.rows[0], { job_id: '99', status: 'submitting', attempts: 1, relayer_tx_hash: null })
  assert.deepEqual(counts.rows[0], { payments: '1', rate_limits: '1' })
} finally {
  await pool.end()
  rmSync(directory, { recursive: true, force: true })
}
console.log('Local SQLite-to-PostgreSQL migration rehearsal preserved authorization, cursor, lease, replay, and uncertain relayer state')
