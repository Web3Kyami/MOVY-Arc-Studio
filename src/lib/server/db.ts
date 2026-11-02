import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { assertConfiguredChainId, getConfiguredNetwork, getNetworkForChainId } from './config'

type Queryable = Pool | PoolClient
type DbRow = QueryResultRow & Record<string, unknown>

const DEFAULT_POOL_SIZE = 2
const MAX_POOL_SIZE = 5

type MovyDbGlobal = typeof globalThis & {
  __movyPgPool?: Pool
  __movyPgProxy?: Pool
  __movyPgConnectionString?: string
  __movyPgSchema?: string
  __movyPgNetwork?: string
  __movyPgNetworkBinding?: Promise<void>
}

const dbGlobal = globalThis as MovyDbGlobal

function getConnectionString(): { value: string; url: URL } {
  const value = process.env.DATABASE_URL
  if (!value) {
    throw new Error('DATABASE_URL is required; refusing to fall back to ephemeral SQLite storage')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol')
  }

  const selectedNetwork = getConfiguredNetwork()
  if (process.env.MOVY_DATABASE_NETWORK && process.env.MOVY_DATABASE_NETWORK !== selectedNetwork) {
    throw new Error('MOVY_DATABASE_NETWORK does not match the selected Arc network')
  }
  if (process.env.NODE_ENV === 'production' && process.env.MOVY_DATABASE_NETWORK !== selectedNetwork) {
    throw new Error('Production requires a network-bound PostgreSQL database')
  }

  // The production browser regression suite exercises the production Next.js
  // server against an isolated local PostgreSQL service. Its explicit flag is
  // honored only in CI; Vercel and other production runtimes still require Neon.
  const isolatedCiPostgres = process.env.CI === 'true'
    && process.env.MOVY_TEST_ALLOW_LOCAL_POSTGRES === 'true'
  if (process.env.NODE_ENV === 'production' && !isolatedCiPostgres) {
    if (!url.hostname.endsWith('.neon.tech') || !url.hostname.includes('-pooler.')) {
      throw new Error('Production DATABASE_URL must use a Neon pooled endpoint')
    }
    const sslMode = url.searchParams.get('sslmode')
    if (sslMode !== 'require' && sslMode !== 'verify-full') {
      throw new Error('Production DATABASE_URL must require TLS verification')
    }
  }

  return { value, url }
}

function getSchemaName(): string {
  const schema = process.env.MOVY_DB_SCHEMA ?? 'public'
  // Schema names are interpolated into search_path; only permit simple SQL identifiers.
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('MOVY_DB_SCHEMA is invalid')
  return schema
}

/**
 * PostgreSQL is the only application database. Vercel's writable filesystem is
 * ephemeral, so there is deliberately no SQLite or file-backed fallback.
 */
export function getDb(): Pool {
  const { value, url } = getConnectionString()
  const schema = getSchemaName()
  const network = getConfiguredNetwork()
  if (dbGlobal.__movyPgPool) {
    if (dbGlobal.__movyPgConnectionString !== value || dbGlobal.__movyPgSchema !== schema || dbGlobal.__movyPgNetwork !== network) {
      throw new Error('PostgreSQL configuration changed after the pool was initialized')
    }
    return dbGlobal.__movyPgProxy ?? dbGlobal.__movyPgPool
  }

  const configuredPoolSize = process.env.MOVY_DB_POOL_SIZE
  const max = configuredPoolSize === undefined ? DEFAULT_POOL_SIZE : Number(configuredPoolSize)
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_POOL_SIZE) {
    throw new Error(`MOVY_DB_POOL_SIZE must be an integer from 1 to ${MAX_POOL_SIZE}`)
  }

  const sslMode = url.searchParams.get('sslmode')
  const pool = new Pool({
    connectionString: value,
    max,
    allowExitOnIdle: true,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    query_timeout: 8_000,
    statement_timeout: 8_000,
    lock_timeout: 3_000,
    // Isolated test schemas must never fall through to public tables, which
    // could make a missing-table or recovery test silently read shared data.
    ...(schema === 'public' ? {} : { options: `-c search_path=${schema}` }),
    ...(sslMode === 'disable' ? { ssl: false } : { ssl: { rejectUnauthorized: true } }),
    application_name: 'movy-api',
  })
  pool.on('error', (error: NodeJS.ErrnoException) => {
    // Never log connection strings, provider messages, or credential-bearing URLs.
    console.error('Idle PostgreSQL client failed', { code: error.code ?? 'unknown' })
  })

  // Bind every database/schema to exactly one network. The binding is written
  // by the migration/bootstrap command and checked before the first query or
  // acquired connection, so a Mainnet process cannot consume Testnet cursors,
  // enrollments, locks, or roundup jobs even if DATABASE_URL is miswired.
  const rawQuery = pool.query.bind(pool)
  const ensureNetworkBinding = (): Promise<void> => {
    if (dbGlobal.__movyPgNetworkBinding) return dbGlobal.__movyPgNetworkBinding
    const binding = rawQuery<{ network_name: string }>(
      'SELECT network_name FROM movy_database_binding WHERE singleton = true',
    ).then((result) => {
      if (result.rowCount !== 1 || result.rows[0]?.network_name !== network) {
        throw new Error('PostgreSQL network binding does not match this MOVY deployment')
      }
    }).catch((error) => {
      dbGlobal.__movyPgNetworkBinding = undefined
      if (error instanceof Error && error.message === 'PostgreSQL network binding does not match this MOVY deployment') throw error
      throw new Error('PostgreSQL network binding is missing; run the reviewed network migration before serving requests')
    })
    dbGlobal.__movyPgNetworkBinding = binding
    return binding
  }

  const guardedPool = new Proxy(pool, {
    get(target, property) {
      if (property === 'query') {
        return (...args: unknown[]) => ensureNetworkBinding().then(() => rawQuery(...args as Parameters<Pool['query']>))
      }
      if (property === 'connect') {
        return (...args: unknown[]) => ensureNetworkBinding().then(() => target.connect(...args as Parameters<Pool['connect']>))
      }
      const member = Reflect.get(target, property, target)
      return typeof member === 'function' ? member.bind(target) : member
    },
  }) as Pool
  dbGlobal.__movyPgPool = pool
  dbGlobal.__movyPgProxy = guardedPool
  dbGlobal.__movyPgConnectionString = value
  dbGlobal.__movyPgSchema = schema
  dbGlobal.__movyPgNetwork = network
  return guardedPool
}

