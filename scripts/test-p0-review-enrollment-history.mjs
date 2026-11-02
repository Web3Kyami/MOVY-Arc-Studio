import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  advancePaymentHistoryReplay,
  ensurePaymentHistoryReplay,
  getCursor,
  getEnrollmentHistoryAtPosition,
  getEnrollmentHistoryCursor,
  getPaymentHistoryReplay,
  setCursor,
  setEnrollmentHistoryCursor,
  upsertEnrollmentHistoryState,
} from '../src/lib/server/db.ts'
import { processEnrollmentHistoryWindow } from '../src/lib/server/enrollment-history.ts'
import { decidePaymentAuthorization, resolvePaymentScanWindow } from '../src/lib/server/payment-authorization.ts'

const chainId = 5042002
const deployBlock = 100
const wallet = '0x1111111111111111111111111111111111111111'
const firstDestination = '0x2222222222222222222222222222222222222222'
const secondDestination = '0x3333333333333333333333333333333333333333'
const reEnrollmentDestination = '0x4444444444444444444444444444444444444444'

// Simulate a deployment whose old payment cursor already passed enrollment.
await setCursor(chainId, 210)
await ensurePaymentHistoryReplay(chainId, deployBlock)
assert.deepEqual({ ...await getPaymentHistoryReplay(chainId) }, { chainId, nextBlock: deployBlock, targetBlock: 210 })

const events = [
  { kind: 'revoked', wallet, blockNumber: 190, logIndex: 4, finalEpoch: 3 },
  { kind: 'enrolled', wallet, blockNumber: 150, logIndex: 10, destination: firstDestination, maxRoundup6: '1000000', dailyCap6: '5000000', configEpoch: 1 },
  { kind: 'pause-toggled', wallet, blockNumber: 170, logIndex: 2, paused: true },
  { kind: 'enrolled', wallet, blockNumber: 200, logIndex: 1, destination: reEnrollmentDestination, maxRoundup6: '1000000', dailyCap6: '5000000', configEpoch: 4 },
  { kind: 'pause-toggled', wallet, blockNumber: 180, logIndex: 3, paused: false },
  { kind: 'config-updated', wallet, blockNumber: 160, logIndex: 1, destination: secondDestination, maxRoundup6: '50000', dailyCap6: '1000000', configEpoch: 2 },
]

const indexed = await processEnrollmentHistoryWindow(chainId, 1_000, {
  getCurrentBlock: async () => 210,
  getCursor: getEnrollmentHistoryCursor,
  getDeployBlock: () => deployBlock,
  getEvents: async (_chainId, fromBlock, toBlock) => {
    assert.equal(fromBlock, deployBlock)
    assert.equal(toBlock, 210)
    return [...events]
  },
  getStateBeforePosition: getEnrollmentHistoryAtPosition,
  saveState: upsertEnrollmentHistoryState,
  syncWallet: async () => {},
  setCursor: setEnrollmentHistoryCursor,
})
assert.equal(indexed.savedEvents, events.length)
assert.equal(await getEnrollmentHistoryCursor(chainId), 210)

const authorizeAt = async (blockNumber, logIndex, roundup6 = 100_000n) =>
  decidePaymentAuthorization(await getEnrollmentHistoryAtPosition(chainId, wallet, blockNumber, logIndex), roundup6)

assert.equal((await authorizeAt(149, 5)).authorized, false, 'A payment before enrollment must never queue a roundup')
assert.equal((await authorizeAt(150, 9)).authorized, false, 'A same-block transfer ordered before enrollment must remain unauthorized')
assert.deepEqual(await authorizeAt(150, 11), {
  authorized: true,
  enrollment: {
    chainId,
    wallet,
    blockNumber: 150,
    logIndex: 10,
    destination: firstDestination,
    maxRoundup6: '1000000',
    dailyCap6: '5000000',
    configEpoch: 1,
    status: 'active',
  },
}, 'A same-block payment after the enrollment log uses that authorized epoch')
assert.equal((await authorizeAt(165, 2, 100_000n)).authorized, false, 'A config update applies its new historical cap and epoch')
assert.equal((await authorizeAt(165, 2, 40_000n)).authorized, true)
assert.equal((await authorizeAt(175, 5)).authorized, false, 'Payments during pause are not authorized')
assert.equal((await authorizeAt(185, 5, 40_000n)).authorized, true, 'Payments after resume use the active historical epoch')
assert.equal((await authorizeAt(195, 5)).authorized, false, 'Payments after revoke are not authorized')
assert.equal((await authorizeAt(205, 5)).enrollment?.configEpoch, 4, 'Re-enrollment starts a new authorized period')

let replay = await getPaymentHistoryReplay(chainId)
const firstReplayWindow = resolvePaymentScanWindow({
  deployBlock,
  currentBlock: 220,
  historyCursor: 210,
  paymentCursor: await getCursor(chainId),
  replay,
  maxBlocks: 50,
})
assert.deepEqual(firstReplayWindow, { fromBlock: 100, toBlock: 149, mode: 'replay' })
await advancePaymentHistoryReplay(chainId, 150)
replay = await getPaymentHistoryReplay(chainId)
const secondReplayWindow = resolvePaymentScanWindow({
  deployBlock,
  currentBlock: 220,
  historyCursor: 210,
  paymentCursor: await getCursor(chainId),
  replay,
  maxBlocks: 50,
})
assert.deepEqual(secondReplayWindow, { fromBlock: 150, toBlock: 199, mode: 'replay' })
await advancePaymentHistoryReplay(chainId, 200)
replay = await getPaymentHistoryReplay(chainId)
assert.deepEqual(resolvePaymentScanWindow({
  deployBlock,
  currentBlock: 220,
  historyCursor: 210,
  paymentCursor: await getCursor(chainId),
  replay,
  maxBlocks: 50,
}), { fromBlock: 200, toBlock: 210, mode: 'replay' }, 'Replay must include eligible payments after an already-advanced payment cursor')
await advancePaymentHistoryReplay(chainId, 211)
assert.equal(await getPaymentHistoryReplay(chainId), null)
assert.equal(await getCursor(chainId), 210, 'Historical replay must not rewind or corrupt the monotonic payment cursor')
assert.deepEqual(resolvePaymentScanWindow({
  deployBlock,
  currentBlock: 220,
  historyCursor: 220,
  paymentCursor: await getCursor(chainId),
  replay: null,
  maxBlocks: 50,
}), { fromBlock: 211, toBlock: 220, mode: 'normal' })

const observerSource = readFileSync(new URL('../src/lib/server/observer.ts', import.meta.url), 'utf8')
assert.match(observerSource, /resolvePaymentScanWindow/)
assert.match(observerSource, /decidePaymentAuthorization/)
assert.match(observerSource, /paymentAuthorization\.authorized/)

console.log('Historical enrollment authorization and payment-cursor replay tests passed')
