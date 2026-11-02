import type { EnrollmentHistoryState, PaymentHistoryReplay } from './db'

export interface PaymentScanWindowInput {
  deployBlock: number
  currentBlock: number
  historyCursor: number | null
  paymentCursor: number | null
  replay: PaymentHistoryReplay | null
  maxBlocks: number
}

export interface PaymentScanWindow {
  fromBlock: number
  toBlock: number
  mode: 'replay' | 'normal'
}

export function resolvePaymentScanWindow(input: PaymentScanWindowInput): PaymentScanWindow | null {
  const { deployBlock, currentBlock, historyCursor, paymentCursor, replay, maxBlocks } = input
  if (historyCursor === null || historyCursor < deployBlock || currentBlock < deployBlock) return null

  const mode = replay ? 'replay' : 'normal'
  const fromBlock = replay
    ? replay.nextBlock
    : paymentCursor === null || paymentCursor < deployBlock
    ? deployBlock
    : paymentCursor + 1
  const endLimit = replay ? replay.targetBlock : Number.POSITIVE_INFINITY
  const toBlock = Math.min(fromBlock + maxBlocks - 1, endLimit, historyCursor, currentBlock)
  return fromBlock <= toBlock ? { fromBlock, toBlock, mode } : null
}

export type PaymentAuthorizationDecision =
  | { authorized: true; enrollment: EnrollmentHistoryState }
  | { authorized: false; reason: 'not_enrolled_at_payment' | 'paused_at_payment' | 'revoked_at_payment' | 'roundup_exceeds_historical_cap' }

export function decidePaymentAuthorization(
  enrollment: EnrollmentHistoryState | null,
  roundup6: bigint
): PaymentAuthorizationDecision {
  if (!enrollment) return { authorized: false, reason: 'not_enrolled_at_payment' }
  if (enrollment.status === 'paused') return { authorized: false, reason: 'paused_at_payment' }
  if (enrollment.status === 'revoked') return { authorized: false, reason: 'revoked_at_payment' }
  if (roundup6 > BigInt(enrollment.maxRoundup6)) {
    return { authorized: false, reason: 'roundup_exceeds_historical_cap' }
  }
  return { authorized: true, enrollment }
}