export async function closeDb(): Promise<void> {
  if (dbGlobal.__movyPgPool) await dbGlobal.__movyPgPool.end()
  delete dbGlobal.__movyPgPool
  delete dbGlobal.__movyPgProxy
  delete dbGlobal.__movyPgConnectionString
  delete dbGlobal.__movyPgSchema
  delete dbGlobal.__movyPgNetwork
  delete dbGlobal.__movyPgNetworkBinding
}

function safeNumber(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`Database ${field} is outside the safe integer range`)
  return number
}

function query<T extends DbRow = DbRow>(
  target: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return target.query<T>(text, values as never)
}

async function withWorkerWriteGuard<T>(
  lock: WorkerLockToken | undefined,
  write: (target: Queryable) => Promise<T>,
): Promise<T> {
  if (!lock) return write(getDb())

  const client = await getDb().connect()
  try {
    await client.query('BEGIN')
    const active = await query(client, `
      SELECT 1 AS active FROM worker_locks
      WHERE lock_name = $1 AND owner_token = $2 AND fencing_token = $3 AND lease_expires_at > $4
      FOR UPDATE
    `, [lock.lockName, lock.ownerToken, lock.fencingToken, Date.now()])
    if (active.rowCount !== 1) throw new Error('Worker lock lease is no longer active')
    const result = await write(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The connection may already have rolled back after a database error.
    }
    throw error
  } finally {
    client.release()
  }
}

export interface EnrollmentRecord {
  chainId: number
  wallet: string
  destination: string
  maxRoundup6: string
  dailyCap6: string
  configEpoch: number
  status: 'active' | 'paused' | 'revoked'
  enrolledAt: string
  updatedAt: string
}

export interface ObservedPaymentRecord {
  paymentKey: string
  chainId: number
  txHash: string
  logIndex: number
  blockNumber: number
  payer: string
  recipient: string
  amount6: string
  roundup6: string
  isEligible: boolean
  exclusionReason?: string
  createdAt: string
}

export interface RoundupJobRecord {
  jobId?: number
  paymentKey: string
  chainId: number
  wallet: string
  destination: string
  roundupAmount6: string
  configEpoch: number
  status: 'pending' | 'submitting' | 'submitted' | 'confirmed' | 'skipped' | 'failed'
  skipReason?: string
  relayerTxHash?: string
  attempts: number
  lastError?: string
  createdAt: string
  updatedAt: string
  paymentTxHash?: string
  canonicalLogIndex?: number
  paymentAmount6?: string
  paymentRecipient?: string
  paymentBlockNumber?: number
  paymentIsEligible?: number | boolean
}

export interface EnrollmentHistoryState {
  chainId: number
  wallet: string
  blockNumber: number
  logIndex: number
  destination: string
  maxRoundup6: string
  dailyCap6: string
  configEpoch: number
  status: 'active' | 'paused' | 'revoked'
}

export interface PaymentHistoryReplay {
  chainId: number
  nextBlock: number
  targetBlock: number
}

export interface WalletActivityItem {
  paymentKey: string
  txHash: string
  logIndex: number
  blockNumber: number
  recipient: string
  amount6: string
  roundup6: string
  isEligible: boolean
  exclusionReason?: string
  roundupStatus: 'saved' | 'pending' | 'skipped' | 'failed' | 'whole_dollar'
  skipReason?: string
  relayerTxHash?: string
  createdAt: string
}

