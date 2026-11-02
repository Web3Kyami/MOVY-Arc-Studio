import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  createRoundupJob,
  getPendingJobs,
  getSubmissionRecoveryJobs,
  saveObservedPayment,
  updateJobStatus,
} from '../src/lib/server/db.ts'
import {
  reconcileSubmittedRelayerTransaction,
  submitAndPersistRelayerTransaction,
} from '../src/lib/server/relayer-recovery.ts'

const makeJob = async (walletIndex) => {
  const paymentKey = `0x${randomBytes(32).toString('hex')}`
  const txHash = `0x${randomBytes(32).toString('hex')}`
  const wallet = `0x${walletIndex.toString(16).padStart(40, '0')}`
  const destination = '0x2222222222222222222222222222222222222222'
  const now = new Date().toISOString()
  await saveObservedPayment({
    paymentKey,
    chainId: 5042002,
    txHash,
    logIndex: 0,
    blockNumber: walletIndex,
    payer: wallet,
    recipient: '0x3333333333333333333333333333333333333333',
    amount6: '1000000',
    roundup6: '100000',
    isEligible: true,
    createdAt: now,
  })
  await createRoundupJob({
    paymentKey,
    chainId: 5042002,
    wallet,
    destination,
    roundupAmount6: '100000',
    configEpoch: 1,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  })
  return { paymentKey, job: (await getPendingJobs(5042002, 10)).find((row) => row.paymentKey === paymentKey) }
}

const { paymentKey, job } = await makeJob(401)
assert.ok(job?.jobId)
const submittedHash = `0x${randomBytes(32).toString('hex')}`
let broadcastCalls = 0

await assert.rejects(() => submitAndPersistRelayerTransaction({
  markSubmitting: () => updateJobStatus(job.jobId, 'submitting'),
  broadcast: async () => {
    broadcastCalls++
    return submittedHash
  },
  persistHash: (hash) => updateJobStatus(job.jobId, 'submitted', { relayerTxHash: hash }),
  waitForReceipt: async (hash) => {
    const saved = (await getSubmissionRecoveryJobs(5042002)).find((row) => row.paymentKey === paymentKey)
    assert.equal(saved?.status, 'submitted', 'The hash and submitted state must be durable before waiting for a receipt')
    assert.equal(saved?.relayerTxHash, hash)
    throw new Error('simulated process crash while receipt is pending')
  },
}), /simulated process crash/)

assert.equal(broadcastCalls, 1)
assert.equal((await getPendingJobs(5042002, 10)).some((row) => row.paymentKey === paymentKey), false)
assert.equal((await getSubmissionRecoveryJobs(5042002)).find((row) => row.paymentKey === paymentKey)?.status, 'submitted')

const pending = await reconcileSubmittedRelayerTransaction({
  hash: submittedHash,
  getReceipt: async () => null,
  resolveReceipt: async () => assert.fail('A missing receipt cannot be resolved'),
  persistFinalStatus: () => assert.fail('A missing receipt must not finalize or reset a submitted job'),
})
assert.equal(pending, 'pending', 'Pending receipts must remain submitted and must never trigger another broadcast')
assert.equal(broadcastCalls, 1)

const unverifiedReceipt = await reconcileSubmittedRelayerTransaction({
  hash: submittedHash,
  getReceipt: async () => ({ status: 'success', eventVerified: false }),
  resolveReceipt: async () => ({ status: 'pending', reason: 'roundup_event_mismatch' }),
  persistFinalStatus: () => assert.fail('A successful receipt without event attestation must not confirm'),
})
assert.equal(unverifiedReceipt, 'pending', 'An unattested success remains quarantined')
assert.equal((await getSubmissionRecoveryJobs(5042002)).find((row) => row.paymentKey === paymentKey)?.status, 'submitted')

const recovered = await reconcileSubmittedRelayerTransaction({
  hash: submittedHash,
  getReceipt: async () => ({ status: 'success', eventVerified: true }),
  resolveReceipt: async (receipt) => receipt.eventVerified
    ? { status: 'confirmed' }
    : { status: 'pending', reason: 'roundup_event_mismatch' },
  persistFinalStatus: (resolution, hash) => updateJobStatus(job.jobId, resolution.status, { relayerTxHash: hash }),
})
assert.equal(recovered, 'confirmed')
assert.equal((await getSubmissionRecoveryJobs(5042002)).some((row) => row.paymentKey === paymentKey), false)

const uncertain = await makeJob(402)
assert.ok(uncertain.job?.jobId)
await assert.rejects(() => submitAndPersistRelayerTransaction({
  markSubmitting: () => updateJobStatus(uncertain.job.jobId, 'submitting'),
  broadcast: async () => { throw new Error('simulated connection loss after uncertain broadcast') },
  persistHash: () => assert.fail('No hash was returned by the mocked broadcaster'),
  waitForReceipt: async () => assert.fail('Receipt polling cannot run without a hash'),
}), /connection loss/)
assert.equal((await getSubmissionRecoveryJobs(5042002)).find((row) => row.paymentKey === uncertain.paymentKey)?.status, 'submitting')
assert.equal((await getPendingJobs(5042002, 10)).some((row) => row.paymentKey === uncertain.paymentKey), false,
  'Uncertain broadcasts must remain quarantined rather than being retried')

const relayerSource = readFileSync(new URL('../src/lib/server/relayer.ts', import.meta.url), 'utf8')
assert.match(relayerSource, /getSubmissionRecoveryJobs/)
assert.match(relayerSource, /reconcileSubmittedRelayerTransaction/)
assert.match(relayerSource, /submitAndPersistRelayerTransaction/)

console.log('Relayer crash recovery and pending receipt tests passed')
