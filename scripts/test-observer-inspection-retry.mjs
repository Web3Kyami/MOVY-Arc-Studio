import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { keccak256, padHex, stringToHex } from 'viem'
import { getDeployBlock } from '../src/lib/server/config.ts'
import {
  getCursor,
  getDb,
  getPaymentHistoryReplay,
  getPendingJobs,
  saveObservedPayment,
  setCursor,
  setEnrollmentHistoryCursor,
  upsertEnrollmentHistoryState,
} from '../src/lib/server/db.ts'
import { computePaymentKey, processBlocks } from '../src/lib/server/observer.ts'

const chainId = 5042002
const deployBlock = getDeployBlock(chainId)
const replayEnd = deployBlock + 3
const wallet = '0x1111111111111111111111111111111111111111'
const destination = '0x2222222222222222222222222222222222222222'
const zeroAddress = '0x0000000000000000000000000000000000000000'
const merchants = [
  '0x3333333333333333333333333333333333333333',
  '0x4444444444444444444444444444444444444444',
  '0x5555555555555555555555555555555555555555',
  '0x6666666666666666666666666666666666666666',
]
const transferTopic = keccak256(stringToHex('Transfer(address,address,uint256)'))
const toQuantity = (value) => `0x${BigInt(value).toString(16)}`
const blockHash = (block) => `0x${BigInt(block).toString(16).padStart(64, '0')}`
const txHashes = merchants.map((_, index) => `0x${(index + 1).toString(16).padStart(64, '0')}`)
const amount18 = 1_010_000_000_000_000_000n
const transactionInputs = new Map()
const receiptStatuses = new Map()
const transactionCalls = new Map()
const receiptCalls = new Map()
const makeLog = (index, blockNumber, transactionHash = txHashes[index], options = {}) => {
  const from = options.from ?? wallet
  const merchant = options.to ?? merchants[index]
  const value = options.value ?? amount18
  return {
    address: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE',
    topics: [
      transferTopic,
      padHex(from, { size: 32 }),
      padHex(merchant, { size: 32 }),
    ],
    data: padHex(toQuantity(value), { size: 32 }),
    blockNumber: toQuantity(blockNumber),
    transactionHash,
    transactionIndex: '0x0',
    blockHash: blockHash(blockNumber),
    logIndex: '0x1',
    removed: false,
  }
}
const logs = [0, 1, 2].map((index) => makeLog(index, deployBlock + index + 1))
const transactionRpcFailures = new Set()
const receiptRpcFailures = new Set()
const failureCounts = new Map()
let currentBlock = replayEnd

const rpcTransaction = (hash) => {
  const index = txHashes.indexOf(hash)
  const log = logs[index]
  const blockNumber = BigInt(log.blockNumber)
  const from = `0x${log.topics[1].slice(-40)}`
  const to = `0x${log.topics[2].slice(-40)}`
  return {
    hash,
    nonce: toQuantity(index),
    blockHash: blockHash(blockNumber),
    blockNumber: toQuantity(blockNumber),
    transactionIndex: '0x0',
    from,
    to,
    value: toQuantity(BigInt(log.data)),
    gas: '0x5208',
    gasPrice: '0x1',
    input: transactionInputs.get(hash) ?? '0x',
    v: '0x1b',
    r: `0x${'1'.padStart(64, '0')}`,
    s: `0x${'2'.padStart(64, '0')}`,
    type: '0x0',
    chainId: toQuantity(chainId),
  }
}

const rpcReceipt = (hash) => {
  const index = txHashes.indexOf(hash)
  const log = logs[index]
  const blockNumber = BigInt(log.blockNumber)
  const from = `0x${log.topics[1].slice(-40)}`
  const to = `0x${log.topics[2].slice(-40)}`
  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: blockHash(blockNumber),
    blockNumber: toQuantity(blockNumber),
    from,
    to,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logs: [log],
    logsBloom: `0x${'0'.repeat(512)}`,
    status: receiptStatuses.get(hash) ?? '0x1',
    type: '0x0',
  }
}

