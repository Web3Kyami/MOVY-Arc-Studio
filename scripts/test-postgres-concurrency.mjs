import assert from 'node:assert/strict'
import {
  createRoundupJob,
  getActivityForWallet,
  getCursor,
  getEnrollment,
  getLatestEnrollmentHistoryState,
  getPendingJobs,
  consumeRateLimit,
  releaseWorkerLock,
  saveObservedPayment,
  setCursor,
  tryAcquireWorkerLock,
  updateJobStatus,
  upsertEnrollment,
  upsertEnrollmentHistoryState,
  workerLockIsActive,
} from '../src/lib/server/db.ts'

const chainId = 5042002
const wallet = '0x00000000000000000000000000000000000000a1'
const destination = '0x00000000000000000000000000000000000000b2'
const upperWallet = `0x${wallet.slice(2).toUpperCase()}`
const now = Date.now()

await upsertEnrollment({
  chainId,
  wallet: upperWallet,
  destination,
  maxRoundup6: '1000000',
  dailyCap6: '5000000',
  configEpoch: 1,
  status: 'active',
  enrolledAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
})
await upsertEnrollment({
  chainId,
  wallet,
  destination,
  maxRoundup6: '2000000',
  dailyCap6: '6000000',
  configEpoch: 2,
  status: 'active',
  enrolledAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
})
assert.equal((await getEnrollment(chainId, upperWallet)).maxRoundup6, '2000000',
  'enrollment identity remains case-insensitive after PostgreSQL migration')
await upsertEnrollmentHistoryState({
  chainId,
  wallet: upperWallet,
  blockNumber: 120,
  logIndex: 0,
  destination,
  maxRoundup6: '2000000',
  dailyCap6: '6000000',
  configEpoch: 2,
  status: 'active',
})
await upsertEnrollmentHistoryState({
  chainId,
  wallet,
  blockNumber: 120,
  logIndex: 0,
  destination,
  maxRoundup6: '3000000',
  dailyCap6: '7000000',
  configEpoch: 3,
  status: 'active',
})
assert.equal((await getLatestEnrollmentHistoryState(chainId, upperWallet)).maxRoundup6, '3000000',
  'enrollment history remains case-insensitive and idempotent after PostgreSQL migration')

const lockResults = await Promise.all(Array.from({ length: 16 }, () => tryAcquireWorkerLock('concurrency-lock', 10_000)))
const winners = lockResults.filter(Boolean)
assert.equal(winners.length, 1, 'only one concurrent worker can acquire the lease')
const firstLock = winners[0]
assert.equal(await workerLockIsActive(firstLock), true)

const paymentKey = `concurrency-payment-${crypto.randomUUID()}`
const payment = {
  paymentKey,
  chainId,
  txHash: `0x${'1'.repeat(64)}`,
  logIndex: 1,
  blockNumber: 123,
  payer: wallet,
  recipient: destination,
  amount6: '5000000',
  roundup6: '500000',
  isEligible: true,
  createdAt: new Date(now).toISOString(),
}
const paymentInsertions = await Promise.all(Array.from({ length: 12 }, () => saveObservedPayment(payment)))
assert.equal(paymentInsertions.filter(Boolean).length, 1, 'payment replay remains idempotent under concurrent writes')
const rateLimitResults = await Promise.all(Array.from({ length: 16 }, () =>
  consumeRateLimit(`concurrency-${paymentKey}`, 5, 60_000, now)))
assert.equal(rateLimitResults.filter((result) => result.allowed).length, 5,
  'concurrent requests cannot exceed the durable database rate limit')

const job = {
  paymentKey,
  chainId,
  wallet,
  destination,
  roundupAmount6: '500000',
  configEpoch: 1,
  status: 'pending',
  attempts: 0,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
}
const jobInsertions = await Promise.all(Array.from({ length: 12 }, () => createRoundupJob(job)))
assert.equal(jobInsertions.filter(Boolean).length, 1, 'duplicate relayer jobs cannot be created concurrently')
assert.equal((await getPendingJobs(chainId)).length, 1)

await setCursor(chainId, 300, firstLock)
await setCursor(chainId, 250, firstLock)
assert.equal(await getCursor(chainId), 300, 'payment cursor updates remain monotonic')
await releaseWorkerLock(firstLock)

const oldLock = await tryAcquireWorkerLock('fencing-lock', 1)
assert.ok(oldLock)
await new Promise((resolve) => setTimeout(resolve, 5))
const replacement = await tryAcquireWorkerLock('fencing-lock', 10_000)
assert.ok(replacement)
assert.ok(replacement.fencingToken > oldLock.fencingToken, 'expired leases issue a higher fencing token')
await assert.rejects(() => setCursor(chainId, 400, oldLock), /lease is no longer active/,
  'a stale fencing token cannot write after lease recovery')
await setCursor(chainId, 350, replacement)
assert.equal(await getCursor(chainId), 350)
await releaseWorkerLock(replacement)

await updateJobStatus((await getPendingJobs(chainId))[0].jobId, 'confirmed', { relayerTxHash: `0x${'2'.repeat(64)}` })
const activity = await getActivityForWallet(chainId, wallet)
assert.equal(activity.length, 1)
assert.equal(activity[0].roundupStatus, 'saved')
console.log('PostgreSQL concurrency, idempotency, cursor monotonicity, and fencing regressions passed')
