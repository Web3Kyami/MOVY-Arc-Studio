import { EnrollmentBackendSyncError, TransactionReceiptError, waitForSuccessfulReceipt } from './enrollment-activation'
import { ACTIVE_CHAIN_ID, ACTIVE_NETWORK_LABEL } from './chain'
import { formatUsdc6 } from './money'

export interface WalletContextSnapshot {
  isConnected: boolean
  address?: string
  chainId?: number
}

type WalletTransactionReceipt = {
  status: string
  from: string
}

export type AllowanceReadState =
  | { status: 'ready' | 'preview'; allowance6: bigint }
  | { status: 'disconnected' | 'wrong-network' | 'loading' | 'error' }

export function parseUsdcAllowanceTarget(input: string): bigint | null {
  const match = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) return null

  const whole = BigInt(match[1])
  const cents = BigInt((match[2] ?? '').padEnd(2, '0'))
  const allowance6 = whole * 1_000_000n + cents * 10_000n
  return allowance6 <= (1n << 256n) - 1n ? allowance6 : null
}

export function formatUsdcAllowance(allowance6: bigint): string {
  return formatUsdc6(allowance6, 6)
}

export function resolveAllowanceReadState(input: {
  isDemoMode: boolean
  isConnected: boolean
  isWrongNetwork: boolean
  isLoading: boolean
  isError: boolean
  allowance6: bigint | null
  demoAllowance6: bigint
}): AllowanceReadState {
  if (input.isDemoMode) return { status: 'preview', allowance6: input.demoAllowance6 }
  if (!input.isConnected) return { status: 'disconnected' }
  if (input.isWrongNetwork) return { status: 'wrong-network' }
  if (input.isError) return { status: 'error' }
  if (input.isLoading || input.allowance6 === null) return { status: 'loading' }
  return { status: 'ready', allowance6: input.allowance6 }
}

export class PermissionContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionContextError'
  }
}

export class AllowanceReadError extends Error {
  readonly stage: 'before' | 'after'
  readonly transactionHash: string | null

  constructor(stage: 'before' | 'after', transactionHash?: string) {
    super(stage === 'before'
      ? `Could not verify the current ${ACTIVE_NETWORK_LABEL} USDC allowance. No approval was submitted.`
      : 'The approval transaction was confirmed, but MOVY could not verify the resulting USDC allowance. Its current value is unknown.')
    this.name = 'AllowanceReadError'
    this.stage = stage
    this.transactionHash = transactionHash ?? null
  }
}

export class AllowanceConfirmationError extends Error {
  readonly transactionHash: string

  constructor(transactionHash: string) {
    super(`The wallet request was submitted, but ${ACTIVE_NETWORK_LABEL} could not confirm its receipt. The USDC allowance status is unknown; check it before retrying.`)
    this.name = 'AllowanceConfirmationError'
    this.transactionHash = transactionHash
  }
}

export class AllowanceVerificationError extends Error {
  readonly transactionHash: string
  readonly expectedAllowance6: bigint
  readonly actualAllowance6: bigint

  constructor(transactionHash: string, expectedAllowance6: bigint, actualAllowance6: bigint) {
    super(`The ${ACTIVE_NETWORK_LABEL} transaction succeeded, but the onchain USDC allowance did not match the requested amount.`)
    this.name = 'AllowanceVerificationError'
    this.transactionHash = transactionHash
    this.expectedAllowance6 = expectedAllowance6
    this.actualAllowance6 = actualAllowance6
  }
}

export class EnrollmentRevocationVerificationError extends Error {
  readonly transactionHash: string

  constructor(transactionHash: string) {
    super('The enrollment revocation transaction was confirmed, but its onchain status could not be verified. The USDC token allowance was not changed.')
    this.name = 'EnrollmentRevocationVerificationError'
    this.transactionHash = transactionHash
  }
}

export class EnrollmentRevocationConfirmationError extends Error {
  readonly transactionHash: string