export interface WorkerLockToken {
  lockName: string
  ownerToken: string
  fencingToken: number
}

export interface ConfirmedRoundupSummary {
  /** Exact integer base units of confirmed, eligible round-ups for this wallet. */
  confirmedRoundups6: string
  /** Exact count of confirmed, eligible round-ups for this wallet. */
  confirmedRoundupCount: string
  /** Exact confirmed total for payments MOVY recorded since the supplied ISO timestamp. */
  recordedLast7DaysRoundups6: string
}

function enrollmentFromRow(row: DbRow | undefined): EnrollmentRecord | null {
  if (!row) return null
  return {
    chainId: safeNumber(row.chainId, 'chainId'),
    wallet: String(row.wallet),
    destination: String(row.destination),
    maxRoundup6: String(row.maxRoundup6),
    dailyCap6: String(row.dailyCap6),
    configEpoch: safeNumber(row.configEpoch, 'configEpoch'),
    status: String(row.status) as EnrollmentRecord['status'],
    enrolledAt: String(row.enrolledAt),
    updatedAt: String(row.updatedAt),
  }
}

function historyFromRow(row: DbRow | undefined): EnrollmentHistoryState | null {
  if (!row) return null
  return {
    chainId: safeNumber(row.chainId, 'chainId'),
    wallet: String(row.wallet),
    blockNumber: safeNumber(row.blockNumber, 'blockNumber'),
    logIndex: safeNumber(row.logIndex, 'logIndex'),
    destination: String(row.destination),
    maxRoundup6: String(row.maxRoundup6),
    dailyCap6: String(row.dailyCap6),
    configEpoch: safeNumber(row.configEpoch, 'configEpoch'),
    status: String(row.status) as EnrollmentHistoryState['status'],
  }
}

function roundupJobFromRow(row: DbRow): RoundupJobRecord {
  return {
    jobId: safeNumber(row.jobId, 'jobId'),
    paymentKey: String(row.paymentKey),
    chainId: safeNumber(row.chainId, 'chainId'),
    wallet: String(row.wallet),
    destination: String(row.destination),
    roundupAmount6: String(row.roundupAmount6),
    configEpoch: safeNumber(row.configEpoch, 'configEpoch'),
    status: String(row.status) as RoundupJobRecord['status'],
    skipReason: row.skipReason == null ? undefined : String(row.skipReason),
    relayerTxHash: row.relayerTxHash == null ? undefined : String(row.relayerTxHash),
    attempts: safeNumber(row.attempts, 'attempts'),
    lastError: row.lastError == null ? undefined : String(row.lastError),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    paymentTxHash: row.paymentTxHash == null ? undefined : String(row.paymentTxHash),
    canonicalLogIndex: row.canonicalLogIndex == null ? undefined : safeNumber(row.canonicalLogIndex, 'canonicalLogIndex'),
    paymentAmount6: row.paymentAmount6 == null ? undefined : String(row.paymentAmount6),
    paymentRecipient: row.paymentRecipient == null ? undefined : String(row.paymentRecipient),
    paymentBlockNumber: row.paymentBlockNumber == null ? undefined : safeNumber(row.paymentBlockNumber, 'paymentBlockNumber'),
    paymentIsEligible: row.paymentIsEligible == null ? undefined : row.paymentIsEligible === true,
  }
}

const CURSOR_SELECT: Record<string, string> = {
  payment: 'chain_cursor',
  enrollmentEvent: 'enrollment_event_cursor',
  enrollmentHistory: 'enrollment_history_cursor',
}

async function getCursorFrom(table: string, chainId: number): Promise<number | null> {
  const tableName = Object.values(CURSOR_SELECT).includes(table) ? table : null
  if (!tableName) throw new Error('Invalid cursor table')
  const result = await query(getDb(), `SELECT last_processed_block FROM ${tableName} WHERE chain_id = $1`, [chainId])
  return result.rows[0] ? safeNumber(result.rows[0].last_processed_block, 'last_processed_block') : null
}

async function setCursorIn(table: string, chainId: number, blockNumber: number, lock?: WorkerLockToken): Promise<void> {
  const tableName = Object.values(CURSOR_SELECT).includes(table) ? table : null
  if (!tableName) throw new Error('Invalid cursor table')
  await withWorkerWriteGuard(lock, (target) => query(target, `
    INSERT INTO ${tableName} (chain_id, last_processed_block, updated_at)
    VALUES ($1, $2, $3)
    ON CONFLICT(chain_id) DO UPDATE SET
      last_processed_block = GREATEST(${tableName}.last_processed_block, EXCLUDED.last_processed_block),
      updated_at = CASE
        WHEN EXCLUDED.last_processed_block > ${tableName}.last_processed_block THEN EXCLUDED.updated_at
        ELSE ${tableName}.updated_at
      END
  `, [chainId, blockNumber, new Date().toISOString()]).then(() => undefined))
}

