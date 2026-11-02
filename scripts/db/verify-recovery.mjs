import pg from 'pg'

const { Pool } = pg
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const url = new URL(databaseUrl)
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
  throw new Error('Recovery verification is restricted to an isolated local PostgreSQL target')
}
const schema = process.env.MOVY_DB_SCHEMA ?? 'public'
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('MOVY_DB_SCHEMA is invalid')
const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5000,
  ...(schema === 'public' ? {} : { options: `-c search_path=${schema},public` }),
})
try {
  const migration = await pool.query('SELECT MAX(version)::int AS version FROM schema_migrations')
  const version = Number(migration.rows[0]?.version ?? 0)
  if (version < 1) throw new Error('Restored database is missing MOVY schema migrations')
  const [enrollments, history, cursors, payments, jobs, danglingJobs, amountErrors] = await Promise.all([
    pool.query('SELECT COUNT(*)::text AS count FROM enrollments'),
    pool.query('SELECT COUNT(*)::text AS count FROM enrollment_state_history'),
    pool.query(`SELECT (SELECT COUNT(*) FROM chain_cursor) + (SELECT COUNT(*) FROM enrollment_history_cursor) + (SELECT COUNT(*) FROM enrollment_event_cursor) AS count`),
    pool.query('SELECT COUNT(*)::text AS count FROM observed_payments'),
    pool.query(`SELECT status, COUNT(*)::text AS count FROM roundup_jobs GROUP BY status ORDER BY status`),
    pool.query(`SELECT COUNT(*)::text AS count FROM roundup_jobs j LEFT JOIN observed_payments p ON p.payment_key=j.payment_key WHERE p.payment_key IS NULL`),
    pool.query(`SELECT COUNT(*)::text AS count FROM observed_payments WHERE amount_6 !~ '^[0-9]+$' OR roundup_6 !~ '^[0-9]+$'`),
  ])
  if (danglingJobs.rows[0].count !== '0') throw new Error('Restore contains relayer jobs without their source payment records')
  if (amountErrors.rows[0].count !== '0') throw new Error('Restore contains invalid exact-integer payment amounts')
  const report = {
    schemaVersion: version,
    enrollments: enrollments.rows[0].count,
    enrollmentHistory: history.rows[0].count,
    cursorRows: Number(cursors.rows[0].count),
    observedPayments: payments.rows[0].count,
    roundupJobsByStatus: Object.fromEntries(jobs.rows.map((row) => [row.status, row.count])),
    danglingRelayerJobs: 0,
    invalidPaymentAmounts: 0,
    verified: true,
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  await pool.end()
}