  constructor(transactionHash: string) {
    super(`The enrollment outcome for the submitted revocation transaction could not be confirmed on ${ACTIVE_NETWORK_LABEL}. Verify the enrollment status on chain before retrying.`)
    this.name = 'EnrollmentRevocationConfirmationError'
    this.transactionHash = transactionHash
  }
}

export class EnrollmentRevocationPreflightError extends Error {
  constructor(message = `Could not verify the active ${ACTIVE_NETWORK_LABEL} enrollment before revocation. No transaction was submitted.`) {
    super(message)
    this.name = 'EnrollmentRevocationPreflightError'
  }
}

function currentContextMatches(context: WalletContextSnapshot, expectedOwner: string, expectedChainId: number): boolean {
  return context.isConnected &&
    context.chainId === expectedChainId &&
    typeof context.address === 'string' &&
    context.address.toLowerCase() === expectedOwner.toLowerCase()
}

function assertPermissionContext(
  context: WalletContextSnapshot,
  expectedOwner: string,
  expectedChainId: number,
): void {
  if (expectedChainId !== ACTIVE_CHAIN_ID) {
    throw new PermissionContextError(`USDC allowance changes are restricted to ${ACTIVE_NETWORK_LABEL} (chain ${ACTIVE_CHAIN_ID}).`)
  }
  if (!context.isConnected || !context.address) {
    throw new PermissionContextError('Connect the wallet before changing the USDC allowance.')
  }
  if (context.chainId !== ACTIVE_CHAIN_ID) {
    throw new PermissionContextError(`Switch to ${ACTIVE_NETWORK_LABEL} (chain ${ACTIVE_CHAIN_ID}) before changing the USDC allowance.`)
  }
  if (context.address.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new PermissionContextError('The connected wallet changed before the request was signed. No permission change was submitted.')
  }
}

export async function applyAllowanceTargetAndConfirm(input: {
  targetAllowance6: bigint
  expectedOwner: string
  expectedChainId: number
  spender: string
  getWalletContext: () => WalletContextSnapshot
  readAllowance: (owner: string, spender: string) => Promise<bigint>
  writeAllowance: (targetAllowance6: bigint, owner: string, spender: string, chainId: number) => Promise<string>
  waitForReceipt: (transactionHash: string) => Promise<WalletTransactionReceipt>
}): Promise<{
  transactionHash: string
  owner: string
  previousAllowance6: bigint
  allowance6: bigint
  walletContextChanged: boolean
}> {
  if (input.targetAllowance6 < 0n || input.targetAllowance6 > (1n << 256n) - 1n) {
    throw new RangeError('The USDC allowance target is outside the supported integer range.')
  }

  assertPermissionContext(input.getWalletContext(), input.expectedOwner, input.expectedChainId)

  let previousAllowance6: bigint
  try {
    previousAllowance6 = await input.readAllowance(input.expectedOwner, input.spender)
  } catch {
    throw new AllowanceReadError('before')
  }

  // Recheck after the RPC read so an account or chain switch cannot authorize
  // calldata based on the previous wallet's state.
  assertPermissionContext(input.getWalletContext(), input.expectedOwner, input.expectedChainId)

  const transactionHash = await input.writeAllowance(
    input.targetAllowance6,
    input.expectedOwner,
    input.spender,
    input.expectedChainId,
  )

  let receipt: WalletTransactionReceipt
  try {
    receipt = await waitForSuccessfulReceipt(transactionHash, input.waitForReceipt)
  } catch (error) {
    if (error instanceof TransactionReceiptError) throw error
    throw new AllowanceConfirmationError(transactionHash)
  }

  if (receipt.from.toLowerCase() !== input.expectedOwner.toLowerCase()) {
    throw new PermissionContextError('The approval receipt belongs to a different wallet. MOVY did not accept it as this account\'s permission change.')
  }

  let allowance6: bigint
  try {
    allowance6 = await input.readAllowance(input.expectedOwner, input.spender)
  } catch {
    throw new AllowanceReadError('after', transactionHash)
  }
  if (allowance6 !== input.targetAllowance6) {
    throw new AllowanceVerificationError(transactionHash, input.targetAllowance6, allowance6)
  }

  return {
    transactionHash,
    owner: input.expectedOwner,
    previousAllowance6,
    allowance6,
    walletContextChanged: !currentContextMatches(input.getWalletContext(), input.expectedOwner, input.expectedChainId),
  }
}