export const getCursor = (chainId: number) => getCursorFrom(CURSOR_SELECT.payment, chainId)
export const setCursor = (chainId: number, blockNumber: number, lock?: WorkerLockToken) =>
  setCursorIn(CURSOR_SELECT.payment, chainId, blockNumber, lock)
export const getEnrollmentEventCursor = (chainId: number) => getCursorFrom(CURSOR_SELECT.enrollmentEvent, chainId)
export const setEnrollmentEventCursor = (chainId: number, blockNumber: number, lock?: WorkerLockToken) =>
  setCursorIn(CURSOR_SELECT.enrollmentEvent, chainId, blockNumber, lock)
export const getEnrollmentHistoryCursor = (chainId: number) => getCursorFrom(CURSOR_SELECT.enrollmentHistory, chainId)
export const setEnrollmentHistoryCursor = (chainId: number, blockNumber: number, lock?: WorkerLockToken) =>
  setCursorIn(CURSOR_SELECT.enrollmentHistory, chainId, blockNumber, lock)

export async function upsertEnrollmentHistoryState(state: EnrollmentHistoryState, lock?: WorkerLockToken): Promise<void> {
  await withWorkerWriteGuard(lock, (target) => query(target, `
    INSERT INTO enrollment_state_history (
      chain_id, wallet, block_number, log_index, destination,
      max_roundup_6, daily_cap_6, config_epoch, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT(chain_id, wallet, block_number, log_index) DO UPDATE SET
      destination = EXCLUDED.destination,
      max_roundup_6 = EXCLUDED.max_roundup_6,
      daily_cap_6 = EXCLUDED.daily_cap_6,
      config_epoch = EXCLUDED.config_epoch,
      status = EXCLUDED.status
  `, [state.chainId, state.wallet.toLowerCase(), state.blockNumber, state.logIndex, state.destination,
    state.maxRoundup6, state.dailyCap6, state.configEpoch, state.status]).then(() => undefined))
}

const HISTORY_COLUMNS = `
  chain_id AS "chainId", wallet, block_number AS "blockNumber", log_index AS "logIndex",
  destination, max_roundup_6 AS "maxRoundup6", daily_cap_6 AS "dailyCap6",
  config_epoch AS "configEpoch", status
`

export async function getLatestEnrollmentHistoryState(chainId: number, wallet: string): Promise<EnrollmentHistoryState | null> {
  const result = await query(getDb(), `
    SELECT ${HISTORY_COLUMNS} FROM enrollment_state_history
    WHERE chain_id = $1 AND lower(wallet) = lower($2)
    ORDER BY block_number DESC, log_index DESC LIMIT 1
  `, [chainId, wallet])
  return historyFromRow(result.rows[0])
}

export async function getEnrollmentHistoryAtPosition(
  chainId: number,
  wallet: string,
  blockNumber: number,
  logIndex: number,
): Promise<EnrollmentHistoryState | null> {
  const result = await query(getDb(), `
    SELECT ${HISTORY_COLUMNS} FROM enrollment_state_history
    WHERE chain_id = $1 AND lower(wallet) = lower($2)
      AND (block_number < $3 OR (block_number = $3 AND log_index < $4))
    ORDER BY block_number DESC, log_index DESC LIMIT 1
  `, [chainId, wallet, blockNumber, logIndex])
  return historyFromRow(result.rows[0])
}

export async function getEnrollmentHistoryWallets(chainId: number): Promise<string[]> {
  const result = await query(getDb(), `
    SELECT DISTINCT lower(wallet) AS wallet FROM enrollment_state_history WHERE chain_id = $1
  `, [chainId])
  return result.rows.map((row) => String(row.wallet))
}

export async function ensurePaymentHistoryReplay(chainId: number, deployBlock: number, lock?: WorkerLockToken): Promise<void> {
  await withWorkerWriteGuard(lock, (target) => query(target, `
    INSERT INTO payment_history_replay (chain_id, next_block, target_block, completed)
    SELECT $1, $2::bigint,
      COALESCE((SELECT last_processed_block FROM chain_cursor WHERE chain_id = $1), $2::bigint - 1),
      COALESCE((SELECT last_processed_block FROM chain_cursor WHERE chain_id = $1), $2::bigint - 1) < $2::bigint
    ON CONFLICT(chain_id) DO NOTHING
  `, [chainId, deployBlock]).then(() => undefined))
}

