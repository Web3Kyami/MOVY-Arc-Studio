'use client'

import React, { useId, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { ACTIVE_CHAIN_ID, ACTIVE_NETWORK_LABEL } from '@/lib/chain'
import { useDialogFocus } from '@/hooks/use-dialog-focus'

export interface EnrollmentRevocationWallet {
  isConnected: boolean
  address?: string
  chainId?: number
  isWrongNetwork: boolean
}

export interface EnrollmentRevocationStatus {
  isOnchainEnrolled: boolean
  configEpoch: number | null
  isOnchainLoading: boolean
  onchainError: string | null
  isPending: boolean
}

export interface EnrollmentRevocationBackendStatus {
  isLoading: boolean
  error: string | null
  isPending: boolean
}

type RevocationAvailability =
  | { canRevoke: true; address: string; chainId: typeof ACTIVE_CHAIN_ID; configEpoch: number }
  | { canRevoke: false; message: string }

export interface EnrollmentRevocationControlProps {
  wallet: EnrollmentRevocationWallet
  enrollment: EnrollmentRevocationStatus
  backendStatus: EnrollmentRevocationBackendStatus
  buttonContent: React.ReactNode
  buttonClassName: string
  onConnectedRevoke: (expectedConfigEpoch: number) => Promise<{ backendSynced: boolean; walletContextChanged: boolean }>
  onMessage: (message: string) => void
}

export function getEnrollmentRevocationAvailability(
  wallet: EnrollmentRevocationWallet,
  enrollment: EnrollmentRevocationStatus,
): RevocationAvailability {
  if (!wallet.isConnected || !wallet.address) {
    return { canRevoke: false, message: 'Connect your wallet before revoking automatic enrollment.' }
  }
  if (wallet.isWrongNetwork || wallet.chainId !== ACTIVE_CHAIN_ID) {
    return { canRevoke: false, message: 'Switch networks before stopping automatic saving.' }
  }
  if (enrollment.isOnchainLoading) {
    return { canRevoke: false, message: 'Checking automatic saving…' }
  }
  if (enrollment.onchainError) {
    return { canRevoke: false, message: 'Could not verify automatic saving. Check your connection and retry.' }
  }
  if (enrollment.isPending) {
    return { canRevoke: false, message: 'Wait for the current savings transaction to finish.' }
  }
  if (!enrollment.isOnchainEnrolled || enrollment.configEpoch === null) {
    return { canRevoke: false, message: 'No verified automatic enrollment is available to revoke.' }
  }
  return {
    canRevoke: true,
    address: wallet.address,
    chainId: ACTIVE_CHAIN_ID,
    configEpoch: enrollment.configEpoch,
  }
}

function sameAuthorization(
  snapshot: RevocationAvailability,
  current: RevocationAvailability,
): boolean {
  if (!snapshot.canRevoke || !current.canRevoke) return false
  return snapshot.address.toLowerCase() === current.address.toLowerCase() &&
    snapshot.chainId === current.chainId &&
    snapshot.configEpoch === current.configEpoch
}

export function EnrollmentRevocationControl({
  wallet,
  enrollment,
  backendStatus,
  buttonContent,
  buttonClassName,
  onConnectedRevoke,
  onMessage,
}: EnrollmentRevocationControlProps) {
  const [authorization, setAuthorization] = useState<RevocationAvailability | null>(null)
  const statusId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const currentAvailability = getEnrollmentRevocationAvailability(wallet, enrollment)
  const canConfirm = authorization !== null && sameAuthorization(authorization, currentAvailability)
  useDialogFocus(Boolean(authorization), dialogRef, () => setAuthorization(null))

  const close = () => setAuthorization(null)

  const open = () => {
    const nextAuthorization = getEnrollmentRevocationAvailability(wallet, enrollment)
    if (!nextAuthorization.canRevoke) {
      onMessage(nextAuthorization.message)
      return
    }
    setAuthorization(nextAuthorization)
  }

  const confirm = async () => {
    if (!authorization?.canRevoke) return
    const current = getEnrollmentRevocationAvailability(wallet, enrollment)
    if (!sameAuthorization(authorization, current)) {
      close()
      onMessage('Wallet or enrollment changed. Reopen to verify before stopping.')
      return
    }

    close()
    try {
      const result = await onConnectedRevoke(authorization.configEpoch)
      if (result.walletContextChanged) {
        onMessage(result.backendSynced
          ? 'Enrollment revoked for the signing wallet. The active wallet changed; the USDC token allowance was not changed.'
          : 'Enrollment revoked for the signing wallet, but MOVY sync is pending. The active wallet changed; the USDC token allowance was not changed.')
      } else if (!result.backendSynced) {
        onMessage('Automatic saving stopped, but MOVY sync is pending. The USDC token allowance is unchanged.')
      } else {
        onMessage('Automatic enrollment revoked. The USDC token allowance was not changed.')
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Could not verify enrollment revocation')
    }
  }

  return (
    <div>
      <button
        type="button"
        aria-label="Stop automatic saving"
        aria-describedby={!currentAvailability.canRevoke && wallet.isConnected ? statusId : undefined}
        disabled={!currentAvailability.canRevoke}
        onClick={open}
        className={buttonClassName}
      >
        {buttonContent}
      </button>
      {!currentAvailability.canRevoke && wallet.isConnected && (
        <p id={statusId} role="status" className="mt-2 text-sm text-muted-foreground">
          {currentAvailability.message}
        </p>
      )}
      {currentAvailability.canRevoke && (backendStatus.isLoading || backendStatus.error || backendStatus.isPending) && (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {backendStatus.error
            ? 'MOVY sync unavailable. Automatic saving is verified; you can still stop it.'
            : backendStatus.isPending
              ? 'MOVY sync pending. You can still stop verified automatic saving.'
              : 'Checking MOVY sync. You can still stop verified automatic saving.'}
        </p>
      )}

      {authorization && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Stop automatic saving"
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 backdrop-blur-xs animate-in fade-in duration-200"
          onClick={close}
        >
          <div
            className="w-full md:max-w-sm rounded-t-3xl md:rounded-3xl border border-border bg-card p-6 shadow-2xl space-y-4 animate-in slide-in-from-bottom md:zoom-in-95 duration-200"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto h-1 w-10 rounded-full bg-border md:hidden -mt-1 mb-2" />
            <div className="flex size-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-950/40">
              <AlertTriangle className="size-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-extrabold text-foreground">Stop automatic saving?</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Your savings stay in your wallet. This keeps your USDC allowance active. {ACTIVE_NETWORK_LABEL}; fees may apply.
              </p>
              {!canConfirm && (
                <p role="alert" className="pt-2 text-sm font-semibold text-destructive">
                  Wallet or enrollment changed. Close and verify before retrying.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                data-testid="confirm-enrollment-revoke"
                onClick={confirm}
                disabled={!canConfirm}
                className="w-full min-h-11 rounded-xl bg-destructive py-2.5 text-sm font-bold text-destructive-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Stop automatic saving
              </button>
              <button
                type="button"
                data-dialog-autofocus
                onClick={close}
                className="w-full min-h-11 rounded-xl border border-border py-2.5 text-sm font-bold text-foreground hover:bg-surface-subtle"
              >
                Keep saving
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