export async function syncConfirmedAllowanceWithEnrollment<T extends {
  transactionHash: string
  owner: string
  previousAllowance6: bigint
  allowance6: bigint
  walletContextChanged: boolean
}>(
  confirmedChange: T,
  syncEnrollment: () => Promise<unknown>,
): Promise<T & { backendSyncPending: boolean; backendSyncError: string | null }> {
  try {
    await syncEnrollment()
    return { ...confirmedChange, backendSyncPending: false, backendSyncError: null }
  } catch (error) {
    if (!(error instanceof EnrollmentBackendSyncError)) throw error
    return { ...confirmedChange, backendSyncPending: true, backendSyncError: error.message }
  }
}

export async function revokeEnrollmentWithConfirmation(input: {
  expectedOwner: string
  expectedChainId: number
  expectedConfigEpoch: number
  getWalletContext: () => WalletContextSnapshot
  writeRevoke: (owner: string, chainId: number) => Promise<string>
  waitForReceipt: (transactionHash: string) => Promise<WalletTransactionReceipt>
  readEnrollment: (owner: string) => Promise<{ enrolled: boolean; configEpoch: number }>
  syncEnrollment: (transactionHash: string) => Promise<unknown>
}): Promise<{
  transactionHash: string
  owner: string
  enrollmentRevoked: true
  backendSynced: boolean
  tokenAllowanceChanged: false
  walletContextChanged: boolean
}> {
  assertPermissionContext(input.getWalletContext(), input.expectedOwner, input.expectedChainId)

  let enrollmentBefore: { enrolled: boolean; configEpoch: number }
  try {
    enrollmentBefore = await input.readEnrollment(input.expectedOwner)
  } catch {
    throw new EnrollmentRevocationPreflightError()
  }
  if (!enrollmentBefore.enrolled) {
    throw new EnrollmentRevocationPreflightError(`No active ${ACTIVE_NETWORK_LABEL} enrollment was found. No transaction was submitted.`)
  }
  if (enrollmentBefore.configEpoch !== input.expectedConfigEpoch) {
    throw new EnrollmentRevocationPreflightError(`Your ${ACTIVE_NETWORK_LABEL} enrollment changed before revocation. Refresh and retry; no transaction was submitted.`)
  }

  // The read above can take long enough for the wallet or chain to change.
  assertPermissionContext(input.getWalletContext(), input.expectedOwner, input.expectedChainId)
  const transactionHash = await input.writeRevoke(input.expectedOwner, input.expectedChainId)

  let receipt: WalletTransactionReceipt
  try {
    receipt = await waitForSuccessfulReceipt(transactionHash, input.waitForReceipt)
  } catch (error) {
    if (error instanceof TransactionReceiptError) throw error
    throw new EnrollmentRevocationConfirmationError(transactionHash)
  }

  if (receipt.from.toLowerCase() !== input.expectedOwner.toLowerCase()) {
    throw new PermissionContextError('The enrollment revocation receipt belongs to a different wallet.')
  }

  try {
    const enrollment = await input.readEnrollment(input.expectedOwner)
    if (enrollment.enrolled) throw new Error('Enrollment remains active')
  } catch {
    throw new EnrollmentRevocationVerificationError(transactionHash)
  }

  let backendSynced = true
  try {
    await input.syncEnrollment(transactionHash)
  } catch {
    backendSynced = false
  }

  return {
    transactionHash,
    owner: input.expectedOwner,
    enrollmentRevoked: true,
    backendSynced,
    tokenAllowanceChanged: false,
    walletContextChanged: !currentContextMatches(input.getWalletContext(), input.expectedOwner, input.expectedChainId),
  }
}