export async function getPaymentHistoryReplay(chainId: number): Promise<PaymentHistoryReplay | null> {
  const result = await query(getDb(), `
    SELECT chain_id AS "chainId", next_block AS "nextBlock", target_block AS "targetBlock"
    FROM payment_history_replay WHERE chain_id = $1 AND completed = false
  `, [chainId])
  const row = result.rows[0]
  return row ? {
    chainId: safeNumber(row.chainId, 'chainId'),
    nextBlock: safeNumber(row.nextBlock, 'nextBlock'),
    targetBlock: safeNumber(row.targetBlock, 'targetBlock'),
  } : null
}

export async function advancePaymentHistoryReplay(chainId: number, nextBlock: number, lock?: WorkerLockToken): Promise<void> {
  await withWorkerWriteGuard(lock, (target) => query(target, `
    UPDATE payment_history_replay
    SET next_block = GREATEST(next_block, $2),
        completed = GREATEST(next_block, $2) > target_block
    WHERE chain_id = $1 AND completed = false
  `, [chainId, nextBlock]).then(() => undefined))
}

export async function tryAcquireWorkerLock(
  lockName: string,
  leaseDurationMs: number,
  now = Date.now(),
): Promise<WorkerLockToken | null> {
  if (!lockName || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error('Worker lock name and positive lease duration are required')
  }
  const ownerToken = randomUUID()
  const result = await query(getDb(), `
    INSERT INTO worker_locks (lock_name, owner_token, lease_expires_at, fencing_token)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT(lock_name) DO UPDATE SET
      owner_token = EXCLUDED.owner_token,
      lease_expires_at = EXCLUDED.lease_expires_at,
      fencing_token = worker_locks.fencing_token + 1
    WHERE worker_locks.lease_expires_at <= $4
    RETURNING fencing_token
  `, [lockName, ownerToken, now + leaseDurationMs, now])
  const row = result.rows[0]
  return row ? { lockName, ownerToken, fencingToken: safeNumber(row.fencing_token, 'fencing_token') } : null
}

export async function renewWorkerLock(lock: WorkerLockToken, leaseDurationMs: number, now = Date.now()): Promise<boolean> {
  const result = await query(getDb(), `
    UPDATE worker_locks SET lease_expires_at = $1
    WHERE lock_name = $2 AND owner_token = $3 AND fencing_token = $4 AND lease_expires_at > $5
  `, [now + leaseDurationMs, lock.lockName, lock.ownerToken, lock.fencingToken, now])
  return result.rowCount === 1
}

export async function workerLockIsActive(lock: WorkerLockToken, now = Date.now()): Promise<boolean> {
  const result = await query(getDb(), `
    SELECT 1 AS active FROM worker_locks
    WHERE lock_name = $1 AND owner_token = $2 AND fencing_token = $3 AND lease_expires_at > $4
  `, [lock.lockName, lock.ownerToken, lock.fencingToken, now])
  return result.rowCount === 1
}

export async function releaseWorkerLock(lock: WorkerLockToken): Promise<void> {
  await query(getDb(), `
    UPDATE worker_locks SET lease_expires_at = 0
    WHERE lock_name = $1 AND owner_token = $2 AND fencing_token = $3
  `, [lock.lockName, lock.ownerToken, lock.fencingToken])
}

let rateLimitCleanupCounter = 0

export async function consumeRateLimit(
  rateKey: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  if (!rateKey || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error('Rate limit key, positive limit, and positive window are required')
  }
  rateLimitCleanupCounter++
  if (rateLimitCleanupCounter % 128 === 0) {
    await query(getDb(), 'DELETE FROM api_rate_limits WHERE window_started_at < $1', [now - Math.max(windowMs * 2, 600_000)])
  }
  const windowStart = now - windowMs
  const result = await query(getDb(), `
    INSERT INTO api_rate_limits (rate_key, window_started_at, request_count)
    VALUES ($1, $2, 1)
    ON CONFLICT(rate_key) DO UPDATE SET
      window_started_at = CASE
        WHEN api_rate_limits.window_started_at <= $3 THEN EXCLUDED.window_started_at
        ELSE api_rate_limits.window_started_at
      END,
      request_count = CASE
        WHEN api_rate_limits.window_started_at <= $3 THEN 1
        ELSE api_rate_limits.request_count + 1
      END
    RETURNING window_started_at, request_count
  `, [rateKey, now, windowStart])
  const row = result.rows[0]
  const windowStartedAt = safeNumber(row.window_started_at, 'window_started_at')
  const requestCount = safeNumber(row.request_count, 'request_count')
  return {
    allowed: requestCount <= limit,
    remaining: Math.max(0, limit - requestCount),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1000)),
  }
}

