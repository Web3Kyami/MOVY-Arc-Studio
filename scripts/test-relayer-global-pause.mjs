// Regression: a contract-wide pause must DEFER relayer jobs, never skip or discard them.
//
// Runs the real `processPendingJobs` against a disposable local PostgreSQL schema
// (via scripts/run-postgres-isolated.mjs) with an injected, block-aware RPC fixture and an
// injected wallet client. No network, no real key, no worker, no deployed address is used.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { encodeAbiParameters, encodeEventTopics, keccak256, padHex, parseAbiItem, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  advancePaymentHistoryReplay,
  createRoundupJob,
  ensurePaymentHistoryReplay,
  getCursor,
  getDb,
  getEnrollmentHistoryAtPosition,
  getEnrollmentHistoryCursor,
  getPaymentHistoryReplay,
  getPendingJobs,
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
const enrolledBlock = deployBlock + 50
const firstPaymentBlock = deployBlock + 100
const startBlock = deployBlock + 500
const wallet = '0x1111111111111111111111111111111111111111'
const destination = '0x2222222222222222222222222222222222222222'
const outsider = '0x3333333333333333333333333333333333333333'
const owner = '0x4444444444444444444444444444444444444444'
const relayerKey = `0x${randomBytes(32).toString('hex')}` // ephemeral, holds nothing, never leaves this process
const relayerAddress = privateKeyToAccount(relayerKey).address
const transferTopic = keccak256(stringToHex('Transfer(address,address,uint256)'))
const roundupExecutedAbi = parseAbiItem(
  'event RoundupExecuted(bytes32 indexed paymentKey, address indexed wallet, address indexed destination, uint64 paymentAmount6, uint64 roundupAmount6, bytes32 paymentTxHash, uint256 canonicalLogIndex)',
)
const blockHashFor = (blockNumber) => `0x${BigInt(blockNumber).toString(16).padStart(64, '0')}`
const now = new Date().toISOString()
const SECRET_SHAPED = 'https://rpc.example.invalid/v1/s3cr3t-api-key-0123456789abcdef?token=abc123tok&apikey=zzTOPSECRETzz'

process.env.RELAYER_PRIVATE_KEY = relayerKey
process.env.MOVY_RELAYER_ENABLED = 'true'
process.env.MOVY_RELAYER_MAX_FEE_PER_GAS_WEI = '25000000000'
process.env.MOVY_RELAYER_MAX_TX_FEE_WEI = '10000000000000000'
process.env.ARC_TESTNET_RPC_URL ??= 'http://127.0.0.1:8545'
process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ??= 'http://127.0.0.1:8545'

// ---------------------------------------------------------------------------
// Block-aware chain fixture. `timeline` is the contract state per block.
// ---------------------------------------------------------------------------
let latest = startBlock
let finalized = startBlock
const timeline = [{ fromBlock: 0, paused: false, remaining: 5_000_000n }]
let userPaused = false
let pauseReadMode = 'state' // 'state' | 'throw' | 'unknown'
let afterPausedRead = null
const reads = []
const writes = []
const priorRoundupWrites = []
const gasEstimates = []
const logLines = []
const paymentEvidence = new Map()
let nextRoundupReceiptMode = 'valid'

function makeRoundupReceipt(write) {
  const blockNumber = BigInt(finalized)
  const logs = nextRoundupReceiptMode === 'missing-event' ? [] : [{
    address: autoSaverAddress,
    blockHash: blockHashFor(blockNumber),
    blockNumber,
    data: encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'uint256' }],
      [write.paymentAmount6, 1_000_000n - write.paymentAmount6 % 1_000_000n, write.paymentTxHash, BigInt(write.canonicalLogIndex)],
    ),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: [roundupExecutedAbi],
      eventName: 'RoundupExecuted',
      args: { paymentKey: write.paymentKey, wallet: write.wallet, destination: write.destination },
    }),
    transactionHash: write.hash,
    transactionIndex: 0,
  }]
  return {
    status: 'success',
    transactionHash: write.hash,
    blockNumber,
    blockHash: blockHashFor(blockNumber),
    to: autoSaverAddress,
    logs,
  }
}

