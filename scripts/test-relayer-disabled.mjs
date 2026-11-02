import assert from 'node:assert/strict'
import {
  advancePaymentHistoryReplay,
  createRoundupJob,
  ensurePaymentHistoryReplay,
  getPendingJobs,
  saveObservedPayment,
  setCursor,
  setEnrollmentHistoryCursor,
  upsertEnrollmentHistoryState,
} from '../src/lib/server/db.ts'
import { getDeployBlock } from '../src/lib/server/config.ts'
import { processPendingJobs } from '../src/lib/server/relayer.ts'

const chainId = 5042002
const deployBlock = getDeployBlock(chainId)
const paymentBlock = deployBlock + 1
const wallet = '0x1111111111111111111111111111111111111111'
const destination = '0x2222222222222222222222222222222222222222'
const paymentKey = 'relayer-disabled-regression'
const now = new Date().toISOString()

await upsertEnrollmentHistoryState({
  chainId,
  wallet,
  blockNumber: deployBlock,
  logIndex: 0,
  destination,
  maxRoundup6: '500000',
  dailyCap6: '2000000',
  configEpoch: 1,
  status: 'active',
})
await setEnrollmentHistoryCursor(chainId, paymentBlock)
await setCursor(chainId, paymentBlock)
await ensurePaymentHistoryReplay(chainId, deployBlock)
await advancePaymentHistoryReplay(chainId, paymentBlock + 1)
await saveObservedPayment({
  paymentKey,
  chainId,
  txHash: `0x${'1'.repeat(64)}`,
  logIndex: 1,
  blockNumber: paymentBlock,
  payer: wallet,
  recipient: '0x3333333333333333333333333333333333333333',
  amount6: '1000000',
  roundup6: '100000',
  isEligible: true,
  createdAt: now,
})
await createRoundupJob({
  paymentKey,
  chainId,
  wallet,
  destination,
  roundupAmount6: '100000',
  configEpoch: 1,
  status: 'pending',
  attempts: 0,
  createdAt: now,
  updatedAt: now,
})

let signerClientCreations = 0
const runtime = {
  getPublicClient: () => { throw new Error('disabled relayer must not initialize a chain client') },
  createWalletClient: () => { signerClientCreations++; throw new Error('disabled relayer must not initialize a signer') },
}
const savedRelayerKey = process.env.RELAYER_PRIVATE_KEY
const savedRelayerSwitch = process.env.MOVY_RELAYER_ENABLED
process.env.RELAYER_PRIVATE_KEY = `0x${'1'.repeat(64)}`
try {
  process.env.MOVY_RELAYER_ENABLED = 'false'
  const disabledByEnvironment = await processPendingJobs(chainId, { runtime, allowBroadcast: true })
  assert.equal(disabledByEnvironment.deferred, 1)
  process.env.MOVY_RELAYER_ENABLED = 'true'
  const disabledByCallSite = await processPendingJobs(chainId, { runtime })
  assert.equal(disabledByCallSite.deferred, 1)
  assert.equal(signerClientCreations, 0, 'Neither gate may initialize a transaction signer')
  assert.equal((await getPendingJobs(chainId)).find((job) => job.paymentKey === paymentKey)?.status, 'pending')
} finally {
  if (savedRelayerKey === undefined) delete process.env.RELAYER_PRIVATE_KEY
  else process.env.RELAYER_PRIVATE_KEY = savedRelayerKey
  if (savedRelayerSwitch === undefined) delete process.env.MOVY_RELAYER_ENABLED
  else process.env.MOVY_RELAYER_ENABLED = savedRelayerSwitch
}
console.log('Financial broadcasts remain blocked unless both independent relayer gates are enabled')