const respondToRpc = (request) => {
  const { id, method, params = [] } = request
  let result
  if (method === 'eth_chainId') {
    result = toQuantity(chainId)
  } else if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') {
    result = { number: toQuantity(currentBlock) }
  } else if (method === 'eth_blockNumber') {
    result = toQuantity(currentBlock)
  } else if (method === 'eth_getLogs') {
    const filter = params[0]
    const fromBlock = BigInt(filter.fromBlock)
    const toBlock = BigInt(filter.toBlock)
    result = logs.filter((log) => BigInt(log.blockNumber) >= fromBlock && BigInt(log.blockNumber) <= toBlock)
  } else if (method === 'eth_getTransactionByHash') {
    const hash = params[0].toLowerCase()
    transactionCalls.set(hash, (transactionCalls.get(hash) ?? 0) + 1)
    if (transactionRpcFailures.has(hash)) {
      failureCounts.set(hash, (failureCounts.get(hash) ?? 0) + 1)
      return { jsonrpc: '2.0', id, error: { code: -32000, message: 'temporary Arc RPC failure' } }
    }
    result = rpcTransaction(hash)
  } else if (method === 'eth_getTransactionReceipt') {
    const hash = params[0].toLowerCase()
    receiptCalls.set(hash, (receiptCalls.get(hash) ?? 0) + 1)
    if (receiptRpcFailures.has(hash)) {
      failureCounts.set(hash, (failureCounts.get(hash) ?? 0) + 1)
      return { jsonrpc: '2.0', id, error: { code: -32000, message: 'temporary Arc RPC failure' } }
    }
    result = rpcReceipt(hash)
  } else {
    throw new Error(`Unexpected JSON-RPC method ${method}`)
  }
  return { jsonrpc: '2.0', id, result }
}