const stateAt = (block) => [...timeline].reverse().find((entry) => entry.fromBlock <= block)
const pushState = (patch) => {
  const base = stateAt(latest)
  latest += 1
  timeline.push({ ...base, ...patch, fromBlock: latest })
}

for (const level of ['info', 'warn', 'error', 'log']) {
  const original = console[level].bind(console)
  console[level] = (...args) => {
    logLines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    original(...args)
  }
}

const runtime = {
  getPublicClient: () => ({
    getChainId: async () => chainId,
    getCode: async () => '0x6000',
    request: async ({ method }) => {
      assert.equal(method, 'eth_getBlockByNumber')
      return { number: `0x${BigInt(finalized).toString(16)}` }
    },
    getTransaction: async ({ hash }) => paymentEvidence.get(hash)?.transaction,
    getTransactionReceipt: async ({ hash }) => writes.find((write) => write.hash === hash)?.receipt ?? paymentEvidence.get(hash)?.receipt,
    getBlock: async ({ blockNumber }) => ({ hash: blockHashFor(blockNumber) }),
    getLogs: async ({ fromBlock, toBlock }) => {
      assert.ok(toBlock - fromBlock + 1n <= 1_000n, 'the replay shortcut must keep RPC log ranges bounded')
      return [...writes, ...priorRoundupWrites]
        .flatMap((write) => write.receipt?.logs ?? [])
        .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
    },
    estimateContractGas: async ({ functionName }) => {
      // Gas estimation runs on the latest state, exactly like a real node.
      gasEstimates.push({ functionName, latest })
      if (stateAt(latest).paused) throw new Error('execution reverted: ContractPaused()')
      return 100_000n
    },
    getBalance: async () => 10_000_000_000_000_000n,
    readContract: async ({ functionName, args, blockNumber }) => {
      reads.push({ functionName, blockNumber: blockNumber === undefined ? undefined : Number(blockNumber) })
      const at = blockNumber === undefined ? latest : Number(blockNumber)
      const state = stateAt(at)
      switch (functionName) {
        case 'owner': return owner
        case 'relayer': return relayerAddress
        case 'usdc': return CANONICAL_ARC_USDC
        case 'paused': {
          if (pauseReadMode === 'throw') throw new Error(`RPC failure calling ${SECRET_SHAPED}`)
          if (pauseReadMode === 'unknown') return undefined
          const value = state.paused
          afterPausedRead?.()
          return value
        }
        case 'getUserConfig':
          return { enrolled: true, paused: userPaused, destination, configEpoch: 7, maxRoundup6: 1_000_000n }
        case 'balanceOf':
        case 'allowance':
          return 10_000_000n
        case 'getRemainingDailyAllowance':
          // Mirrors the fixed contract view: zero while the contract is paused.
          return state.paused ? 0n : state.remaining
        case 'isPaymentProcessed':
          return [...writes, ...priorRoundupWrites].some((write) => write.paymentKey === args[0])
        default:
          assert.fail(`Unexpected read-only relayer call: ${functionName}`)
      }
    },
    waitForTransactionReceipt: async ({ hash }) => {
      const write = writes.find((entry) => entry.hash === hash)
      assert.ok(write, 'the receipt must belong to a submitted roundup transaction')
      write.receipt = makeRoundupReceipt(write)
      nextRoundupReceiptMode = 'valid'
      return write.receipt
    },
  }),
  createWalletClient: () => ({
    writeContract: async ({ args }) => {
      const paymentKey = computePaymentKey(chainId, args[1], Number(args[2]), args[0])
      const hash = `0x${randomBytes(32).toString('hex')}`
      writes.push({
        paymentKey,
        wallet: args[0],
        paymentTxHash: args[1],
        canonicalLogIndex: Number(args[2]),
        paymentAmount6: args[3],
        destination: args[4],
        hash,
      })
      return hash
    },
  }),
}

