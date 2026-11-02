import {
  parseAbiItem,
  parseEventLogs,
  type Address,
  type Hash,
  type Log,
  type TransactionReceipt,
} from 'viem'
import { calculateRoundup6 } from '../money'
import { MAX_WORKER_BLOCKS } from './worker-limits'

export const ROUNDUP_EXECUTED_EVENT = parseAbiItem(
  'event RoundupExecuted(bytes32 indexed paymentKey, address indexed wallet, address indexed destination, uint64 paymentAmount6, uint64 roundupAmount6, bytes32 paymentTxHash, uint256 canonicalLogIndex)',
)

const ROUNDUP_EXECUTED_ABI = [ROUNDUP_EXECUTED_EVENT] as const

export type RoundupEventExpectation = {
  paymentKey: Hash
  wallet: Address
  destination: Address
  paymentAmount6: bigint
  roundupAmount6: bigint
  paymentTxHash: Hash
  canonicalLogIndex: bigint
}

export function getVerifiedRoundupEvent(
  logs: Log[],
  autoSaverAddress: Address,
  expected: RoundupEventExpectation,
): Log | null {
  if (
    !/^0x[0-9a-f]{64}$/i.test(expected.paymentKey) ||
    !/^0x[0-9a-f]{64}$/i.test(expected.paymentTxHash) ||
    !Number.isSafeInteger(Number(expected.canonicalLogIndex)) || expected.canonicalLogIndex < 0n ||
    expected.paymentAmount6 <= 0n || expected.roundupAmount6 <= 0n ||
    calculateRoundup6(expected.paymentAmount6) !== expected.roundupAmount6
  ) return null

  let events
  try {
    events = parseEventLogs({
      abi: ROUNDUP_EXECUTED_ABI,
      logs,
      eventName: 'RoundupExecuted',
      strict: false,
    })
  } catch {
    return null
  }

  const emittedByAutoSaver = events.filter((log) =>
    log.address.toLowerCase() === autoSaverAddress.toLowerCase() &&
    log.args.paymentKey?.toLowerCase() === expected.paymentKey.toLowerCase()
  )
  if (emittedByAutoSaver.length !== 1) return null

  const event = emittedByAutoSaver[0]
  const args = event.args
  if (
    !args.paymentKey || !args.wallet || !args.destination || !args.paymentTxHash ||
    args.paymentKey.toLowerCase() !== expected.paymentKey.toLowerCase() ||
    args.wallet.toLowerCase() !== expected.wallet.toLowerCase() ||
    args.destination.toLowerCase() !== expected.destination.toLowerCase() ||
    args.paymentAmount6 !== expected.paymentAmount6 ||
    args.roundupAmount6 !== expected.roundupAmount6 ||
    args.paymentTxHash.toLowerCase() !== expected.paymentTxHash.toLowerCase() ||
    args.canonicalLogIndex !== expected.canonicalLogIndex
  ) return null

  return event
}

export async function findFinalizedRoundupEvent(input: {
  startBlock: bigint
  finalizedBlockNumber: bigint
  autoSaverAddress: Address
  expected: RoundupEventExpectation
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<Log[]>
  getCanonicalBlockHash: (blockNumber: bigint) => Promise<Hash | null>
}): Promise<Log | null> {
  if (input.startBlock < 0n || input.finalizedBlockNumber < input.startBlock) return null

  const windowSize = BigInt(MAX_WORKER_BLOCKS)
  for (let fromBlock = input.startBlock; fromBlock <= input.finalizedBlockNumber;) {
    const toBlock = fromBlock + windowSize - 1n < input.finalizedBlockNumber
      ? fromBlock + windowSize - 1n
      : input.finalizedBlockNumber
    const logs = await input.getLogs(fromBlock, toBlock)
    const event = getVerifiedRoundupEvent(logs, input.autoSaverAddress, input.expected)
    if (
      event && event.blockNumber !== null && event.blockNumber >= fromBlock && event.blockNumber <= toBlock &&
      event.blockHash && event.transactionHash
    ) {
      const canonicalBlockHash = await input.getCanonicalBlockHash(event.blockNumber)
      if (canonicalBlockHash && canonicalBlockHash.toLowerCase() === event.blockHash.toLowerCase()) return event
    }
    fromBlock = toBlock + 1n
  }

  return null
}

export type RoundupReceiptDecision =
  | { status: 'pending'; reason: 'receipt_hash_mismatch' | 'receipt_target_mismatch' | 'receipt_not_finalized' | 'receipt_not_canonical' | 'receipt_status_unknown' | 'roundup_event_mismatch' }
  | { status: 'confirmed' }
  | { status: 'failed'; reason: 'transaction_reverted' }

type RoundupReceipt = Pick<TransactionReceipt, 'status' | 'transactionHash' | 'blockNumber' | 'blockHash' | 'to' | 'logs'>

export async function validateRoundupReceipt(input: {
  receipt: RoundupReceipt
  expectedTxHash: Hash
  autoSaverAddress: Address
  expected: RoundupEventExpectation
  getFinalizedBlockNumber: () => Promise<bigint>
  getCanonicalBlockHash: (blockNumber: bigint) => Promise<Hash | null>
}): Promise<RoundupReceiptDecision> {
  const { receipt, expectedTxHash, autoSaverAddress, expected } = input
  if (receipt.transactionHash.toLowerCase() !== expectedTxHash.toLowerCase()) {
    return { status: 'pending', reason: 'receipt_hash_mismatch' }
  }
  if (receipt.to?.toLowerCase() !== autoSaverAddress.toLowerCase()) {
    return { status: 'pending', reason: 'receipt_target_mismatch' }
  }

  const finalizedBlockNumber = await input.getFinalizedBlockNumber()
  if (receipt.blockNumber > finalizedBlockNumber) {
    return { status: 'pending', reason: 'receipt_not_finalized' }
  }
  const canonicalBlockHash = await input.getCanonicalBlockHash(receipt.blockNumber)
  if (!canonicalBlockHash || canonicalBlockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return { status: 'pending', reason: 'receipt_not_canonical' }
  }

  if (receipt.status === 'reverted') return { status: 'failed', reason: 'transaction_reverted' }
  if (receipt.status !== 'success') return { status: 'pending', reason: 'receipt_status_unknown' }

  const event = getVerifiedRoundupEvent(receipt.logs, autoSaverAddress, expected)
  if (
    !event || !event.transactionHash || event.transactionHash.toLowerCase() !== expectedTxHash.toLowerCase() ||
    event.blockNumber !== receipt.blockNumber || !event.blockHash || event.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
  ) {
    return { status: 'pending', reason: 'roundup_event_mismatch' }
  }

  return { status: 'confirmed' }
}
