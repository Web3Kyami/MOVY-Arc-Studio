import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseAbiParameters,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { CANONICAL_ARC_USDC, SYSTEM_USDC_EMITTER } from './config'
import { calculateRoundup6 } from '../money'

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const ERC20_TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])
const NATIVE_TO_ERC20_SCALE = 1_000_000_000_000n

export interface PaymentTransferLog {
  address: string
  topics: readonly string[]
  data: string
  logIndex: bigint | number | null
  blockNumber: bigint | number | null
  blockHash: string | null
  transactionHash: string | null
}

export interface PaymentTransactionLike {
  hash: string
  from: string
  to: string | null
  value: bigint
  input: string
  blockNumber: bigint | null
  blockHash: string | null
}

export interface PaymentReceiptLike {
  status: 'success' | 'reverted'
  transactionHash: string
  blockNumber: bigint
  blockHash: string
  logs: readonly PaymentTransferLog[]
}

export interface RelayerPaymentJobLike {
  paymentKey: string
  chainId: number
  wallet: string
  destination: string
  roundupAmount6: string
  paymentTxHash?: string
  canonicalLogIndex?: number
  paymentAmount6?: string
  paymentRecipient?: string
  paymentBlockNumber?: number
  paymentIsEligible?: number | boolean
}

export type PaymentEvidenceResult =
  | { status: 'valid'; paymentAmount6: bigint; recipient: Address; transferLog: PaymentTransferLog }
  | { status: 'deferred'; reason: string }
  | { status: 'invalid'; reason: string }

function decodeTransfer(log: PaymentTransferLog): { from: Address; to: Address; value: bigint } | null {
  if (log.address.toLowerCase() !== SYSTEM_USDC_EMITTER.toLowerCase()) return null
  try {
    const decoded = decodeEventLog({
      abi: [TRANSFER_EVENT],
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    })
    if (decoded.eventName !== 'Transfer') return null
    return { from: decoded.args.from, to: decoded.args.to, value: decoded.args.value }
  } catch {
    return null
  }
}

export function sameObservedTransfer(
  observed: PaymentTransferLog,
  receiptLogs: readonly PaymentTransferLog[],
): boolean {
  if (
    observed.logIndex === null || observed.blockNumber === null || !observed.blockHash ||
    !observed.transactionHash
  ) return false
  const observedLogIndex = BigInt(observed.logIndex)
  const observedBlockNumber = BigInt(observed.blockNumber)
  return receiptLogs.some((candidate) =>
    candidate.address.toLowerCase() === observed.address.toLowerCase() &&
    candidate.logIndex !== null && BigInt(candidate.logIndex) === observedLogIndex &&
    candidate.blockNumber !== null && BigInt(candidate.blockNumber) === observedBlockNumber &&
    candidate.blockHash?.toLowerCase() === observed.blockHash?.toLowerCase() &&
    candidate.transactionHash?.toLowerCase() === observed.transactionHash?.toLowerCase() &&
    candidate.data.toLowerCase() === observed.data.toLowerCase() &&
    candidate.topics.length === observed.topics.length &&
    candidate.topics.every((topic, index) => topic.toLowerCase() === observed.topics[index]?.toLowerCase())
  )
}

/**
 * MOVY only accepts a direct native USDC transfer or a direct ERC-20 USDC
 * transfer. The transaction sender, recipient, amount, and system-emitter log
 * must all describe that same transfer.
 */
export function isSupportedDirectPayment(
  transaction: PaymentTransactionLike,
  transferLog: PaymentTransferLog,
): boolean {
  const transfer = decodeTransfer(transferLog)
  if (
    !transfer || transaction.from.toLowerCase() !== transfer.from.toLowerCase() ||
    !transferLog.transactionHash || transaction.hash.toLowerCase() !== transferLog.transactionHash.toLowerCase() ||
    transferLog.blockNumber === null || transaction.blockNumber === null ||
    BigInt(transferLog.blockNumber) !== transaction.blockNumber ||
    !transferLog.blockHash || !transaction.blockHash ||
    transferLog.blockHash.toLowerCase() !== transaction.blockHash.toLowerCase()
  ) return false
  if (transfer.value === 0n || transfer.value % NATIVE_TO_ERC20_SCALE !== 0n) return false
  const amount6 = transfer.value / NATIVE_TO_ERC20_SCALE

  if (transaction.input === '0x') {
    return transaction.to?.toLowerCase() === transfer.to.toLowerCase() && transaction.value === transfer.value
  }

  if (
    transaction.to?.toLowerCase() !== CANONICAL_ARC_USDC.toLowerCase() ||
    transaction.value !== 0n
  ) return false
  try {
    const decoded = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: transaction.input as Hex })
    return decoded.functionName === 'transfer' &&
      decoded.args[0].toLowerCase() === transfer.to.toLowerCase() &&
      decoded.args[1] === amount6
  } catch {
    return false
  }
}