// ---------------------------------------------------------------------------
// Database fixture: a replay-complete, enrollment-indexed schema with pending jobs.
// ---------------------------------------------------------------------------
let paymentBlockCounter = firstPaymentBlock
async function seedPendingJob() {
  const blockNumber = paymentBlockCounter++
  const paymentTxHash = `0x${randomBytes(32).toString('hex')}`
  const logIndex = 4
  const paymentKey = computePaymentKey(chainId, paymentTxHash, logIndex, wallet)
  const amount6 = 170_000n
  const blockHash = blockHashFor(blockNumber)
  const transferLog = {
    address: SYSTEM_USDC_EMITTER,
    topics: [transferTopic, padHex(wallet, { size: 32 }), padHex(outsider, { size: 32 })],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount6 * 1_000_000_000_000n]),
    logIndex, blockNumber: BigInt(blockNumber), blockHash, transactionHash: paymentTxHash,
  }
  paymentEvidence.set(paymentTxHash, {
    transaction: {
      hash: paymentTxHash, from: wallet, to: outsider, value: amount6 * 1_000_000_000_000n,
      input: '0x', blockNumber: BigInt(blockNumber), blockHash,
    },
    receipt: {
      status: 'success', transactionHash: paymentTxHash, blockNumber: BigInt(blockNumber), blockHash,
      logs: [transferLog],
    },
  })
  await saveObservedPayment({
    paymentKey, chainId, txHash: paymentTxHash, logIndex, blockNumber, payer: wallet, recipient: outsider,
    amount6: amount6.toString(), roundup6: '830000', isEligible: true, createdAt: now,
  })
  await createRoundupJob({
    paymentKey, chainId, wallet, destination, roundupAmount6: '830000', configEpoch: 7,
    status: 'pending', attempts: 0, createdAt: now, updatedAt: now,
  })
  return { paymentKey, paymentTxHash }
}

const pendingRecord = async (paymentKey) =>
  (await getPendingJobs(chainId, 50)).find((job) => job.paymentKey === paymentKey)
const statusOf = async (paymentKey) => (await getRoundupJobByPaymentKey(paymentKey))?.status

// Index enrollment history and finish the migration replay window once, as the worker would.
await setCursor(chainId, startBlock)
await ensurePaymentHistoryReplay(chainId, deployBlock)
await processEnrollmentHistoryWindow(chainId, 1000, {
  getCurrentBlock: async () => startBlock,
  getCursor: getEnrollmentHistoryCursor,
  getDeployBlock: () => deployBlock,
  getEvents: async (_id, fromBlock, toBlock) => [{
    kind: 'enrolled', wallet, blockNumber: enrolledBlock, logIndex: 2, destination,
    maxRoundup6: '1000000', dailyCap6: '5000000', configEpoch: 7,
  }].filter((event) => event.blockNumber >= fromBlock && event.blockNumber <= toBlock),
  getStateBeforePosition: getEnrollmentHistoryAtPosition,
  saveState: upsertEnrollmentHistoryState,
  syncWallet: async () => {},
  setCursor: setEnrollmentHistoryCursor,
})
for (let guard = 0; guard < 4; guard++) {
  const replay = await getPaymentHistoryReplay(chainId)
  if (!replay) break
  const window = resolvePaymentScanWindow({
    deployBlock, currentBlock: startBlock,
    historyCursor: await getEnrollmentHistoryCursor(chainId),
    paymentCursor: await getCursor(chainId), replay, maxBlocks: 1000,
  })
  assert.ok(window)
  await advancePaymentHistoryReplay(chainId, window.toBlock + 1)
}
assert.equal(await getPaymentHistoryReplay(chainId), null, 'fixture must start replay-complete')