export async function upsertEnrollment(rec: EnrollmentRecord, lock?: WorkerLockToken): Promise<void> {
  await withWorkerWriteGuard(lock, (target) => query(target, `
    INSERT INTO enrollments (
      chain_id, wallet, destination, max_roundup_6, daily_cap_6, config_epoch, status, enrolled_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT(chain_id, wallet) DO UPDATE SET
      destination = EXCLUDED.destination,
      max_roundup_6 = EXCLUDED.max_roundup_6,
      daily_cap_6 = EXCLUDED.daily_cap_6,
      config_epoch = EXCLUDED.config_epoch,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
  `, [rec.chainId, rec.wallet.toLowerCase(), rec.destination, rec.maxRoundup6, rec.dailyCap6,
    rec.configEpoch, rec.status, rec.enrolledAt, rec.updatedAt]).then(() => undefined))
}

export async function getEnrollment(chainId: number, wallet: string): Promise<EnrollmentRecord | null> {
  const result = await query(getDb(), `
    SELECT chain_id AS "chainId", wallet, destination, max_roundup_6 AS "maxRoundup6",
      daily_cap_6 AS "dailyCap6", config_epoch AS "configEpoch", status,
      enrolled_at AS "enrolledAt", updated_at AS "updatedAt"
    FROM enrollments WHERE chain_id = $1 AND lower(wallet) = lower($2)
  `, [chainId, wallet])
  return enrollmentFromRow(result.rows[0])
}

export async function getAllActiveEnrollments(chainId: number): Promise<EnrollmentRecord[]> {
  const result = await query(getDb(), `
    SELECT chain_id AS "chainId", wallet, destination, max_roundup_6 AS "maxRoundup6",
      daily_cap_6 AS "dailyCap6", config_epoch AS "configEpoch", status,
      enrolled_at AS "enrolledAt", updated_at AS "updatedAt"
    FROM enrollments WHERE chain_id = $1 AND status = 'active'
  `, [chainId])
  return result.rows.map((row) => enrollmentFromRow(row)!)
}

export async function saveObservedPayment(payment: ObservedPaymentRecord, lock?: WorkerLockToken): Promise<boolean> {
  const result = await withWorkerWriteGuard(lock, (target) => query(target, `
    INSERT INTO observed_payments (
      payment_key, chain_id, tx_hash, log_index, block_number, payer, recipient,
      amount_6, roundup_6, is_eligible, exclusion_reason, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT(payment_key) DO UPDATE SET
      tx_hash = EXCLUDED.tx_hash,
      log_index = EXCLUDED.log_index,
      block_number = EXCLUDED.block_number,
      payer = EXCLUDED.payer,
      recipient = EXCLUDED.recipient,
      amount_6 = EXCLUDED.amount_6,
      roundup_6 = EXCLUDED.roundup_6,
      is_eligible = EXCLUDED.is_eligible,
      exclusion_reason = EXCLUDED.exclusion_reason,
      created_at = EXCLUDED.created_at
    WHERE observed_payments.exclusion_reason = 'tx_inspection_failed'
    RETURNING payment_key
  `, [payment.paymentKey, payment.chainId, payment.txHash, payment.logIndex, payment.blockNumber,
    payment.payer.toLowerCase(), payment.recipient, payment.amount6, payment.roundup6,
    payment.isEligible, payment.exclusionReason ?? null, payment.createdAt]))
  return result.rowCount === 1
}

export async function createRoundupJob(job: RoundupJobRecord, lock?: WorkerLockToken): Promise<boolean> {
  const result = await withWorkerWriteGuard(lock, (target) => query(target, `
    INSERT INTO roundup_jobs (
      payment_key, chain_id, wallet, destination, roundup_amount_6,
      config_epoch, status, skip_reason, attempts, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT(payment_key) DO NOTHING
    RETURNING job_id
  `, [job.paymentKey, job.chainId, job.wallet.toLowerCase(), job.destination, job.roundupAmount6,
    job.configEpoch, job.status, job.skipReason ?? null, job.attempts, job.createdAt, job.updatedAt]))
  return result.rowCount === 1
}

export async function getRoundupJobByPaymentKey(paymentKey: string): Promise<Pick<RoundupJobRecord, 'jobId' | 'status'> | null> {
  const result = await query(getDb(), `
    SELECT job_id AS "jobId", status FROM roundup_jobs WHERE payment_key = $1
  `, [paymentKey])
  const row = result.rows[0]
  return row ? { jobId: safeNumber(row.jobId, 'jobId'), status: String(row.status) as RoundupJobRecord['status'] } : null
}

export async function updatePendingRoundupJobFromHistory(
  jobId: number,
  details: { destination: string; roundupAmount6: string; configEpoch: number },
  lock?: WorkerLockToken,
): Promise<void> {
  await withWorkerWriteGuard(lock, (target) => query(target, `
    UPDATE roundup_jobs SET destination = $1, roundup_amount_6 = $2, config_epoch = $3, updated_at = $4
    WHERE job_id = $5 AND status = 'pending'
  `, [details.destination, details.roundupAmount6, details.configEpoch, new Date().toISOString(), jobId]).then(() => undefined))
}

