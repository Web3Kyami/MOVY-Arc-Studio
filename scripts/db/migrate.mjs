import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

const { Pool } = pg
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for migrations')
const url = new URL(databaseUrl)
if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL')
const schema = process.env.MOVY_DB_SCHEMA ?? 'public'
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('MOVY_DB_SCHEMA is invalid')
const serverNetwork = process.env.MOVY_TARGET_NETWORK
const browserNetwork = process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK
const network = serverNetwork ?? browserNetwork ?? 'testnet'
if (!['mainnet', 'testnet'].includes(network)) throw new Error('MOVY_TARGET_NETWORK must be mainnet or testnet')
if (serverNetwork && browserNetwork && serverNetwork !== browserNetwork) throw new Error('Server and browser network targets do not match')
if (process.env.NODE_ENV === 'production' && (!serverNetwork || !browserNetwork)) {
  throw new Error('Production database migration requires explicit server and browser network targets')
}
const databaseNetwork = process.env.MOVY_DATABASE_NETWORK ?? network
if (!['mainnet', 'testnet'].includes(databaseNetwork) || databaseNetwork !== network) {
  throw new Error('MOVY_DATABASE_NETWORK must match the selected Arc network')
}
if (process.env.NODE_ENV === 'production' && process.env.MOVY_DATABASE_NETWORK !== network) {
  throw new Error('Production database migration requires explicit MOVY_DATABASE_NETWORK')
}
const quotedSchema = `"${schema}"`

const rootPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
try {
  await rootPool.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`)
} finally {
  await rootPool.end()
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5000,
  options: `-c search_path=${schema}`,
})
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  let currentVersion = Number((await pool.query('SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations')).rows[0].version)
  const migrationFiles = (await readdir(resolve('db/migrations')))
    .filter((file) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(file))
    .sort()
  const client = await pool.connect()
  try {
    for (const file of migrationFiles) {
      const version = Number(file.slice(0, 3))
      if (version <= currentVersion) continue
      if (version !== currentVersion + 1) throw new Error(`Missing migration version ${currentVersion + 1}`)
      const sql = await readFile(resolve('db/migrations', file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
      currentVersion = version
      console.log(`MOVY database schema ${schema} migrated to version ${version}`)
    }
  } finally {
    client.release()
  }
  await pool.query(`
    INSERT INTO movy_database_binding(singleton, network_name)
    VALUES (true, $1)
    ON CONFLICT (singleton) DO NOTHING
  `, [databaseNetwork])
  const binding = await pool.query('SELECT network_name FROM movy_database_binding WHERE singleton = true')
  if (binding.rowCount !== 1 || binding.rows[0].network_name !== databaseNetwork) {
    throw new Error('Database is already bound to a different Arc network; use a separate database/schema')
  }
  console.log(`MOVY database schema ${schema} is current at version ${currentVersion}`)
} finally {
  await pool.end()
}