const run = () => processPendingJobs(chainId, { runtime, allowBroadcast: true })
const snapshot = () => ({ reads: reads.length, writes: writes.length, gas: gasEstimates.length })
const since = (mark) => ({
  reads: reads.slice(mark.reads),
  writes: writes.slice(mark.writes),
  gas: gasEstimates.slice(mark.gas),
})
const QUOTA_READS = ['getUserConfig', 'balanceOf', 'allowance', 'getRemainingDailyAllowance', 'isPaymentProcessed']

// ---------------------------------------------------------------------------
// 1. Paused service: defer. Never broadcast, never count an attempt, never skip/confirm.
// ---------------------------------------------------------------------------
const job = await seedPendingJob()
assert.equal((await pendingRecord(job.paymentKey))?.attempts, 0)

pushState({ paused: true })
finalized = latest
let mark = snapshot()
let result = await run()
let seen = since(mark)
assert.deepEqual(
  { deferred: result.deferred, skipped: result.skipped, confirmed: result.confirmed, failed: result.failed },
  { deferred: 1, skipped: 0, confirmed: 0, failed: 0 },
)
assert.equal(seen.writes.length, 0, 'a paused service must never broadcast')
assert.equal(seen.gas.length, 0, 'a paused service must stop before gas estimation')
assert.equal(await statusOf(job.paymentKey), 'pending', 'the job must remain pending')
assert.equal((await pendingRecord(job.paymentKey))?.attempts, 0, 'a deferral must not increment attempts')
assert.ok(seen.reads.some((read) => read.functionName === 'paused'))
assert.deepEqual(
  seen.reads.filter((read) => QUOTA_READS.includes(read.functionName)),
  [],
  'the pause is checked before any user-state or quota classification',
)
assert.equal(seen.reads.find((read) => read.functionName === 'paused').blockNumber, finalized, 'the pause read is pinned to an explicit block')

// A second pass while still paused behaves identically (idempotent deferral).
result = await run()
assert.equal(result.deferred, 1)
assert.equal(await statusOf(job.paymentKey), 'pending')
assert.equal(writes.length, 0)

// ---------------------------------------------------------------------------
// 2. Unavailable or unknown pause state: defer safely, no leaked provider detail.
// ---------------------------------------------------------------------------
pushState({ paused: false })
finalized = latest
for (const mode of ['throw', 'unknown']) {
  pauseReadMode = mode
  mark = snapshot()
  const logStart = logLines.length
  result = await run()
  seen = since(mark)
  assert.deepEqual(
    { deferred: result.deferred, skipped: result.skipped, confirmed: result.confirmed, failed: result.failed },
    { deferred: 1, skipped: 0, confirmed: 0, failed: 0 },
    `${mode} pause state must defer`,
  )
  assert.equal(seen.writes.length, 0, `${mode} pause state must never broadcast`)
  assert.equal(await statusOf(job.paymentKey), 'pending')
  assert.equal((await pendingRecord(job.paymentKey))?.attempts, 0)
  assert.deepEqual(seen.reads.filter((read) => QUOTA_READS.includes(read.functionName)), [])
  const logged = logLines.slice(logStart).join('\n')
  for (const secret of ['s3cr3t', 'abc123tok', 'zzTOPSECRETzz', 'rpc.example.invalid']) {
    assert.ok(!logged.includes(secret), `logs must not carry provider detail (${secret})`)
  }
}
pauseReadMode = 'state'

// ---------------------------------------------------------------------------
// 3. A later confirmed unpause processes the SAME pending job exactly once.
// ---------------------------------------------------------------------------
mark = snapshot()
result = await run()
seen = since(mark)
assert.deepEqual(
  { confirmed: result.confirmed, deferred: result.deferred, skipped: result.skipped, failed: result.failed },
  { confirmed: 1, deferred: 0, skipped: 0, failed: 0 },
)
assert.equal(seen.writes.length, 1, 'exactly one broadcast after the unpause')
assert.equal(seen.writes[0].paymentKey, job.paymentKey, 'the same pending job is processed')
assert.equal(await statusOf(job.paymentKey), 'confirmed')
result = await run()
assert.equal(result.processed, 0)
assert.equal(writes.length, 1, 'no duplicate submission on later passes')

