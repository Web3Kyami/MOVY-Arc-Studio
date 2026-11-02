import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { encodeAbiParameters, encodeEventTopics, keccak256, padHex, parseAbiItem, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  advancePaymentHistoryReplay,
  createRoundupJob,
  ensurePaymentHistoryReplay,
  getCursor,
  getEnrollmentHistoryAtPosition,
  getEnrollmentHistoryCursor,
  getPaymentHistoryReplay,
  getRoundupJobByPaymentKey,
  saveObservedPayment,
  setCursor,
  setEnrollmentHistoryCursor,
  upsertEnrollmentHistoryState,
} from '../src/lib/server/db.ts'
import { CANONICAL_ARC_USDC, getAutoSaverAddress, getDeployBlock, SYSTEM_USDC_EMITTER } from '../src/lib/server/config.ts'
import { processEnrollmentHistoryWindow } from '../src/lib/server/enrollment-history.ts'
import { resolvePaymentScanWindow } from '../src/lib/server/payment-authorization.ts'
import { processPendingJobs } from '../src/lib/server/relayer.ts'
import { computePaymentKey } from '../src/lib/server/observer.ts'

const chainId = 5042002
const deployBlock = getDeployBlock(chainId)
const autoSaverAddress = getAutoSaverAddress(chainId)
const firstWindowEnd = deployBlock + 999
const oldPaymentBlock = deployBlock + 1500
const enrolledBlock = deployBlock + 1600
const authorizedPaymentBlock = deployBlock + 1700
const migratedPaymentCursor = deployBlock + 2500
const wallet = '0x1111111111111111111111111111111111111111'
const destination = '0x2222222222222222222222222222222222222222'
const outsider = '0x3333333333333333333333333333333333333333'
const owner = '0x4444444444444444444444444444444444444444'
const relayerKey = `0x${'1'.repeat(64)}`
const relayerAddress = privateKeyToAccount(relayerKey).address
const transferTopic = keccak256(stringToHex('Transfer(address,address,uint256)'))
const roundupExecutedAbi = parseAbiItem(
  'event RoundupExecuted(bytes32 indexed paymentKey, address indexed wallet, address indexed destination, uint64 paymentAmount6, uint64 roundupAmount6, bytes32 paymentTxHash, uint256 canonicalLogIndex)',
)
const paymentEvidence = new Map()
const rpcFailures = new Set()
let onchainOwner = owner
let onchainRelayer = relayerAddress
let relayerBalance = 10_000_000_000_000_000n
let lastSubmission = null
const blockHashFor = (blockNumber) => `0x${BigInt(blockNumber).toString(16).padStart(64, '0')}`
const now = new Date().toISOString()
const events = [{
  kind: 'enrolled',
  wallet,
  blockNumber: enrolledBlock,
  logIndex: 2,
  destination,
  maxRoundup6: '1000000',
  dailyCap6: '2000000',
  configEpoch: 7,
}]

async function seedPendingJob(blockNumber) {
  const paymentTxHash = `0x${randomBytes(32).toString('hex')}`
  const logIndex = 4
  const paymentKey = computePaymentKey(chainId, paymentTxHash, logIndex, wallet)
  const amount6 = 170_000n
  const blockHash = blockHashFor(blockNumber)
  const transferLog = {
    address: SYSTEM_USDC_EMITTER,
    topics: [transferTopic, padHex(wallet, { size: 32 }), padHex(outsider, { size: 32 })],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount6 * 1_000_000_000_000n]),
    logIndex,
    blockNumber: BigInt(blockNumber),
    blockHash,
    transactionHash: paymentTxHash,
  }
  paymentEvidence.set(paymentTxHash, {
    transaction: {
      hash: paymentTxHash,
      from: wallet,
      to: outsider,
      value: amount6 * 1_000_000_000_000n,
      input: '0x',
      blockNumber: BigInt(blockNumber),
      blockHash,
    },
    receipt: {
      status: 'success', transactionHash: paymentTxHash, blockNumber: BigInt(blockNumber), blockHash,
      logs: [transferLog],
    },
  })
  await saveObservedPayment({
    paymentKey,
    chainId,
    txHash: paymentTxHash,
    logIndex,
    blockNumber,
    payer: wallet,
    recipient: outsider,
    amount6: amount6.toString(),
    roundup6: '830000',
    isEligible: true,
    createdAt: now,
  })
  await createRoundupJob({
    paymentKey,
    chainId,
    wallet,
    destination,
    roundupAmount6: '830000',
    configEpoch: 7,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  })
  return { paymentKey, paymentTxHash }
}

