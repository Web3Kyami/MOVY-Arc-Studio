import { ACTIVE_NETWORK_LABEL } from './chain'

export interface TransactionReceiptLike {
  status: string
}

export function isEnrollmentSyncReliable(
  onchainConfig: { enrolled: boolean; paused: boolean; configEpoch: number } | null | undefined,
  backendEnrollment: { status?: unknown; wallet?: unknown; chainId?: unknown; configEpoch?: unknown } | null | undefined,
  wallet: string | undefined,
  chainId: number
): boolean {
  if (!onchainConfig?.enrolled || !backendEnrollment || !wallet) return false
  const expectedStatus = onchainConfig.paused ? 'paused' : 'active'
  return backendEnrollment.status === expectedStatus &&
    typeof backendEnrollment.wallet === 'string' && backendEnrollment.wallet.toLowerCase() === wallet.toLowerCase() &&
    backendEnrollment.chainId === chainId && backendEnrollment.configEpoch === onchainConfig.configEpoch
}

export function isRevocationSyncReliable(
  onchainConfig: { enrolled: boolean; configEpoch: number } | null | undefined,
  backendEnrollment: { status?: unknown; wallet?: unknown; chainId?: unknown; configEpoch?: unknown } | null | undefined,
  wallet: string | undefined,
  chainId: number
): boolean {
  return Boolean(onchainConfig && !onchainConfig.enrolled && backendEnrollment && wallet) &&
    backendEnrollment?.status === 'revoked' &&
    typeof backendEnrollment.wallet === 'string' && backendEnrollment.wallet.toLowerCase() === wallet?.toLowerCase() &&
    backendEnrollment.chainId === chainId && backendEnrollment.configEpoch === onchainConfig?.configEpoch
}

export class TransactionReceiptError extends Error {
  readonly transactionHash: string

  constructor(transactionHash: string) {
    super(`The ${ACTIVE_NETWORK_LABEL} transaction reverted and was not confirmed.`)
    this.name = 'TransactionReceiptError'
    this.transactionHash = transactionHash
  }
}

export async function waitForSuccessfulReceipt<T extends TransactionReceiptLike>(
  transactionHash: string,
  waitForReceipt: (hash: string) => Promise<T>
): Promise<T> {
  const receipt = await waitForReceipt(transactionHash)
  if (receipt.status !== 'success') throw new TransactionReceiptError(transactionHash)
  return receipt
}

export class EnrollmentBackendSyncError extends Error {
  readonly retryable: boolean
  readonly status: number | null
  readonly transactionHash: string | null

  constructor(message: string, options: { retryable: boolean; status?: number | null; transactionHash?: string | null }) {
    super(message)
    this.name = 'EnrollmentBackendSyncError'
    this.retryable = options.retryable
    this.status = options.status ?? null
    this.transactionHash = options.transactionHash ?? null
  }
}

interface EnrollmentSyncResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

interface EnrollmentResponseBody {
  success?: unknown
  enrollment?: { status?: unknown } | null
}

export async function syncEnrollmentWithRetry<T extends { status?: unknown }>(
  sync: () => Promise<EnrollmentSyncResponse>,
  options: {
    attempts?: number
    delay?: (attempt: number) => Promise<void>
    allowedStatuses?: Array<'active' | 'paused' | 'revoked'>
  } = {}
): Promise<T> {
  const attempts = options.attempts ?? 3
  const delay = options.delay ?? ((attempt) => new Promise<void>((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1))))
  const allowedStatuses = options.allowedStatuses ?? ['active', 'paused']
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new RangeError('Enrollment sync attempts must be an integer from 1 to 5')
  }

  let lastError: EnrollmentBackendSyncError | null = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await sync()
      if (!response.ok) {
        const retryable = response.status === 409 || response.status === 429 || response.status >= 500
        lastError = new EnrollmentBackendSyncError(
          retryable
            ? `${ACTIVE_NETWORK_LABEL} confirmed enrollment, but MOVY has not synchronized it yet.`
            : 'MOVY rejected the enrollment synchronization request.',
          { retryable, status: response.status }
        )
      } else {
        const body = await response.json() as EnrollmentResponseBody
        const enrollment = body?.enrollment
        if (body?.success === true && enrollment && allowedStatuses.includes(enrollment.status as 'active' | 'paused' | 'revoked')) {
          return enrollment as T
        }
        lastError = new EnrollmentBackendSyncError(
          'MOVY could not verify an active enrollment record.',
          { retryable: true, status: response.status }
        )
      }
    } catch (error) {
      if (error instanceof EnrollmentBackendSyncError) {
        lastError = error
      } else {
        lastError = new EnrollmentBackendSyncError(
          `${ACTIVE_NETWORK_LABEL} confirmed enrollment, but MOVY could not be reached to synchronize it.`,
          { retryable: true }
        )
      }
    }

    if (!lastError.retryable || attempt === attempts) throw lastError
    await delay(attempt)
  }

  throw lastError ?? new EnrollmentBackendSyncError('MOVY enrollment sync failed.', { retryable: true })
}