// ---------------------------------------------------------------------------
// 4. Pause racing between two RPC reads: all decision reads share one block, so a
//    pause landing after the pause read cannot become a permanent daily-cap skip.
// ---------------------------------------------------------------------------
const raced = await seedPendingJob()
const decisionBlock = latest
finalized = latest
afterPausedRead = () => { pushState({ paused: true }) } // chain pauses right after the pause read
mark = snapshot()
result = await run()
afterPausedRead = null
seen = since(mark)
const pausedReadAt = seen.reads.find((read) => read.functionName === 'paused').blockNumber
assert.equal(pausedReadAt, decisionBlock)
for (const read of seen.reads.filter((entry) => QUOTA_READS.includes(entry.functionName))) {
  assert.equal(read.blockNumber, pausedReadAt, `${read.functionName} must read the same block as the pause check`)
}
assert.deepEqual(
  { deferred: result.deferred, skipped: result.skipped, confirmed: result.confirmed },
  { deferred: 1, skipped: 0, confirmed: 0 },
  'a racing pause must defer, not become daily_cap_exceeded',
)
assert.equal(seen.writes.length, 0)
assert.equal(await statusOf(raced.paymentKey), 'pending')
assert.equal((await pendingRecord(raced.paymentKey))?.attempts, 0)
pushState({ paused: false })
finalized = latest
result = await run()
assert.equal(result.confirmed, 1)
assert.equal(await statusOf(raced.paymentKey), 'confirmed')
assert.equal(writes.length, 2)

// ---------------------------------------------------------------------------
// 5. Existing behavior is preserved while the service runs.
// ---------------------------------------------------------------------------
// 5a. Real cap exhaustion is still a permanent daily_cap_exceeded skip.
const capped = await seedPendingJob()
pushState({ paused: false, remaining: 100_000n })
finalized = latest
const writesBeforeCap = writes.length
result = await run()
assert.deepEqual({ skipped: result.skipped, deferred: result.deferred, confirmed: result.confirmed }, { skipped: 1, deferred: 0, confirmed: 0 })
assert.equal(await statusOf(capped.paymentKey), 'skipped')
assert.equal(writes.length, writesBeforeCap)
const skipReasonOf = async (paymentKey) =>
  (await getDb().query('SELECT skip_reason FROM roundup_jobs WHERE payment_key = $1', [paymentKey])).rows[0]?.skip_reason
assert.equal(await skipReasonOf(capped.paymentKey), 'daily_cap_exceeded')
pushState({ paused: false, remaining: 5_000_000n })
finalized = latest

// 5b. A personal user pause still skips as user_paused while the service runs.
const personal = await seedPendingJob()
userPaused = true
result = await run()
assert.deepEqual({ skipped: result.skipped, deferred: result.deferred }, { skipped: 1, deferred: 0 })
assert.equal(await statusOf(personal.paymentKey), 'skipped')
assert.equal(await skipReasonOf(personal.paymentKey), 'user_paused')

// 5c. With the service paused, even a personally paused user's job waits; it is judged once
//     the service runs again and is then skipped by the unchanged personal policy.
const both = await seedPendingJob()
pushState({ paused: true })
finalized = latest
result = await run()
assert.deepEqual({ deferred: result.deferred, skipped: result.skipped }, { deferred: 1, skipped: 0 })
assert.equal(await statusOf(both.paymentKey), 'pending')
pushState({ paused: false })
finalized = latest
result = await run()
assert.deepEqual({ skipped: result.skipped, deferred: result.deferred }, { skipped: 1, deferred: 0 })
assert.equal(await statusOf(both.paymentKey), 'skipped')
assert.equal(await skipReasonOf(both.paymentKey), 'user_paused')
userPaused = false

assert.equal(writes.length, 2, 'only the two confirmed jobs ever reached the injected signer')

