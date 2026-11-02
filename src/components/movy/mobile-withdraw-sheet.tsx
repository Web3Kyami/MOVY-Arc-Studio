'use client'

import React, { useState, useRef } from 'react'
import { useWallet } from '@/hooks/use-wallet'
import { useSavings } from '@/hooks/use-savings'
import { useWithdraw } from '@/hooks/use-payment'
import { formatCents, weiToCents, centsToWei } from '@/lib/money'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { ACTIVE_NETWORK, ACTIVE_NETWORK_LABEL, txUrl } from '@/lib/chain'
import {
  CheckCircle2,
  ArrowDownLeft,
  X,
  AlertCircle,
  Clock,
  ExternalLink,
  Loader2,
} from 'lucide-react'

interface MobileWithdrawSheetProps {
  isOpen: boolean
  onClose: () => void
}

export function MobileWithdrawSheet({ isOpen, onClose }: MobileWithdrawSheetProps) {
  const wallet = useWallet()
  const savings = useSavings()
  const withdraw = useWithdraw({ enabled: isOpen })

  const [withdrawPercent, setWithdrawPercent] = useState<25 | 50 | 100>(100)
  const [customAmount, setCustomAmount] = useState<string>('')
  const [localError, setLocalError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(isOpen, dialogRef, onClose)

  if (!isOpen) return null

  // Preview uses its own simulated pot. Connected mode can withdraw only a
  // successfully read legacy vault balance; the user's separate savings wallet
  // is never treated as MOVY-withdrawable.
  const availableCents = savings.legacyVault.status === 'ready'
    ? weiToCents(savings.legacyVault.value)
    : null
  const requestedCents = customAmount.trim()
    ? parseCustomCents(customAmount)
    : availableCents === null
      ? null
      : (availableCents * BigInt(withdrawPercent)) / 100n
  const requestedWei = requestedCents === null ? 0n : centsToWei(requestedCents)

  // Evaluate blocked or invalid preconditions (TASK C: Invalid / blocked requests)
  const isZeroOrNegative = requestedCents === null || requestedCents <= 0n
  const isExceedingBalance = availableCents !== null && requestedCents !== null && requestedCents > availableCents
  const isDisconnected = !wallet.isConnected
  const isWrongNetwork = wallet.isWrongNetwork
  const isVaultBalanceUnavailable = savings.legacyVault.status !== 'ready'

  const blockerMessage = isDisconnected
    ? `Connect your wallet on ${ACTIVE_NETWORK_LABEL} to submit a withdrawal.`
    : isWrongNetwork
    ? `Switch your wallet network to ${ACTIVE_NETWORK_LABEL} (Chain ID ${wallet.expectedChain.id}).`
    : isVaultBalanceUnavailable
    ? savings.legacyVault.status === 'loading'
      ? 'Checking the MOVY legacy vault balance before enabling a transfer.'
      : savings.legacyVault.status === 'error'
        ? `Unable to verify the MOVY legacy vault balance: ${savings.legacyVault.message}`
        : 'The MOVY legacy vault balance is unavailable. No transfer can be submitted.'
    : isExceedingBalance
    ? `Amount exceeds the verified vault balance of ${formatCents(availableCents ?? 0n)} USDC.`
    : isZeroOrNegative
    ? 'Enter a valid withdrawal amount greater than zero.'
    : null

  const handleWithdraw = async () => {
    setLocalError(null)

    if (blockerMessage) {
      setLocalError(blockerMessage)
      return
    }

    // Connected onchain withdraw:
    // Transitions withdraw.phase: awaitingSignature -> submitted -> confirmed (or failed)
    try {
      await withdraw.submit(requestedWei)
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleReset = () => {
    setLocalError(null)
    withdraw.reset()
  }

  // Determine current screen state
  // State 1: Submitted but pending confirmation (MEMPOOL PENDING)
  const isSubmittedReceiptUnconfirmed =
    withdraw.phase === 'submitted' && withdraw.isReceiptError
  const isSubmittedPending = withdraw.phase === 'submitted' && !withdraw.isReceiptError
  // State 2: Confirmed successful onchain OR confirmed in demo simulation (SUCCESS)
  const isConfirmedSuccess = withdraw.phase === 'confirmed'
  // State 3: Submission failure
  const isSubmissionFailed = withdraw.phase === 'failed' || Boolean(localError)
  const isConfirmedRevert = withdraw.phase === 'failed' && withdraw.receipt?.status === 'reverted'
  // State 4: Awaiting wallet signature
  const isAwaitingSignature = withdraw.phase === 'awaitingSignature'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="withdraw-title"
        tabIndex={-1}
        className="w-full max-w-[440px] rounded-t-3xl border-t bg-surface p-6 shadow-2xl animate-in slide-in-from-bottom duration-300"
        style={{ paddingBottom: 'calc(1.5rem + var(--nav-safe-bottom))' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-accent">
              <ArrowDownLeft className="size-5" />
            </div>
            <div>
              <h2 id="withdraw-title" className="text-base font-bold text-foreground">
                Withdraw Savings
              </h2>
              <p className="text-xs text-muted-foreground">
                Transfer from the MOVY contract on {ACTIVE_NETWORK_LABEL}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-dialog-autofocus
            onClick={onClose}
            aria-label="Close withdrawal dialog"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* ======================================================== */}
        {/* STATE A: CONFIRMED SUCCESS (Block Receipt Verified)       */}
        {/* ======================================================== */}
        {isConfirmedSuccess ? (
          <div className="py-7 text-center space-y-3.5 animate-in zoom-in-95 duration-200">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent shadow-xs">
              <CheckCircle2 className="size-8 text-accent animate-bounce" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-extrabold text-foreground">Withdrawal Confirmed</h3>
              <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                {formatCents(requestedCents ?? 0n).replace('$', '')} USDC has arrived in your spending wallet.
              </p>
            </div>

            {withdraw.hash && (
              <div className="rounded-xl bg-surface-subtle p-3 text-xs space-y-1 text-left border border-border/60">
                <div className="flex justify-between items-center text-muted-foreground text-[11px]">
                  <span>Network</span>
                  <span className="font-semibold text-foreground">{ACTIVE_NETWORK_LABEL} ({wallet.expectedChain.id})</span>
                </div>
                {withdraw.receipt && (
                  <div className="flex justify-between items-center text-muted-foreground text-[11px]">
                    <span>Block Number</span>
                    <span className="font-mono text-foreground font-semibold">
                      {withdraw.receipt.blockNumber.toString()}
                    </span>
                  </div>
                )}
                <div className="pt-1 border-t border-border/40">
                  <a
                    href={txUrl(wallet.network, withdraw.hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-bold text-primary hover:underline text-xs"
                  >
                    <span>View on Arc Explorer</span>
                    <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={onClose}
              className="w-full min-h-11 rounded-2xl bg-primary text-xs font-bold text-primary-foreground hover:brightness-110 active:scale-[0.98] transition-all"
            >
              Done
            </button>
          </div>
        ) : isSubmittedReceiptUnconfirmed ? (
          <WithdrawalReceiptUnresolvedNotice
            hash={withdraw.hash}
            isChecking={withdraw.isReceiptLoading}
            onRetry={withdraw.refreshReceipt}
          />
        ) : isSubmittedPending ? (
          /* ======================================================== */
          /* STATE B: SUBMITTED BUT PENDING (In Mempool, NOT Arrived)  */
          /* ======================================================== */
          <div className="py-7 text-center space-y-4 animate-in zoom-in-95 duration-200">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Clock className="size-8 animate-spin" />
            </div>
            <div className="space-y-1.5">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-0.5 text-xs font-bold text-amber-700 dark:text-amber-400">
                <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                <span>Transaction Submitted — Pending</span>
              </div>
              <h3 className="text-base font-extrabold text-foreground">Awaiting Network Confirmation</h3>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
                Your withdrawal has been broadcast to {ACTIVE_NETWORK_LABEL}. Funds will settle into your spending wallet once the transaction is included in a block.
              </p>
            </div>

            {withdraw.hash && (
              <div className="rounded-2xl border border-border/80 bg-surface-subtle p-3.5 text-left text-xs space-y-1.5">
                <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider block">
                  Transaction Hash
                </span>
                <span className="font-mono text-[11px] text-foreground truncate block">
                  {withdraw.hash}
                </span>
                <a
                  href={txUrl(wallet.network, withdraw.hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-bold text-primary hover:underline text-xs pt-0.5"
                >
                  <span>Track status on Arc Explorer</span>
                  <ExternalLink className="size-3" />
                </a>
              </div>
            )}

            <div className="text-[11px] text-muted-foreground">
              Please keep this open or check your wallet activity for confirmation.
            </div>
          </div>
        ) : (
          /* ======================================================== */
          /* STATE C & D: INPUT FORM, AWAITING SIGNATURE & FAILURE    */
          /* ======================================================== */
          <div className="space-y-4 pt-4">
            {/* Submission Failure Alert */}
            {isConfirmedRevert && withdraw.hash ? (
              <WithdrawalRevertedNotice hash={withdraw.hash} onDismiss={handleReset} />
            ) : (isSubmissionFailed || withdraw.errorMessage) && !withdraw.isReceiptError && (
              <WithdrawalFailureNotice
                message={withdraw.errorMessage || localError || 'Transaction could not be submitted.'}
                onDismiss={handleReset}
              />
            )}

            {/* Awaiting Signature Status */}
            {isAwaitingSignature && (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-3.5 flex items-center gap-3 text-xs text-foreground animate-pulse">
                <Loader2 className="size-4 animate-spin text-primary shrink-0" />
                <div>
                  <p className="font-bold">Awaiting Wallet Signature</p>
                  <p className="text-[11px] text-muted-foreground">
                    Please approve the withdrawal in your wallet extension.
                  </p>
                </div>
              </div>
            )}

            {/* Vault Available Balance */}
            <div className="rounded-2xl border bg-background/50 p-4 text-center">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Verified legacy vault balance
              </span>
              <p className="text-3xl font-extrabold money text-foreground mt-0.5">
                {availableCents === null ? '—' : formatCents(availableCents)} USDC
              </p>
            </div>

            {/* Quick percent buttons */}
            <div className="grid grid-cols-3 gap-2">
              {([25, 50, 100] as const).map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => {
                    setWithdrawPercent(pct)
                    setCustomAmount('')
                    setLocalError(null)
                  }}
                  className={`min-h-11 rounded-xl border text-xs font-bold transition-all ${
                    !customAmount && withdrawPercent === pct
                      ? 'border-accent bg-accent-soft text-accent ring-1 ring-accent'
                      : 'border-border bg-surface text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {pct === 100 ? 'Max (100%)' : `${pct}%`}
                </button>
              ))}
            </div>

            {/* Custom input */}
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-xs font-bold text-muted-foreground">$</span>
              <input
                type="number"
                step="0.01"
                placeholder="Or enter custom amount"
                value={customAmount}
                onChange={(e) => {
                  setCustomAmount(e.target.value)
                  setLocalError(null)
                }}
                className="min-h-11 w-full rounded-xl border bg-surface pl-7 pr-3 py-2.5 text-xs font-bold money focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>

            {/* Destination Verification */}
            <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
              <span>Transfer to:</span>
              <span className="font-mono font-medium text-foreground truncate max-w-[200px]">
                {wallet.address
                  ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
                  : 'Spending Wallet'}
              </span>
            </div>

            {/* Blocked message notice */}
            {blockerMessage && !localError && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium px-1">
                {blockerMessage}
              </p>
            )}

            {/* Submit Button */}
            <button
              type="button"
              onClick={handleWithdraw}
              disabled={Boolean(blockerMessage) || isAwaitingSignature}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-sm font-bold text-primary-foreground shadow-sm hover:brightness-110 active:scale-[0.99] disabled:opacity-50 transition-all"
            >
              {isAwaitingSignature ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span>Confirming in Wallet...</span>
                </>
              ) : (
                <span>{`Transfer ${formatCents(requestedCents ?? 0n)} to Spending`}</span>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function WithdrawalFailureNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-3.5 space-y-1.5 text-xs text-destructive animate-in fade-in duration-150">
      <div className="flex items-center gap-2 font-bold">
        <AlertCircle className="size-4 shrink-0" />
        <span>Withdrawal Failed</span>
      </div>
      <p className="text-destructive/90 leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="min-h-11 text-[11px] font-extrabold underline pt-1 text-destructive hover:opacity-80"
      >
        Dismiss and Try Again
      </button>
    </div>
  )
}

export function WithdrawalReceiptUnresolvedNotice({
  hash,
  isChecking,
  onRetry,
}: {
  hash: string | null
  isChecking: boolean
  onRetry: () => void | Promise<unknown>
}) {
  return (
    <div role="alert" className="space-y-4 py-7 text-center">
      <div className="space-y-1.5">
        <h3 className="text-base font-extrabold text-foreground">Withdrawal outcome unconfirmed</h3>
        <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
          The transaction was submitted, but {ACTIVE_NETWORK_LABEL} did not return its receipt. Do not submit this withdrawal again. Verify its state on the {ACTIVE_NETWORK_LABEL} explorer, then retry only the receipt check here.
        </p>
      </div>
      {hash ? (
        <div className="space-y-2 rounded-2xl border border-border/80 bg-surface-subtle p-3.5 text-left text-xs">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Transaction Hash</span>
          <span className="block truncate font-mono text-[11px] text-foreground">{hash}</span>
          <a
            href={txUrl(ACTIVE_NETWORK, hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1 font-bold text-primary hover:underline"
          >
            Verify on the {ACTIVE_NETWORK_LABEL} explorer <ExternalLink className="size-3" />
          </a>
        </div>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        disabled={isChecking}
        className="w-full min-h-11 rounded-2xl border border-border px-4 text-xs font-bold text-foreground hover:bg-muted disabled:opacity-60"
      >
        {isChecking ? 'Checking receipt…' : 'Retry receipt check'}
      </button>
    </div>
  )
}

export function WithdrawalRevertedNotice({ hash, onDismiss }: { hash: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="space-y-2 rounded-2xl border border-destructive/30 bg-destructive/10 p-3.5 text-xs text-destructive">
      <div className="flex items-center gap-2 font-bold">
        <AlertCircle className="size-4 shrink-0" />
        <span>Withdrawal reverted on {ACTIVE_NETWORK_LABEL}</span>
      </div>
      <p className="leading-relaxed text-destructive/90">
        The transaction was included but reverted. No funds were transferred to your spending wallet; a network fee may still have been charged.
      </p>
      <a
        href={txUrl(ACTIVE_NETWORK, hash)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center gap-1.5 font-bold underline"
      >
        View reverted transaction on the {ACTIVE_NETWORK_LABEL} explorer <ExternalLink className="size-3" />
      </a>
      <div>
        <button type="button" onClick={onDismiss} className="min-h-11 text-[11px] font-extrabold underline pt-1 hover:opacity-80">
          Dismiss and Try Again
        </button>
      </div>
    </div>
  )
}

function parseCustomCents(value: string): bigint | null {
  const trimmed = value.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null
  const [whole = '0', fraction = ''] = trimmed.split('.')
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))
  return cents > 0n ? cents : null
}