const server = createServer(async (request, response) => {
  let requestBody = ''
  for await (const chunk of request) requestBody += chunk
  const payload = JSON.parse(requestBody)
  const batch = Array.isArray(payload)
  const results = (batch ? payload : [payload]).map(respondToRpc)
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(batch ? results : results[0]))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
process.env.ARC_TESTNET_RPC_URL = `http://127.0.0.1:${address.port}`
process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC_URL

const paymentKeys = txHashes.map((hash) => computePaymentKey(chainId, hash, 1, wallet))
const now = new Date().toISOString()
await upsertEnrollmentHistoryState({
  chainId,
  wallet,
  blockNumber: deployBlock,
  logIndex: 0,
  destination,
  maxRoundup6: '1000000',
  dailyCap6: '5000000',
  configEpoch: 1,
  status: 'active',
})
await setEnrollmentHistoryCursor(chainId, replayEnd)
// Model a legacy database whose normal cursor is already past this replay range.
await setCursor(chainId, replayEnd)
await saveObservedPayment({
  paymentKey: paymentKeys[2],
  chainId,
  txHash: txHashes[2],
  logIndex: 1,
  blockNumber: deployBlock + 3,
  payer: wallet,
  recipient: merchants[2],
  amount6: '1010000',
  roundup6: '0',
  isEligible: false,
  exclusionReason: 'tx_inspection_failed',
  createdAt: now,
})

try {
  // Fail every retry of the second transfer's transaction lookup. The first
  // transfer has already been inspected and queued in this same window.
  transactionRpcFailures.add(txHashes[1])
  await assert.rejects(
    () => processBlocks(chainId, { maxBlocks: 100 }),
    /Observer transaction inspection incomplete/
  )
  assert.ok((failureCounts.get(txHashes[1]) ?? 0) >= 1)
  assert.equal(await getCursor(chainId), replayEnd, 'A failed replay must preserve the monotonic normal payment cursor')
  assert.deepEqual({ ...await getPaymentHistoryReplay(chainId) }, {
    chainId,
    nextBlock: deployBlock,
    targetBlock: replayEnd,
  }, 'A failed replay must not advance beyond the unverified transfer')
  assert.equal((await getPendingJobs(chainId, 20)).length, 1, 'The earlier verified payment remains safely queued once')
  assert.equal(
    (await getDb().query('SELECT 1 FROM observed_payments WHERE payment_key = $1', [paymentKeys[1]])).rows[0],
    undefined,
    'The unverified transfer must not be persisted as terminally ineligible'
  )

  transactionRpcFailures.delete(txHashes[1])
  await processBlocks(chainId, { maxBlocks: 100 })
  assert.equal(await getPaymentHistoryReplay(chainId), null, 'A recovered replay advances only after all transfers are verified')
  assert.equal((await getPendingJobs(chainId, 20)).length, 3, 'Recovery queues each eligible payment exactly once')
  assert.equal(
    Number((await getDb().query('SELECT COUNT(*) AS count FROM roundup_jobs')).rows[0].count),
    3,
    'Reprocessing earlier successful transfers does not create duplicate jobs'
  )
  const repairedLegacyObservation = (await getDb().query(`
    SELECT is_eligible AS "isEligible", exclusion_reason AS "exclusionReason", roundup_6 AS "roundup6"
    FROM observed_payments WHERE payment_key = $1
  `, [paymentKeys[2]])).rows[0]
  assert.deepEqual({ ...repairedLegacyObservation }, {
    isEligible: true,
    exclusionReason: null,
    roundup6: '990000',
  }, 'Successful replay repairs legacy tx_inspection_failed observations')

  // The same fail-closed behavior applies to the regular cursor after replay
  // has completed, including receipt lookup failures.
  const normalBlock = replayEnd + 1
  txHashes[3] = `0x${'9'.repeat(64)}`
  paymentKeys[3] = computePaymentKey(chainId, txHashes[3], 1, wallet)
  logs.push(makeLog(3, normalBlock, txHashes[3]))
  currentBlock = normalBlock
  await setEnrollmentHistoryCursor(chainId, normalBlock)
  receiptRpcFailures.add(txHashes[3])
  await assert.rejects(
    () => processBlocks(chainId, { maxBlocks: 100 }),
    /Observer receipt inspection incomplete/
  )
  assert.equal(await getCursor(chainId), replayEnd, 'A failed normal scan must preserve its cursor')
  assert.equal(
    (await getDb().query('SELECT 1 FROM observed_payments WHERE payment_key = $1', [paymentKeys[3]])).rows[0],
    undefined,
    'A failed receipt lookup must not create an ineligible observation'
  )

  receiptRpcFailures.delete(txHashes[3])
  await processBlocks(chainId, { maxBlocks: 100 })
  assert.equal(await getCursor(chainId), normalBlock)
  assert.equal((await getPendingJobs(chainId, 20)).length, 4, 'Recovered normal scans create one job without duplicates')
  assert.equal(Number((await getDb().query('SELECT COUNT(*) AS count FROM roundup_jobs')).rows[0].count), 4)

  const deterministicCases = [
    { reason: 'self_transfer', to: wallet },
    { reason: 'burn', to: zeroAddress },
    { reason: 'savings_destination', to: destination },
    { reason: 'whole_dollar', to: merchants[0], value: 1_000_000_000_000_000_000n },
    { reason: 'unsupported_contract_interaction', to: merchants[1], input: '0xdeadbeef' },
    { reason: 'reverted_transaction', to: merchants[2], receiptStatus: '0x0' },
  ]
  const deterministicStart = normalBlock + 1
  const deterministicEntries = deterministicCases.map((testCase, index) => {
    const logIndex = txHashes.length
    const hash = `0x${(logIndex + 1).toString(16).padStart(64, '0')}`
    txHashes.push(hash)
    const block = deterministicStart + index
    logs.push(makeLog(logIndex, block, hash, { to: testCase.to, value: testCase.value }))
    if (testCase.input) transactionInputs.set(hash, testCase.input)
    if (testCase.receiptStatus) receiptStatuses.set(hash, testCase.receiptStatus)
    return {
      ...testCase,
      hash,
      paymentKey: computePaymentKey(chainId, hash, 1, wallet),
      block,
    }
  })
  const deterministicEnd = deterministicStart + deterministicCases.length - 1
  currentBlock = deterministicEnd
  await setEnrollmentHistoryCursor(chainId, deterministicEnd)
  await processBlocks(chainId, { maxBlocks: 100 })
  assert.equal(await getCursor(chainId), deterministicEnd, 'Deterministic exclusions must not stall the normal cursor')
  assert.equal((await getPendingJobs(chainId, 20)).length, 4, 'Deterministic exclusions must not create round-up jobs')
  assert.equal(Number((await getDb().query('SELECT COUNT(*) AS count FROM roundup_jobs')).rows[0].count), 4)

  for (const entry of deterministicEntries) {
    const observation = (await getDb().query(`
      SELECT is_eligible AS "isEligible", exclusion_reason AS "exclusionReason", roundup_6 AS "roundup6"
      FROM observed_payments WHERE payment_key = $1
    `, [entry.paymentKey])).rows[0]
    if (entry.reason === 'whole_dollar') {
      assert.deepEqual({ ...observation }, { isEligible: true, exclusionReason: null, roundup6: '0' })
    } else {
      assert.deepEqual({ ...observation }, { isEligible: false, exclusionReason: entry.reason, roundup6: '0' })
    }
  }
  assert.equal(transactionCalls.get(deterministicEntries[0].hash) ?? 0, 0, 'Self-payments are excluded without RPC inspection')
  assert.equal(transactionCalls.get(deterministicEntries[1].hash) ?? 0, 0, 'Burns are excluded without RPC inspection')
  assert.equal(transactionCalls.get(deterministicEntries[2].hash) ?? 0, 0, 'Savings-destination transfers are excluded without RPC inspection')

  console.log('Observer transaction-inspection retry and cursor recovery tests passed')
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
