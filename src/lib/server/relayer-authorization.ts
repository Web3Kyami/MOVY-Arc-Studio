import {
  getCursor,
  getEnrollmentHistoryAtPosition,
  getEnrollmentHistoryCursor,
  getPaymentHistoryReplay,
  type RoundupJobRecord,
} from './db'
import { decidePaymentAuthorization } from './payment-authorization'

export type PendingJobAuthorization =
  | { status: 'ready' }
  | { status: 'deferred'; reason: 'payment_history_replay_incomplete' | 'payment_history_not_indexed' | 'payment_scan_not_caught_up' }
  | { status: 'skip'; reason: string }

/**
 * Fail closed before a pending roundup reaches the relayer. Existing jobs from
 * a pre-history-indexer database are not trusted until both migration replay
 * and the event/payment cursors cover their exact payment position.
 */
export async function authorizePendingJobForSubmission(
  chainId: number,
  job: RoundupJobRecord
): Promise<PendingJobAuthorization> {
  if (await getPaymentHistoryReplay(chainId)) {
    return { status: 'deferred', reason: 'payment_history_replay_incomplete' }
  }

  const paymentBlock = job.paymentBlockNumber
  const paymentLogIndex = job.canonicalLogIndex
  if (
    paymentBlock === undefined || !Number.isSafeInteger(paymentBlock) || paymentBlock < 0 ||
    paymentLogIndex === undefined || !Number.isSafeInteger(paymentLogIndex) || paymentLogIndex < 0
  ) {
    return { status: 'skip', reason: 'payment_history_missing' }
  }

  const historyCursor = await getEnrollmentHistoryCursor(chainId)
  if (historyCursor === null || historyCursor < paymentBlock) {
    return { status: 'deferred', reason: 'payment_history_not_indexed' }
  }

  const paymentCursor = await getCursor(chainId)
  if (paymentCursor === null || paymentCursor < paymentBlock) {
    return { status: 'deferred', reason: 'payment_scan_not_caught_up' }
  }

  if (job.paymentIsEligible !== 1 && job.paymentIsEligible !== true) {
    return { status: 'skip', reason: 'payment_not_eligible' }
  }

  const historicalEnrollment = await getEnrollmentHistoryAtPosition(
    chainId,
    job.wallet,
    paymentBlock,
    paymentLogIndex
  )
  const decision = decidePaymentAuthorization(historicalEnrollment, BigInt(job.roundupAmount6))
  if (!decision.authorized) return { status: 'skip', reason: decision.reason }

  if (decision.enrollment.destination.toLowerCase() !== job.destination.toLowerCase()) {
    return { status: 'skip', reason: 'historical_destination_mismatch' }
  }
  if (decision.enrollment.configEpoch !== job.configEpoch) {
    return { status: 'skip', reason: 'historical_config_epoch_mismatch' }
  }

  return { status: 'ready' }
}
