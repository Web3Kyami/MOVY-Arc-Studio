import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import pg from 'pg'

const { Pool } = pg
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required; start the isolated PostgreSQL test service first')
const url = new URL(databaseUrl)
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
  throw new Error('Isolated database tests are restricted to a local PostgreSQL server')
}
const script = process.argv[2]
if (!script) throw new Error('Pass the test script to run')
const schema = `movy_test_${randomUUID().replaceAll('-', '')}`
const rootPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
await rootPool.query(`CREATE SCHEMA "${schema}"`)
await rootPool.end()

let exitCode = 1
try {
  const migration = spawn(process.execPath, ['scripts/db/migrate.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, MOVY_DB_SCHEMA: schema },
  })
  const migrationResult = await new Promise((resolve) => migration.on('exit', (code) => resolve(code ?? 1)))
  if (migrationResult !== 0) throw new Error('Test schema migration failed')

  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    stdio: 'inherit',
    env: { ...process.env, MOVY_DB_SCHEMA: schema },
  })
  exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
} finally {
  const cleanupPool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await cleanupPool.end()
  }
}
process.exitCode = exitCode