// 6. A mined success without the exact finalized RoundupExecuted event stays
//    submitted through recovery and can never trigger a second transfer.
const unattested = await seedPendingJob()
nextRoundupReceiptMode = 'missing-event'
mark = snapshot()
result = await run()
seen = since(mark)
assert.deepEqual(
  { deferred: result.deferred, confirmed: result.confirmed, failed: result.failed },
  { deferred: 1, confirmed: 0, failed: 0 },
)
assert.equal(await statusOf(unattested.paymentKey), 'submitted')
assert.equal(seen.writes.length, 1)
const submittedCount = writes.length
mark = snapshot()
result = await run()
seen = since(mark)
assert.deepEqual(
  { deferred: result.deferred, confirmed: result.confirmed, failed: result.failed },
  { deferred: 1, confirmed: 0, failed: 0 },
  'recovery must require the same event attestation as a fresh receipt',
)
assert.equal(await statusOf(unattested.paymentKey), 'submitted')
assert.equal(seen.writes.length, 0, 'an unattested submitted job is never broadcast again')
assert.equal(writes.length, submittedCount)

// 7. The replay-flag shortcut also requires an exact event from the contract.
const alreadyProcessed = await seedPendingJob()
const alreadyProcessedJob = await pendingRecord(alreadyProcessed.paymentKey)
const priorExecutedWrite = {
  paymentKey: alreadyProcessedJob.paymentKey,
  wallet: alreadyProcessedJob.wallet,
  destination: alreadyProcessedJob.destination,
  paymentTxHash: alreadyProcessedJob.paymentTxHash,
  canonicalLogIndex: alreadyProcessedJob.canonicalLogIndex,
  paymentAmount6: BigInt(alreadyProcessedJob.paymentAmount6),
  hash: `0x${randomBytes(32).toString('hex')}`,
}
priorExecutedWrite.receipt = makeRoundupReceipt(priorExecutedWrite)
priorRoundupWrites.push(priorExecutedWrite)
mark = snapshot()
result = await run()
seen = since(mark)
assert.deepEqual({ confirmed: result.confirmed, deferred: result.deferred }, { confirmed: 1, deferred: 1 },
  'one earlier quarantined receipt remains deferred while this verified replay is confirmed')
assert.equal(await statusOf(alreadyProcessed.paymentKey), 'confirmed')
assert.equal((await getDb().query('SELECT relayer_tx_hash FROM roundup_jobs WHERE payment_key = $1', [alreadyProcessed.paymentKey])).rows[0]?.relayer_tx_hash,
  priorExecutedWrite.hash)
assert.equal(seen.writes.length, 0, 'the verified replay shortcut must not submit a duplicate')

const processedButUnattested = await seedPendingJob()
const processedButUnattestedJob = await pendingRecord(processedButUnattested.paymentKey)
const priorUnattestedWrite = {
  paymentKey: processedButUnattestedJob.paymentKey,
  wallet: processedButUnattestedJob.wallet,
  destination: processedButUnattestedJob.destination,
  paymentTxHash: processedButUnattestedJob.paymentTxHash,
  canonicalLogIndex: processedButUnattestedJob.canonicalLogIndex,
  paymentAmount6: BigInt(processedButUnattestedJob.paymentAmount6),
  hash: `0x${randomBytes(32).toString('hex')}`,
}
nextRoundupReceiptMode = 'missing-event'
priorUnattestedWrite.receipt = makeRoundupReceipt(priorUnattestedWrite)
nextRoundupReceiptMode = 'valid'
priorRoundupWrites.push(priorUnattestedWrite)
mark = snapshot()
result = await run()
seen = since(mark)
assert.deepEqual({ confirmed: result.confirmed, deferred: result.deferred }, { confirmed: 0, deferred: 2 },
  'both quarantined jobs remain deferred without a new broadcast')
assert.equal(await statusOf(processedButUnattested.paymentKey), 'pending')
assert.equal(seen.writes.length, 0, 'an unattested processed key must not be rebroadcast')

console.log('Relayer global-pause and receipt-attestation regressions passed: pause defers safely, only finalized matching events confirm, and uncertain jobs never rebroadcast')
