import { upsertEnrollment, saveObservedPayment, createRoundupJob, getPendingJobs, updateJobStatus, getActivityForWallet } from '../src/lib/server/db.ts'
import { calculateRoundup6, formatUsdc6 } from '../src/lib/money.ts'
import { computePaymentKey } from '../src/lib/server/observer.ts'
import { strict as assert } from 'node:assert'

console.log('Testing Observer, Relayer & Storage logic...')

// 1. Test money helpers
assert.equal(calculateRoundup6(170_000n), 830_000n, '$0.17 must round up to $0.83')
assert.equal(calculateRoundup6(2_630_000n), 370_000n, '$2.63 must round up to $0.37')
assert.equal(calculateRoundup6(10_000n), 990_000n, '$0.01 must round up to $0.99')
assert.equal(calculateRoundup6(990_000n), 10_000n, '$0.99 must round up to $0.01')
assert.equal(calculateRoundup6(1_000_000n), 0n, '$1.00 exact must have $0.00 roundup')
assert.equal(calculateRoundup6(5_000_000n), 0n, '$5.00 exact must have $0.00 roundup')
assert.equal(formatUsdc6(830_000n), '$0.83')
assert.equal(formatUsdc6(170_000n), '$0.17')
console.log('✔ Money calculation assertions passed')

import crypto from 'node:crypto'

// 2. Test DB enrollment
const chainId = 5042002
const testWallet = '0x' + crypto.randomBytes(20).toString('hex')
const testDest = '0x' + crypto.randomBytes(20).toString('hex')
await upsertEnrollment({
  chainId,
  wallet: testWallet,
  destination: testDest,
  maxRoundup6: '1000000',
  dailyCap6: '5000000',
  configEpoch: 1,
  status: 'active',
  enrolledAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})
console.log('✔ Enrollment saved to database')

// 3. Test payment key computation
const testTxHash = '0x' + crypto.randomBytes(32).toString('hex')
const paymentKey = computePaymentKey(chainId, testTxHash, 0, testWallet)
assert(paymentKey.startsWith('0x'), 'Payment key must be a valid hex hash')
console.log('✔ Deterministic payment key computed:', paymentKey)

// 4. Test duplicate prevention
const paymentRecord = {
  paymentKey,
  chainId,
  txHash: testTxHash,
  logIndex: 0,
  blockNumber: 12345,
  payer: testWallet,
  recipient: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  amount6: '170000',
  roundup6: '830000',
  isEligible: true,
  createdAt: new Date().toISOString(),
}

const firstInsert = await saveObservedPayment(paymentRecord)
assert.equal(firstInsert, true, 'First insert must succeed')

const duplicateInsert = await saveObservedPayment(paymentRecord)
assert.equal(duplicateInsert, false, 'Duplicate insert must be safely rejected (idempotent)')
console.log('✔ Ingestion idempotency verified: duplicates are rejected')

// 5. Test roundup job queue
const jobRecord = {
  paymentKey,
  chainId,
  wallet: testWallet,
  destination: testDest,
  roundupAmount6: '830000',
  configEpoch: 1,
  status: 'pending',
  attempts: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const jobInserted = await createRoundupJob(jobRecord)
assert.equal(jobInserted, true, 'Job insert must succeed')

const duplicateJob = await createRoundupJob(jobRecord)
assert.equal(duplicateJob, false, 'Duplicate job insert must be rejected')

const pending = await getPendingJobs(chainId)
assert(pending.length > 0, 'Pending jobs must contain queued job')
const job = pending.find((j) => j.paymentKey === paymentKey)
assert(job, 'Queued job must be found in pending list')
assert.equal(job.roundupAmount6, '830000')
console.log('✔ Roundup job queueing and retrieval verified')

// 6. Test job status transition
await updateJobStatus(job.jobId, 'confirmed', {
  relayerTxHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
})

const activity = await getActivityForWallet(chainId, testWallet)
assert.equal(activity.length, 1)
assert.equal(activity[0].roundupStatus, 'saved')
assert.equal(activity[0].relayerTxHash, '0x2222222222222222222222222222222222222222222222222222222222222222')
console.log('✔ Activity view verified: payment and savings hashes correctly linked')

console.log('All Observer, Relayer & Storage logic unit tests PASSED!')