export function validateFinalizedPaymentEvidence(input: {
  chainId: number
  finalizedBlockNumber: bigint
  canonicalBlockHash: string
  job: RelayerPaymentJobLike
  transaction: PaymentTransactionLike
  receipt: PaymentReceiptLike
}): PaymentEvidenceResult {
  const { chainId, finalizedBlockNumber, canonicalBlockHash, job, transaction, receipt } = input
  if (
    !Number.isSafeInteger(job.canonicalLogIndex) || job.canonicalLogIndex === undefined || job.canonicalLogIndex < 0 ||
    !Number.isSafeInteger(job.paymentBlockNumber) || job.paymentBlockNumber === undefined || job.paymentBlockNumber < 0 ||
    !job.paymentTxHash || !/^0x[0-9a-f]{64}$/i.test(job.paymentTxHash) ||
    !job.paymentAmount6 || !/^[0-9]+$/.test(job.paymentAmount6) ||
    !job.paymentRecipient ||
    (job.paymentIsEligible !== true && job.paymentIsEligible !== 1)
  ) return { status: 'invalid', reason: 'payment_evidence_missing_or_ineligible' }

  if (job.chainId !== chainId) return { status: 'invalid', reason: 'payment_chain_mismatch' }

  let amount6: bigint
  let roundup6: bigint
  try {
    amount6 = BigInt(job.paymentAmount6)
    roundup6 = BigInt(job.roundupAmount6)
  } catch {
    return { status: 'invalid', reason: 'payment_amount_invalid' }
  }
  if (amount6 <= 0n || amount6 > 0xffff_ffff_ffff_ffffn || roundup6 <= 0n) {
    return { status: 'invalid', reason: 'payment_amount_out_of_range' }
  }
  if (calculateRoundup6(amount6) !== roundup6) {
    return { status: 'invalid', reason: 'payment_roundup_mismatch' }
  }

  const txHash = job.paymentTxHash as Hash
  const wallet = job.wallet as Address
  const expectedPaymentKey = keccak256(encodeAbiParameters(
    parseAbiParameters('uint256, bytes32, uint256, address'),
    [BigInt(chainId), txHash, BigInt(job.canonicalLogIndex), wallet],
  ))
  if (job.paymentKey.toLowerCase() !== expectedPaymentKey.toLowerCase()) {
    return { status: 'invalid', reason: 'payment_key_mismatch' }
  }

  if (receipt.blockNumber > finalizedBlockNumber) {
    return { status: 'deferred', reason: 'payment_not_finalized' }
  }
  if (receipt.blockNumber !== BigInt(job.paymentBlockNumber)) {
    return { status: 'invalid', reason: 'payment_block_mismatch' }
  }
  if (receipt.blockHash.toLowerCase() !== canonicalBlockHash.toLowerCase()) {
    return { status: 'deferred', reason: 'payment_block_not_canonical' }
  }
  if (
    receipt.status !== 'success' ||
    receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() ||
    transaction.hash.toLowerCase() !== txHash.toLowerCase() ||
    transaction.blockNumber !== receipt.blockNumber ||
    transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    transaction.from.toLowerCase() !== wallet.toLowerCase()
  ) return { status: 'invalid', reason: 'payment_transaction_mismatch' }

  const transferLog = receipt.logs.find((log) => log.logIndex !== null && BigInt(log.logIndex) === BigInt(job.canonicalLogIndex!))
  const transfer = transferLog ? decodeTransfer(transferLog) : null
  if (!transferLog || !transfer) return { status: 'invalid', reason: 'payment_transfer_log_missing' }
  if (
    transferLog.blockNumber !== receipt.blockNumber ||
    transferLog.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    transferLog.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase()
  ) return { status: 'invalid', reason: 'payment_transfer_position_mismatch' }
  if (
    transfer.from.toLowerCase() !== wallet.toLowerCase() ||
    transfer.to.toLowerCase() !== job.paymentRecipient.toLowerCase() ||
    transfer.value / NATIVE_TO_ERC20_SCALE !== amount6 ||
    transfer.value % NATIVE_TO_ERC20_SCALE !== 0n
  ) return { status: 'invalid', reason: 'payment_transfer_values_mismatch' }
  if (!isSupportedDirectPayment(transaction, transferLog)) {
    return { status: 'invalid', reason: 'payment_not_a_direct_usdc_transfer' }
  }

  return { status: 'valid', paymentAmount6: amount6, recipient: transfer.to, transferLog }
}
