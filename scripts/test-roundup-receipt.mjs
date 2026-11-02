import assert from 'node:assert/strict'
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
} from 'viem'
import {
  findFinalizedRoundupEvent,
  getVerifiedRoundupEvent,
  validateRoundupReceipt,
} from '../src/lib/server/roundup-receipt.ts'

const eventAbi = parseAbiItem(
  'event RoundupExecuted(bytes32 indexed paymentKey, address indexed wallet, address indexed destination, uint64 paymentAmount6, uint64 roundupAmount6, bytes32 paymentTxHash, uint256 canonicalLogIndex)',
)
const contract = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const wallet = '0x1111111111111111111111111111111111111111'
const destination = '0x2222222222222222222222222222222222222222'
const paymentKey = `0x${'ab'.repeat(32)}`
const paymentTxHash = `0x${'cd'.repeat(32)}`
const relayerTxHash = `0x${'ef'.repeat(32)}`
const blockHash = `0x${'12'.repeat(32)}`
const expected = {
  paymentKey,
  wallet,
  destination,
  paymentAmount6: 170_000n,
  roundupAmount6: 830_000n,
  paymentTxHash,
  canonicalLogIndex: 4n,
}

function makeLog(values = expected, overrides = {}) {
  return {
    address: contract,
    blockHash,
    blockNumber: 100n,
    data: encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'uint256' }],
      [values.paymentAmount6, values.roundupAmount6, values.paymentTxHash, BigInt(values.canonicalLogIndex)],
    ),
    logIndex: 2,
    removed: false,
    topics: encodeEventTopics({
      abi: [eventAbi],
      eventName: 'RoundupExecuted',
      args: { paymentKey: values.paymentKey, wallet: values.wallet, destination: values.destination },
    }),
    transactionHash: relayerTxHash,
    transactionIndex: 0,
    ...overrides,
  }
}

assert.equal(getVerifiedRoundupEvent([makeLog()], contract, expected)?.transactionHash, relayerTxHash)
assert.equal(getVerifiedRoundupEvent([], contract, expected), null, 'A missing payout event cannot attest success')
assert.equal(getVerifiedRoundupEvent([makeLog(expected, { address: wallet })], contract, expected), null,
  'A matching signature from another emitter cannot attest the contract payout')

const mismatches = [
  ['paymentKey', `0x${'01'.repeat(32)}`],
  ['wallet', '0x3333333333333333333333333333333333333333'],
  ['destination', '0x4444444444444444444444444444444444444444'],
  ['paymentAmount6', 171_000n],
  ['roundupAmount6', 829_000n],
  ['paymentTxHash', `0x${'34'.repeat(32)}`],
  ['canonicalLogIndex', 5n],
]
for (const [field, value] of mismatches) {
  assert.equal(getVerifiedRoundupEvent([makeLog({ ...expected, [field]: value })], contract, expected), null,
    `Mismatched ${field} cannot attest success`)
}
assert.equal(getVerifiedRoundupEvent([makeLog(), makeLog()], contract, expected), null,
  'Duplicate payout events cannot attest a single roundup')

const scannedWindows = []
const historicalEvent = makeLog(expected, { blockNumber: 2_100n })
const unrelatedEvent = makeLog({ ...expected, paymentKey: `0x${'01'.repeat(32)}` }, { blockNumber: 2_101n })
const historicalMatch = await findFinalizedRoundupEvent({
  startBlock: 100n,
  finalizedBlockNumber: 2_505n,
  autoSaverAddress: contract,
  expected,
  getLogs: async (fromBlock, toBlock) => {
    scannedWindows.push([fromBlock, toBlock])
    return fromBlock <= 2_100n && toBlock >= 2_100n ? [unrelatedEvent, historicalEvent] : []
  },
  getCanonicalBlockHash: async (blockNumber) => blockNumber === 2_100n ? blockHash : null,
})
assert.equal(historicalMatch?.transactionHash, relayerTxHash)
assert.deepEqual(scannedWindows, [[100n, 1_099n], [1_100n, 2_099n], [2_100n, 2_505n]])
assert.ok(scannedWindows.every(([fromBlock, toBlock]) => toBlock - fromBlock + 1n <= 1_000n),
  'Every Arc RPC event query stays within the 1,000-block worker window')
assert.equal(await findFinalizedRoundupEvent({
  startBlock: 100n,
  finalizedBlockNumber: 100n,
  autoSaverAddress: contract,
  expected,
  getLogs: async () => [makeLog()],
  getCanonicalBlockHash: async () => `0x${'56'.repeat(32)}`,
}), null, 'A matching event in a noncanonical block cannot attest a processed roundup')

const baseReceipt = {
  status: 'success',
  transactionHash: relayerTxHash,
  blockNumber: 100n,
  blockHash,
  to: contract,
  logs: [makeLog()],
}
const baseValidation = {
  receipt: baseReceipt,
  expectedTxHash: relayerTxHash,
  autoSaverAddress: contract,
  expected,
  getFinalizedBlockNumber: async () => 100n,
  getCanonicalBlockHash: async () => blockHash,
}
assert.deepEqual(await validateRoundupReceipt(baseValidation), { status: 'confirmed' })
assert.deepEqual(await validateRoundupReceipt({
  ...baseValidation,
  receipt: { ...baseReceipt, logs: [] },
}), { status: 'pending', reason: 'roundup_event_mismatch' })
assert.deepEqual(await validateRoundupReceipt({
  ...baseValidation,
  receipt: { ...baseReceipt, blockNumber: 101n },
}), { status: 'pending', reason: 'receipt_not_finalized' })
assert.deepEqual(await validateRoundupReceipt({
  ...baseValidation,
  getCanonicalBlockHash: async () => `0x${'56'.repeat(32)}`,
}), { status: 'pending', reason: 'receipt_not_canonical' })
assert.deepEqual(await validateRoundupReceipt({
  ...baseValidation,
  receipt: { ...baseReceipt, status: 'reverted', logs: [] },
}), { status: 'failed', reason: 'transaction_reverted' })
assert.deepEqual(await validateRoundupReceipt({
  ...baseValidation,
  receipt: { ...baseReceipt, transactionHash: paymentTxHash },
}), { status: 'pending', reason: 'receipt_hash_mismatch' })
assert.deepEqual(await validateRoundupReceipt({
  ...baseValidation,
  receipt: { ...baseReceipt, to: wallet },
}), { status: 'pending', reason: 'receipt_target_mismatch' })
assert.deepEqual(await validateRoundupReceipt({
  ...baseValidation,
  receipt: { ...baseReceipt, logs: [makeLog(expected, { blockNumber: 99n })] },
}), { status: 'pending', reason: 'roundup_event_mismatch' })
assert.deepEqual(await validateRoundupReceipt({
  ...baseValidation,
  receipt: { ...baseReceipt, logs: [makeLog(expected, { transactionHash: paymentTxHash })] },
}), { status: 'pending', reason: 'roundup_event_mismatch' })

console.log('Roundup receipt event, identity, finality, and canonicality checks passed')