// This simulates an existing database whose monotonic payment cursor already
// passed both pending jobs before enrollment history was introduced.
const unauthorizedJob = await seedPendingJob(oldPaymentBlock)
const authorizedJob = await seedPendingJob(authorizedPaymentBlock)
await setCursor(chainId, migratedPaymentCursor)
await ensurePaymentHistoryReplay(chainId, deployBlock)
assert.equal((await getPaymentHistoryReplay(chainId))?.nextBlock, deployBlock)

let currentBlock = migratedPaymentCursor
const indexEnrollmentWindow = () => processEnrollmentHistoryWindow(chainId, 1000, {
  getCurrentBlock: async () => currentBlock,
  getCursor: getEnrollmentHistoryCursor,
  getDeployBlock: () => deployBlock,
  getEvents: async (_requestedChainId, fromBlock, toBlock) =>
    events.filter((event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock),
  getStateBeforePosition: getEnrollmentHistoryAtPosition,
  saveState: upsertEnrollmentHistoryState,
  syncWallet: async () => {},
  setCursor: setEnrollmentHistoryCursor,
})

const advanceMockPaymentReplayWindow = async () => {
  const replay = await getPaymentHistoryReplay(chainId)
  assert.ok(replay, 'The migrated database must keep replay active until its old cursor is reached')
  const window = resolvePaymentScanWindow({
    deployBlock,
    currentBlock,
    historyCursor: await getEnrollmentHistoryCursor(chainId),
    paymentCursor: await getCursor(chainId),
    replay,
    maxBlocks: 1000,
  })
  assert.ok(window)
  assert.ok(window.toBlock - window.fromBlock < 1000, 'Each mock cycle must stay within the worker block limit')
  await advancePaymentHistoryReplay(chainId, window.toBlock + 1)
  return window
}

let mockBroadcastCount = 0
const fakeHash = `0x${'a'.repeat(64)}`
const runtime = {
  getPublicClient: () => ({
    getChainId: async () => chainId,
    getCode: async () => '0x6000',
    request: async ({ method }) => {
      assert.equal(method, 'eth_getBlockByNumber')
      return { number: `0x${BigInt(currentBlock).toString(16)}` }
    },
    getTransaction: async ({ hash }) => {
      if (rpcFailures.has(hash)) throw new Error('temporary fixture RPC timeout')
      return paymentEvidence.get(hash)?.transaction
    },
    getTransactionReceipt: async ({ hash }) => paymentEvidence.get(hash)?.receipt,
    getBlock: async ({ blockNumber }) => ({ hash: blockHashFor(blockNumber) }),
    estimateContractGas: async () => 100_000n,
    getBalance: async () => relayerBalance,
    readContract: async ({ functionName }) => {
      if (functionName === 'owner') return onchainOwner
      if (functionName === 'relayer') return onchainRelayer
      if (functionName === 'usdc') return CANONICAL_ARC_USDC
      // The relayer now reads the contract-wide pause first. This fixture models a running service.
      if (functionName === 'paused') return false
      if (functionName === 'getUserConfig') {
        return { enrolled: true, paused: false, destination, configEpoch: 7, maxRoundup6: 1000000n }
      }
      if (functionName === 'balanceOf' || functionName === 'allowance' || functionName === 'getRemainingDailyAllowance') {
        return 1000000n
      }
      if (functionName === 'isPaymentProcessed') return false
      assert.fail(`Unexpected read-only relayer call: ${functionName}`)
    },
    waitForTransactionReceipt: async ({ hash }) => {
      assert.equal(hash, fakeHash)
      assert.ok(lastSubmission)
      const blockNumber = BigInt(currentBlock)
      const roundupAmount6 = 1_000_000n - lastSubmission.paymentAmount6 % 1_000_000n
      return {
        status: 'success', transactionHash: hash, blockNumber, blockHash: blockHashFor(blockNumber), to: autoSaverAddress,
        logs: [{
          address: autoSaverAddress,
          blockHash: blockHashFor(blockNumber),
          blockNumber,
          data: encodeAbiParameters(
            [{ type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'uint256' }],
            [lastSubmission.paymentAmount6, roundupAmount6, lastSubmission.paymentTxHash, BigInt(lastSubmission.canonicalLogIndex)],
          ),
          logIndex: 0,
          removed: false,
          topics: encodeEventTopics({
            abi: [roundupExecutedAbi], eventName: 'RoundupExecuted',
            args: { paymentKey: lastSubmission.paymentKey, wallet: lastSubmission.wallet, destination: lastSubmission.destination },
          }),
          transactionHash: hash,
          transactionIndex: 0,
        }],
      }
    },
  }),
  createWalletClient: () => ({
    writeContract: async ({ args }) => {
      mockBroadcastCount++
      assert.equal(args[0], wallet)
      lastSubmission = {
        paymentKey: computePaymentKey(chainId, args[1], Number(args[2]), args[0]),
        wallet: args[0], paymentTxHash: args[1], canonicalLogIndex: Number(args[2]),
        paymentAmount6: args[3], destination: args[4],
      }
      return fakeHash
    },
  }),
}

// Mock one complete worker cycle at a time: index one 1000-block window,
// replay one bounded payment window, then invoke the actual relayer phase.
const runMockWorkerCycle = async () => {
  await indexEnrollmentWindow()
  const replayWindow = await advanceMockPaymentReplayWindow()
  const relayerResult = await processPendingJobs(chainId, { runtime, allowBroadcast: true })
  return { replayWindow, relayerResult }
}

process.env.RELAYER_PRIVATE_KEY = relayerKey
process.env.MOVY_RELAYER_ENABLED = 'true'
process.env.MOVY_RELAYER_MAX_FEE_PER_GAS_WEI = '25000000000'
process.env.MOVY_RELAYER_MAX_TX_FEE_WEI = '10000000000000000'

const firstCycle = await runMockWorkerCycle()
assert.equal(firstCycle.replayWindow.fromBlock, deployBlock)
assert.equal(firstCycle.replayWindow.toBlock, firstWindowEnd)
assert.equal(firstCycle.relayerResult.deferred, 2)
assert.equal(mockBroadcastCount, 0, 'Legacy jobs beyond the current replay window must not broadcast')
assert.equal((await getRoundupJobByPaymentKey(unauthorizedJob.paymentKey))?.status, 'pending')
assert.equal((await getPaymentHistoryReplay(chainId))?.nextBlock, firstWindowEnd + 1)

// Reinitializing after a worker restart must retain the persisted replay cursor.
await ensurePaymentHistoryReplay(chainId, deployBlock)
assert.equal((await getPaymentHistoryReplay(chainId))?.nextBlock, firstWindowEnd + 1)

const secondCycle = await runMockWorkerCycle()
assert.equal(secondCycle.replayWindow.fromBlock, firstWindowEnd + 1)
assert.equal(secondCycle.replayWindow.toBlock, deployBlock + 1999)
assert.equal(secondCycle.relayerResult.deferred, 2)
assert.equal(mockBroadcastCount, 0, 'A job is still gated until the complete migration replay finishes')

const thirdCycle = await runMockWorkerCycle()
assert.equal(thirdCycle.replayWindow.fromBlock, deployBlock + 2000)
assert.equal(thirdCycle.replayWindow.toBlock, migratedPaymentCursor)
assert.equal(await getPaymentHistoryReplay(chainId), null)
assert.equal(thirdCycle.relayerResult.skipped, 1, 'The historical pre-enrollment job must be quarantined')
assert.equal(thirdCycle.relayerResult.confirmed, 1, 'A historically authorized post-enrollment job remains functional')
assert.equal((await getRoundupJobByPaymentKey(unauthorizedJob.paymentKey))?.status, 'skipped')
assert.equal((await getRoundupJobByPaymentKey(authorizedJob.paymentKey))?.status, 'confirmed')
assert.equal(mockBroadcastCount, 1, 'Only the post-enrollment job may be sent after migration replay completes')

// A transient payment-RPC failure remains retryable and never becomes a
// terminal accounting failure.
const retryJob = await seedPendingJob(authorizedPaymentBlock + 1)
rpcFailures.add(retryJob.paymentTxHash)
const failedRead = await processPendingJobs(chainId, { runtime, allowBroadcast: true })
assert.equal(failedRead.deferred, 1)
assert.equal((await getRoundupJobByPaymentKey(retryJob.paymentKey))?.status, 'pending')
assert.equal(mockBroadcastCount, 1, 'RPC failure must not reach the signing fixture')
rpcFailures.delete(retryJob.paymentTxHash)
const recoveredRead = await processPendingJobs(chainId, { runtime, allowBroadcast: true })
assert.equal(recoveredRead.confirmed, 1)
assert.equal((await getRoundupJobByPaymentKey(retryJob.paymentKey))?.status, 'confirmed')
assert.equal(mockBroadcastCount, 2, 'Recovered canonical evidence can resume one idempotent job')

const roleMismatchJob = await seedPendingJob(authorizedPaymentBlock + 2)
onchainOwner = relayerAddress
const countBeforeRoleMismatch = mockBroadcastCount
const roleMismatch = await processPendingJobs(chainId, { runtime, allowBroadcast: true })
assert.equal(roleMismatch.deferred, 1)
assert.equal((await getRoundupJobByPaymentKey(roleMismatchJob.paymentKey))?.status, 'pending')
assert.equal(mockBroadcastCount, countBeforeRoleMismatch, 'Converged owner/relayer roles must not create a signer write')
onchainOwner = owner

const underfundedJob = await seedPendingJob(authorizedPaymentBlock + 3)
relayerBalance = 0n
const priorBalanceResult = await processPendingJobs(chainId, { runtime, allowBroadcast: true })
assert.equal(priorBalanceResult.deferred, 2)
assert.equal((await getRoundupJobByPaymentKey(underfundedJob.paymentKey))?.status, 'pending')
assert.equal(mockBroadcastCount, countBeforeRoleMismatch, 'An underfunded relayer must defer before the durable submitting marker')
relayerBalance = 10_000_000_000_000_000n

const feeCapJob = await seedPendingJob(authorizedPaymentBlock + 3)
const priorFeeCap = process.env.MOVY_RELAYER_MAX_TX_FEE_WEI
process.env.MOVY_RELAYER_MAX_TX_FEE_WEI = '1'
const feeCapResult = await processPendingJobs(chainId, { runtime, allowBroadcast: true })
assert.equal(feeCapResult.deferred, 3, 'Fee preflight defers all pending jobs when the transaction cap is undersized')
assert.equal((await getRoundupJobByPaymentKey(feeCapJob.paymentKey))?.status, 'pending')
assert.equal(mockBroadcastCount, countBeforeRoleMismatch, 'Fee preflight must not reach the signing fixture')
if (priorFeeCap === undefined) delete process.env.MOVY_RELAYER_MAX_TX_FEE_WEI
else process.env.MOVY_RELAYER_MAX_TX_FEE_WEI = priorFeeCap

console.log('Legacy pending migration gate and integrated worker-cycle regression tests passed')