const ROUNDUP_JOB_SELECT = `
  SELECT j.job_id AS "jobId", j.payment_key AS "paymentKey", j.chain_id AS "chainId",
    j.wallet, j.destination, j.roundup_amount_6 AS "roundupAmount6",
    j.config_epoch AS "configEpoch", j.status, j.skip_reason AS "skipReason",
    j.relayer_tx_hash AS "relayerTxHash", j.attempts, j.last_error AS "lastError",
    j.created_at AS "createdAt", j.updated_at AS "updatedAt",
    p.tx_hash AS "paymentTxHash", p.log_index AS "canonicalLogIndex",
    p.amount_6 AS "paymentAmount6", p.recipient AS "paymentRecipient",
    p.block_number AS "paymentBlockNumber",
    p.is_eligible AS "paymentIsEligible"
  FROM roundup_jobs j
  LEFT JOIN observed_payments p ON j.payment_key = p.payment_key
`

export async function getPendingJobs(chainId: number, limit = 20): Promise<RoundupJobRecord[]> {
  const result = await query(getDb(), `${ROUNDUP_JOB_SELECT}
    WHERE j.chain_id = $1 AND j.status = 'pending'
    ORDER BY j.job_id ASC LIMIT $2
  `, [chainId, limit])
  return result.rows.map(roundupJobFromRow)
}

export async function getSubmissionRecoveryJobs(chainId: number, limit = 20): Promise<RoundupJobRecord[]> {
  const result = await query(getDb(), `${ROUNDUP_JOB_SELECT}
    WHERE j.chain_id = $1 AND j.status IN ('submitting', 'submitted')
    ORDER BY j.job_id ASC LIMIT $2
  `, [chainId, limit])
  return result.rows.map(roundupJobFromRow)
}

export async function updateJobStatus(
  jobId: number,
  status: 'submitting' | 'submitted' | 'confirmed' | 'skipped' | 'failed',
  options?: { relayerTxHash?: string; skipReason?: string; error?: string },
  lock?: WorkerLockToken,
): Promise<void> {
  await withWorkerWriteGuard(lock, (target) => query(target, `
    UPDATE roundup_jobs SET status = $1,
      relayer_tx_hash = COALESCE($2::text, relayer_tx_hash),
      skip_reason = COALESCE($3::text, skip_reason),
      last_error = $4,
      attempts = attempts + 1,
      updated_at = $5
    WHERE job_id = $6
  `, [status, options?.relayerTxHash ?? null, options?.skipReason ?? null, options?.error ?? null,
    new Date().toISOString(), jobId]).then(() => undefined))
}

export async function getActivityForWallet(chainId: number, wallet: string): Promise<WalletActivityItem[]> {
  const result = await query(getDb(), `
    SELECT p.payment_key AS "paymentKey", p.tx_hash AS "txHash", p.log_index AS "logIndex",
      p.block_number AS "blockNumber", p.recipient, p.amount_6 AS "amount6", p.roundup_6 AS "roundup6",
      p.is_eligible AS "isEligible", p.exclusion_reason AS "exclusionReason", p.created_at AS "createdAt",
      j.status AS "jobStatus", j.skip_reason AS "jobSkipReason", j.relayer_tx_hash AS "relayerTxHash"
    FROM observed_payments p
    LEFT JOIN roundup_jobs j ON p.payment_key = j.payment_key
    WHERE p.chain_id = $1 AND lower(p.payer) = lower($2)
      AND p.exclusion_reason IS DISTINCT FROM 'savings_destination'
    ORDER BY p.block_number DESC, p.log_index DESC
    LIMIT 100
  `, [chainId, wallet])

  return result.rows.map((row) => {
    const roundup6 = BigInt(String(row.roundup6))
    const jobStatus = row.jobStatus == null ? null : String(row.jobStatus)
    let roundupStatus: WalletActivityItem['roundupStatus'] = 'skipped'
    if (roundup6 === 0n) roundupStatus = 'whole_dollar'
    else if (jobStatus === 'confirmed') roundupStatus = 'saved'
    else if (jobStatus === 'pending' || jobStatus === 'submitting' || jobStatus === 'submitted') roundupStatus = 'pending'
    else if (jobStatus === 'failed') roundupStatus = 'failed'
    else if (jobStatus === 'skipped') roundupStatus = 'skipped'
    return {
      paymentKey: String(row.paymentKey),
      txHash: String(row.txHash),
      logIndex: safeNumber(row.logIndex, 'logIndex'),
      blockNumber: safeNumber(row.blockNumber, 'blockNumber'),
      recipient: String(row.recipient),
      amount6: String(row.amount6),
      roundup6: String(row.roundup6),
      isEligible: row.isEligible === true,
      exclusionReason: row.exclusionReason == null ? undefined : String(row.exclusionReason),
      roundupStatus,
      skipReason: row.jobSkipReason == null ? undefined : String(row.jobSkipReason),
      relayerTxHash: row.relayerTxHash == null ? undefined : String(row.relayerTxHash),
      createdAt: String(row.createdAt),
    }
  })
}

export async function getConfirmedRoundupSummaryForWallet(
  chainId: number,
  wallet: string,
  sinceIso: string,
): Promise<ConfirmedRoundupSummary> {
  const result = await query(getDb(), `
    SELECT j.roundup_amount_6 AS "roundupAmount6", p.created_at AS "createdAt"
    FROM roundup_jobs j
    INNER JOIN observed_payments p ON p.payment_key = j.payment_key AND p.chain_id = j.chain_id
    WHERE j.chain_id = $1 AND lower(j.wallet) = lower($2) AND p.chain_id = $1
      AND lower(p.payer) = lower($2) AND p.is_eligible = true AND j.status = 'confirmed'
  `, [chainId, wallet])

  let confirmedRoundups6 = 0n
  let confirmedRoundupCount = 0n
  let recordedLast7DaysRoundups6 = 0n
  for (const row of result.rows) {
    const amount6 = BigInt(String(row.roundupAmount6))
    if (amount6 <= 0n) continue
    confirmedRoundups6 += amount6
    confirmedRoundupCount += 1n
    if (String(row.createdAt) >= sinceIso) recordedLast7DaysRoundups6 += amount6
  }
  return {
    confirmedRoundups6: confirmedRoundups6.toString(),
    confirmedRoundupCount: confirmedRoundupCount.toString(),
    recordedLast7DaysRoundups6: recordedLast7DaysRoundups6.toString(),
  }
}

export async function getStats(chainId: number) {
  const db = getDb()
  const [savedResult, usersResult] = await Promise.all([
    query(db, `
      SELECT COALESCE(SUM(roundup_amount_6::numeric), 0)::text AS "totalSaved",
        COUNT(*)::text AS "totalRoundups"
      FROM roundup_jobs WHERE chain_id = $1 AND status = 'confirmed'
    `, [chainId]),
    query(db, `SELECT COUNT(*)::text AS "activeUsers" FROM enrollments WHERE chain_id = $1 AND status = 'active'`, [chainId]),
  ])
  const saved = savedResult.rows[0]
  const users = usersResult.rows[0]
  return {
    totalSaved6: BigInt(String(saved.totalSaved)),
    totalRoundups: safeNumber(saved.totalRoundups, 'totalRoundups'),
    activeUsers: safeNumber(users.activeUsers, 'activeUsers'),
  }
}

export async function getDatabaseHealth(): Promise<{ ready: boolean; version: number | null }> {
  const result = await query(getDb(), `SELECT version,
    to_regclass('wallet_profiles') IS NOT NULL AS profiles_ready,
    to_regclass('wallet_profile_challenges') IS NOT NULL AS challenges_ready
    FROM schema_migrations ORDER BY version DESC LIMIT 1`)
  const version = result.rows[0] ? safeNumber(result.rows[0].version, 'schema version') : null
  return { ready: version !== null && version >= 3 && result.rows[0]?.profiles_ready === true && result.rows[0]?.challenges_ready === true, version }
}

export async function getOperationalSignals(chainId: number): Promise<{
  database: { ready: boolean; version: number | null }
  cursors: { payments: number | null; enrollmentHistory: number | null; enrollmentEvents: number | null }
  replay: PaymentHistoryReplay | null
  workerLeaseActive: boolean
  jobs: Record<string, { count: number; oldestCreatedAt: string | null }>
}> {
  assertConfiguredChainId(chainId)
  const workerLockName = `arc-${getNetworkForChainId(chainId)}-worker`
  const [database, payments, enrollmentHistory, enrollmentEvents, replay, lock, jobs] = await Promise.all([
    getDatabaseHealth(),
    getCursor(chainId),
    getEnrollmentHistoryCursor(chainId),
    getEnrollmentEventCursor(chainId),
    getPaymentHistoryReplay(chainId),
    query(getDb(), 'SELECT lease_expires_at FROM worker_locks WHERE lock_name = $1', [workerLockName]),
    query(getDb(), `
      SELECT status, COUNT(*)::int AS count, MIN(created_at) AS oldest_created_at
      FROM roundup_jobs WHERE chain_id = $1 GROUP BY status
    `, [chainId]),
  ])
  const jobSignals: Record<string, { count: number; oldestCreatedAt: string | null }> = {}
  for (const row of jobs.rows) {
    jobSignals[String(row.status)] = {
      count: safeNumber(row.count, 'job count'),
      oldestCreatedAt: row.oldest_created_at == null ? null : String(row.oldest_created_at),
    }
  }
  return {
    database,
    cursors: { payments, enrollmentHistory, enrollmentEvents },
    replay,
    workerLeaseActive: lock.rows[0] ? safeNumber(lock.rows[0].lease_expires_at, 'lease expiry') > Date.now() : false,
    jobs: jobSignals,
  }
}
