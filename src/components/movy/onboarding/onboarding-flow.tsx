'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { hasWalletConnectProjectId } from '@/lib/wagmi'
import { useWallet } from '@/hooks/use-wallet'
import { useLocalProfile } from '@/hooks/use-local-profile'
import { useAutoSaver } from '@/hooks/use-auto-saver'
import { EnrollmentBackendSyncError, TransactionReceiptError } from '@/lib/enrollment-activation'
import { AutoSaverWriteSafetyError } from '@/lib/auto-saver-write-safety'
import { Wordmark } from '@/components/movy/nav'
import {
  ArrowRight,
  ArrowLeft,
  Wallet,
  CheckCircle2,
  ChevronRight,
  Loader2,
  AlertCircle,
  X,
  CircleHelp,
} from 'lucide-react'

import {
  validateSavingsDestination,
  verifyDestinationBytecodeOnchain,
} from '@/lib/destination-rules'
import { formatCents, formatUsdc6 } from '@/lib/money'
import { ACTIVE_CHAIN_ID, ACTIVE_NETWORK, ACTIVE_NETWORK_LABEL } from '@/lib/chain'
import { centsToUsdc6, parseCents } from '@/lib/money'

const PERMISSION_OPTIONS6 = [25_000_000n, 50_000_000n, 100_000_000n] as const

export const ONBOARDING_STORAGE_KEY = 'movy_onboarding_completed'

type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6

export function OnboardingFlow({ onComplete }: { onComplete?: () => void }) {
  const router = useRouter()
  const wallet = useWallet()
  const { openConnectModal } = useConnectModal()
  const autoSaver = useAutoSaver()
  const localProfile = useLocalProfile()
  const [nickname, setNickname] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [help, setHelp] = useState<'daily' | 'allowance' | null>(null)
  const observedWallet = useRef<string | null>(null)
  const resolvedWallet = useRef<string | null>(null)
  const [newAccountWallet, setNewAccountWallet] = useState<string | null>(null)
  const activationWallet = useRef<string | null>(null)
  const recoveredSync = useRef(false)

  const [step, setStep] = useState<OnboardingStep>(2)

  // Step 2 (Connect Account) state
  // Step 3 (Destination) state
  const [customDestination, setCustomDestination] = useState('')
  const [hasConfirmedKeyOwnership, setHasConfirmedKeyOwnership] = useState(false)

  // Step 4 (Limits & Permission) state
  const [selectedDailyCap, setSelectedDailyCap] = useState<number>(5.0)
  const [isCustomCap, setIsCustomCap] = useState(false)
  const [customCapInput, setCustomCapInput] = useState('')
  const [selectedPermission6, setSelectedPermission6] = useState<bigint>(25_000_000n)

  const clearDailyLimitValidationNotice = () => {
    setActivationError((current) => current === 'Enter a daily limit from $1 to $500 with no more than two decimal places.'
      ? null
      : current)
  }

  const selectedCapCents = () => isCustomCap
    ? parseCents(customCapInput)
    : parseCents(selectedDailyCap.toFixed(2))
  const selectedCapFormatted = () => {
    const cents = selectedCapCents()
    return cents === null ? 'Enter a valid limit' : formatCents(cents)
  }

  // Step 5 (Activation) state
  const [isActivating, setIsActivating] = useState(false)
  const [activationError, setActivationError] = useState<string | null>(null)
  const [activationStage, setActivationStage] = useState<'idle' | 'enrolling' | 'authorizing'>('idle')
  const [needsEnrollmentSyncRecovery, setNeedsEnrollmentSyncRecovery] = useState(false)
  const [hasConfirmedEnrollment, setHasConfirmedEnrollment] = useState(false)
  const [pendingActivationSyncAction, setPendingActivationSyncAction] = useState<'enrollment' | 'approval' | null>(null)

  // Derive account identity
  const activeAddress = wallet.isConnected && wallet.address ? wallet.address : null
  const currentAddress = useRef(activeAddress)
  useEffect(() => { currentAddress.current = activeAddress }, [activeAddress])

  // A wallet on the right network but no usable AutoSaver: the contract is not configured, or it
  // is flagged unsafe for new activation. Decided BEFORE any wallet request. (A wrong network keeps
  // its own switch-network recovery path.) The low-level write gate still backs this up.
  const activationBlock: 'missing-contract' | 'blocked-contract' | null =
    wallet.isConnected && wallet.address && !wallet.isWrongNetwork
      ? !autoSaver.contractAddress
        ? 'missing-contract'
        : autoSaver.financialWritesBlocked
          ? 'blocked-contract'
          : null
      : null
  const activationBlockNotice = activationBlock
    ? `Automatic saving is unavailable on ${ACTIVE_NETWORK_LABEL} right now. No wallet approval prompt will open.`
    : null
  const activationBlockLabel = 'Automatic saving unavailable'
  const wrongNetworkActivationError = `Switch to ${ACTIVE_NETWORK_LABEL} (chain ${ACTIVE_CHAIN_ID}) before enrolling or setting an allowance.`

  useEffect(() => {
    if (!wallet.isWrongNetwork) {
      setActivationError((current) => current === wrongNetworkActivationError ? null : current)
    }
  }, [wallet.isWrongNetwork, wrongNetworkActivationError])

  const accountLookupFailed = localProfile.error || Boolean(autoSaver.enrollmentStatusError)

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      const identity = activeAddress?.toLowerCase() ?? null
      if (observedWallet.current !== identity) {
        observedWallet.current = identity
        resolvedWallet.current = null
        setNewAccountWallet(null)
        setStep(2)
        setNickname('')
        setNameError(null)
        setCustomDestination('')
        setHasConfirmedKeyOwnership(false)
      }
      if (!identity || resolvedWallet.current === identity || wallet.isWrongNetwork || isActivating) return

      // Legacy wallet-scoped profiles and revoked enrollments still belong to returning accounts.
      const hasSavedProfile = localProfile.remoteProfile || (localProfile.ready && !localProfile.error && localProfile.profile.name.trim())
      if (autoSaver.isOnchainEnrolled || (autoSaver.userConfig?.configEpoch ?? 0) > 0 || autoSaver.serverStatus?.enrollment || hasSavedProfile) {
        resolvedWallet.current = identity
        router.replace('/home')
        return
      }
      if (!localProfile.ready || autoSaver.enrollmentStatusLoading || accountLookupFailed) return
      resolvedWallet.current = identity
      setNewAccountWallet(identity)
      setStep(3)
    })
    return () => { cancelled = true }
  }, [activeAddress, wallet.isWrongNetwork, isActivating, autoSaver.isOnchainEnrolled, autoSaver.userConfig?.configEpoch, autoSaver.serverStatus, autoSaver.enrollmentStatusLoading, localProfile.ready, localProfile.error, localProfile.remoteProfile, localProfile.profile.name, accountLookupFailed, router])

  const maskedAccount = activeAddress
    ? `•••• ${activeAddress.slice(-4).toUpperCase()}`
    : 'Not connected'

  // Destination state - strictly non-custodial (never defaults to a contract vault)
  const [destinationError, setDestinationError] = useState<string | null>(null)
  const [isCheckingBytecode, setIsCheckingBytecode] = useState(false)
  const [bytecodeWarning, setBytecodeWarning] = useState<string | null>(null)
  const destinationCheckSequence = useRef(0)

  const finalDestinationAddress = customDestination.trim()
  const maskedDestination = finalDestinationAddress
    ? `•••• ${finalDestinationAddress.slice(-4).toUpperCase()}`
    : 'Not set'

  // Navigation handlers
  const handleNext = async () => {
    if (step === 3) {
      const startingAddress = activeAddress
      if (!startingAddress) { setNameError('Connect your spending wallet to continue.'); return }
      if (!nickname.trim()) { setNameError('Enter the name you want to use.'); return }
      setDestinationError(null)
      setBytecodeWarning(null)
      const val = validateSavingsDestination({
        destination: customDestination,
        walletAddress: wallet.address,
      })
      if (!val.valid) {
        setDestinationError(val.code === 'SELF_LOOP' ? 'Use a different wallet from the one you connected.' : 'Enter a valid savings wallet address.')
        return
      }

      const checkSequence = ++destinationCheckSequence.current
      setIsCheckingBytecode(true)
      let bytecodeVal: Awaited<ReturnType<typeof verifyDestinationBytecodeOnchain>>
      try {
        bytecodeVal = await verifyDestinationBytecodeOnchain({
          destination: customDestination,
        })
      } catch {
        if (destinationCheckSequence.current === checkSequence) {
          setIsCheckingBytecode(false)
          setDestinationError('Could not verify this savings address. Check your connection and retry.')
        }
        return
      }
      if (destinationCheckSequence.current !== checkSequence) return
      if (currentAddress.current !== startingAddress) {
        setIsCheckingBytecode(false)
        setDestinationError('Your connected wallet changed. Check your details and try again.')
        return
      }
      setIsCheckingBytecode(false)
      if (!bytecodeVal.valid) {
        setDestinationError(bytecodeVal.isContract ? 'Use a personal wallet address, not a contract.' : 'Could not verify this address. Check your connection and try again.')
        return
      }
      setBytecodeWarning(null)

      if (!hasConfirmedKeyOwnership) {
        setDestinationError('Confirm that you control this savings wallet.')
        return
      }
      try {
        setProfileSaving(true)
        if (!localProfile.ready || localProfile.error) throw new Error('Profile unavailable')
        await localProfile.save({ ...localProfile.profile, photo: localProfile.remoteProfile?.photo ?? null, name: nickname.trim() })
        if (currentAddress.current !== startingAddress) throw new Error('Wallet changed')
      } catch {
        setNameError('Could not save your name. Try again.')
        return
      } finally {
        setProfileSaving(false)
      }
    }
    setStep((prev) => Math.min(prev + 1, 6) as OnboardingStep)
  }

  const handleBack = () => {
    destinationCheckSequence.current += 1
    setIsCheckingBytecode(false)
    setStep((prev) => Math.max(prev - 1, 2) as OnboardingStep)
  }

  const handleExitSetup = () => {
    if (isActivating || needsEnrollmentSyncRecovery || profileSaving) return
    destinationCheckSequence.current += 1
    router.replace('/')
  }

  const invalidateDestinationCheck = () => {
    destinationCheckSequence.current += 1
    setIsCheckingBytecode(false)
  }

  const completeActivation = () => {
    setNeedsEnrollmentSyncRecovery(false)
    setIsActivating(false)
    setActivationStage('idle')
    if (typeof window !== 'undefined') localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true')
    setStep(6)
  }

  const authorizeAndComplete = async () => {
    if (!activationWallet.current || currentAddress.current?.toLowerCase() !== activationWallet.current) throw new Error('Reconnect the wallet used to start setup.')
    setActivationStage('authorizing')
    try {
      const result = await autoSaver.setUsdcAllowance(selectedPermission6)
      if (result.backendSyncPending) {
        setPendingActivationSyncAction('approval')
        setNeedsEnrollmentSyncRecovery(true)
        setActivationError(`Allowance confirmed as ${formatUsdc6(result.allowance6, 2)} USDC, but setup sync is pending. Retry to finish setup.`)
        setIsActivating(false)
        setActivationStage('idle')
        return
      }
      if (result.walletContextChanged) {
        throw new Error(`The total USDC allowance was set to ${formatUsdc6(result.allowance6, 2)} for the signing wallet, but the active wallet changed. Reconnect the signing wallet to complete setup.`)
      }
    } catch (error) {
      if (error instanceof EnrollmentBackendSyncError && error.transactionHash) {
        setPendingActivationSyncAction('approval')
      }
      throw error
    }
    completeActivation()
  }

  const handleRetryEnrollmentSync = async () => {
    if (activationBlock) return
    if (activationWallet.current && activationWallet.current !== wallet.address?.toLowerCase()) { setActivationError('Reconnect the wallet used to start setup.'); return }
    setIsActivating(true)
    setActivationError(null)
    try {
      if (!recoveredSync.current) {
        await autoSaver.retryBackendSync()
        recoveredSync.current = true
      }
      if (!activationWallet.current || currentAddress.current?.toLowerCase() !== activationWallet.current) {
        throw new Error('Reconnect the wallet used to start setup.')
      }
      setNeedsEnrollmentSyncRecovery(false)
      recoveredSync.current = false
      const cents = selectedCapCents()
      if (cents === null || cents < 100n || cents > 50_000n) {
        throw new Error('Enter a daily limit from $1 to $500 with no more than two decimal places.')
      }
      if (pendingActivationSyncAction === 'approval') {
        setPendingActivationSyncAction(null)
        completeActivation()
      } else {
        setPendingActivationSyncAction(null)
        setHasConfirmedEnrollment(true)
        await authorizeAndComplete()
      }
    } catch (err: unknown) {
      if (err instanceof EnrollmentBackendSyncError && err.transactionHash) setNeedsEnrollmentSyncRecovery(true)
      setActivationError(err instanceof TransactionReceiptError
        ? err.message
        : err instanceof Error
        ? err.message
        : `Activation could not be confirmed. Retry when ${ACTIVE_NETWORK_LABEL} is available.`)
      setIsActivating(false)
      setActivationStage('idle')
    }
  }

  // Do not finish connected activation until both transactions and backend sync are verified.
  const handleActivate = async () => {
    // Never reach a wallet request for a missing or blocked AutoSaver.
    if (activationBlock) return
    if (!hasConfirmedEnrollment && (autoSaver.enrollmentStatusLoading || autoSaver.enrollmentStatusError)) { setActivationError('Could not verify your saving setup. Try again when it is available.'); return }
    if (!hasConfirmedEnrollment && autoSaver.isEnrolled) { setActivationError('Automatic saving is already set up. Manage your destination and limits in Settings.'); return }
    if (activationWallet.current && activationWallet.current !== wallet.address?.toLowerCase()) { setActivationError('Reconnect the wallet used to start setup.'); return }
    activationWallet.current = wallet.address?.toLowerCase() ?? null
    setIsActivating(true)
    setActivationError(null)

    const capCents = selectedCapCents()
    if (capCents === null || capCents < 100n || capCents > 50_000n) {
      setActivationError('Enter a daily limit from $1 to $500 with no more than two decimal places.')
      setIsActivating(false)
      return
    }

    // If connected with a real web3 account, execute onchain enrollment and permission FIRST
    if (wallet.isConnected && wallet.address) {
      if (wallet.isWrongNetwork) {
        setActivationError(wrongNetworkActivationError)
        setIsActivating(false)
        return
      }
      // Validate destination strictly before any onchain call
      const val = validateSavingsDestination({
        destination: finalDestinationAddress,
        walletAddress: wallet.address,
      })
      if (!val.valid) {
        setActivationError(val.error)
        setIsActivating(false)
        return
      }

      // Re-verify destination bytecode against the wallet's selected Arc network.
      const bytecodeVal = await verifyDestinationBytecodeOnchain({
        destination: finalDestinationAddress,
      })
      if (currentAddress.current?.toLowerCase() !== activationWallet.current) {
        setActivationError('Reconnect the wallet used to start setup.')
        setIsActivating(false)
        return
      }
      if (!bytecodeVal.valid) {
        setActivationError(bytecodeVal.error)
        setIsActivating(false)
        return
      }

      if (!hasConfirmedKeyOwnership) {
        setActivationError('Please confirm that you hold the private keys to this savings address before activating.')
        setIsActivating(false)
        return
      }

      try {
        const dest = finalDestinationAddress as `0x${string}`
        const maxRoundup6 = BigInt(Math.round(1.0 * 1_000_000))
        const dailyCap6 = centsToUsdc6(capCents)

        if (!autoSaver.isEnrolled && !hasConfirmedEnrollment) {
          setActivationStage('enrolling')
          try {
            await autoSaver.enroll(dest, maxRoundup6, dailyCap6)
          } catch (error) {
            if (error instanceof EnrollmentBackendSyncError && error.transactionHash) {
              setPendingActivationSyncAction('enrollment')
            }
            throw error
          }
          setHasConfirmedEnrollment(true)
        }
        await authorizeAndComplete()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Activation error'
        if (err instanceof EnrollmentBackendSyncError && err.transactionHash) {
          setNeedsEnrollmentSyncRecovery(true)
        setActivationError('Enrollment confirmed, but setup sync is pending. Retry before continuing. Automatic saving stays off until sync succeeds.')
        } else if (err instanceof TransactionReceiptError) {
          setActivationError(err.message)
        } else if (err instanceof Error && err.message.includes('active wallet changed')) {
          setActivationError(err.message)
        } else {
          setActivationError(
            err instanceof AutoSaverWriteSafetyError
              ? err.message
              : msg.includes('rejected') || msg.includes('denied')
              ? 'Authorization was canceled. Tap below to retry.'
              : `Could not confirm ${ACTIVE_NETWORK_LABEL} activation. Retry when the wallet and network are available.`
          )
        }
        setIsActivating(false)
        setActivationStage('idle')
        return
      }
    } else {
      setActivationError('Connect your spending wallet to continue.')
      setIsActivating(false)
      return
    }

  }

  // Finish onboarding & launch app
  const handleFinish = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true')
    }
    if (onComplete) {
      onComplete()
    } else {
      router.replace('/home')
    }
  }

  return (
    <div className="min-h-dvh flex flex-col justify-between bg-background text-foreground">
      <a
        href="#onboarding-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-xl focus:bg-background focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-accent"
      >
        Skip to setup
      </a>
      <header className="w-full border-b border-border/60 bg-surface px-4 py-3 sm:px-6 sm:py-4">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <Wordmark className="text-xl" />

          <div className="flex shrink-0 items-center gap-3">
            {step < 6 && !isActivating && !needsEnrollmentSyncRecovery && !profileSaving ? (
              <button
                type="button"
                onClick={handleExitSetup}
                aria-label="Close setup"
                title="Close setup"
                className="inline-flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            ) : step < 6 ? (
              <p role="status" className="max-w-36 text-right text-[11px] leading-tight text-muted-foreground">
                {needsEnrollmentSyncRecovery
                  ? 'Retry synchronization before leaving setup.'
                  : 'Finish or cancel the wallet request to leave setup.'}
              </p>
            ) : null}

            {step < 6 && (
              <div
                role="progressbar"
                aria-label="Setup progress"
                aria-valuemin={1}
                aria-valuemax={3}
                aria-valuenow={step - 1}
                aria-valuetext={`Step ${step - 1} of 3`}
                className="flex items-center gap-1.5"
              >
              {[2, 3, 4].map((s) => (
                <div
                  key={s}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    s === step
                      ? 'w-7 bg-primary'
                      : s < step
                      ? 'w-3 bg-primary/40'
                      : 'w-2 bg-muted'
                  }`}
                />
              ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <main id="onboarding-main" tabIndex={-1} className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <section className="w-full max-w-2xl rounded-3xl border border-border/70 bg-surface p-5 shadow-xs sm:p-8">
          <div className="mx-auto w-full max-w-xl">

              {/* STEP 2: CONNECT ACCOUNT */}
              {step === 2 && (
                <div className="space-y-6 my-auto">
                  <div className="space-y-1.5">
                    <h1 className="text-2xl font-extrabold tracking-tight text-foreground">
                      Connect your spending wallet
                    </h1>
                    <p className="text-sm leading-6 text-muted-foreground">
                      Your public address is shared. Connecting does not move funds.
                    </p>
                  </div>


                  {/* Connected State Banner */}
                  {activeAddress ? (
                    <div className="rounded-2xl border border-accent/40 bg-accent-soft/30 p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className="flex size-9 items-center justify-center rounded-xl bg-accent text-white">
                            <CheckCircle2 className="size-5" />
                          </div>
                          <div>
                            <p className="text-xs font-bold text-foreground">
                              Account connected
                            </p>
                            <p className="text-xs font-extrabold text-accent">
                              {maskedAccount}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {hasWalletConnectProjectId ? <button type="button" onClick={openConnectModal} disabled={!openConnectModal} className="flex min-h-12 w-full items-center justify-between rounded-2xl border border-border/80 bg-surface px-4 py-2.5 text-sm font-semibold hover:border-accent disabled:opacity-50">
                        <span className="flex items-center gap-3"><Wallet aria-hidden="true" className="size-4 text-accent" />Choose a wallet</span><ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
                      </button> : wallet.connectors.map((connector) => <button key={connector.uid} type="button" disabled={wallet.isConnecting} onClick={() => { void wallet.connectAsync({ connector }).catch(() => setNameError('Could not connect your wallet. Try again.')) }} className="flex min-h-12 w-full items-center justify-between rounded-2xl border border-border/80 px-4 text-sm font-semibold">{connector.name}<ChevronRight aria-hidden="true" className="size-4" /></button>)}
                      {hasWalletConnectProjectId && <p className="text-xs text-muted-foreground">See supported browser and mobile wallet options.</p>}
                      {nameError && <p role="alert" className="text-sm text-destructive">{nameError}</p>}
                    </div>
                  )}
                  {activeAddress && (wallet.isWrongNetwork ? (
                    <button type="button" onClick={() => wallet.switchChain()} className="min-h-11 rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground">Switch network</button>
                  ) : accountLookupFailed ? (
                    <div className="space-y-3">
                      <p role="alert" className="text-sm text-destructive">Could not load your account. Try again.</p>
                      <button type="button" onClick={() => { void localProfile.refetch(); autoSaver.refetch() }} className="min-h-11 rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground">Try again</button>
                    </div>
                  ) : newAccountWallet === activeAddress.toLowerCase() ? (
                    <button type="button" onClick={() => setStep(3)} className="min-h-11 rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground">Continue</button>
                  ) : (
                    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin" />Checking your account…</p>
                  ))}
                </div>
              )}

              {/* STEP 3: CHOOSE WHERE SAVINGS GO */}
              {step === 3 && (
                <div className="space-y-6 my-auto">
                  <div className="space-y-2">
                    <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Where should savings go?</h1>
                  </div>
                  <fieldset disabled={profileSaving} className="space-y-3 disabled:opacity-70">
                    <legend className="sr-only">Profile and savings address</legend>
                    <label htmlFor="nickname" className="block text-sm font-bold">What should we call you?</label>
                    <input id="nickname" value={nickname} onChange={(e) => { setNickname(e.target.value); setNameError(null) }} maxLength={40} autoComplete="nickname" aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'nickname-error' : 'nickname-privacy'} className="min-h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm" />
                    <p id="nickname-privacy" className="text-xs text-muted-foreground">Your name is public. Saving needs a wallet signature.</p>
                    {nameError && <p id="nickname-error" role="alert" className="text-sm text-destructive">{nameError}</p>}
                    <div className="rounded-2xl border border-border bg-surface p-4 space-y-3 shadow-xs">
                      <label htmlFor="connected-destination" className="text-xs font-bold text-foreground block">
                        Savings address
                      </label>
                      <input
                        id="connected-destination"
                        type="text"
                        placeholder="0x..."
                        value={customDestination}
                        onChange={(e) => {
                          invalidateDestinationCheck()
                          setCustomDestination(e.target.value)
                          setDestinationError(null)
                          setBytecodeWarning(null)
                          const value = e.target.value.trim()
                          if (value.length === 42) {
                            const result = validateSavingsDestination({ destination: value, walletAddress: wallet.address })
                            if (!result.valid) setDestinationError(result.code === 'SELF_LOOP' ? 'Use a different wallet from the one you connected.' : 'Enter a valid savings wallet address.')
                            else {
                              const sequence = ++destinationCheckSequence.current
                              setIsCheckingBytecode(true)
                              void verifyDestinationBytecodeOnchain({ destination: value }).then((checked) => {
                                if (sequence !== destinationCheckSequence.current) return
                                setIsCheckingBytecode(false)
                                if (!checked.valid) setDestinationError(checked.isContract ? 'Use a personal wallet address, not a contract.' : 'Could not verify this address. Check your connection and try again.')
                              })
                            }
                          }
                        }}
                        aria-invalid={Boolean(destinationError)}
                        aria-describedby={destinationError ? 'connected-destination-error' : bytecodeWarning ? 'destination-bytecode-warning' : undefined}
                        className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                      />
                      {destinationError && (
                        <p id="connected-destination-error" role="alert" className="text-xs font-semibold text-rose-500 pt-0.5">{destinationError}</p>
                      )}
                      {bytecodeWarning && (
                        <div id="destination-bytecode-warning" role="status" className="p-2.5 rounded-xl border border-accent/30 bg-accent-soft/20 text-[11px] text-accent leading-relaxed">
                          {bytecodeWarning}
                        </div>
                      )}

                      <label className="flex items-start gap-2.5 pt-1.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={hasConfirmedKeyOwnership}
                          onChange={(e) => {
                            invalidateDestinationCheck()
                            setHasConfirmedKeyOwnership(e.target.checked)
                            if (e.target.checked) setDestinationError(null)
                          }}
                          className="mt-0.5 size-4 rounded border-border text-accent focus:ring-accent"
                        />
                        <span className="text-[11px] text-muted-foreground leading-snug">
                          I confirm that I control this savings wallet and can access its funds.
                        </span>
                      </label>


                    </div>
                  </fieldset>

                  <div className="flex items-center gap-3 pt-2">
                    <button
                      type="button"
                      onClick={handleBack}
                      disabled={profileSaving}
                      aria-label="Back to payment account"
                      className="min-h-11 rounded-2xl border px-4 text-xs font-bold text-muted-foreground hover:bg-muted"
                    >
                      <ArrowLeft className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={isCheckingBytecode || profileSaving}
                      onClick={handleNext}
                      className="flex min-h-11 flex-1 sm:flex-initial sm:px-8 items-center justify-center gap-2 rounded-2xl bg-primary text-xs font-bold text-primary-foreground shadow-sm hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
                    >
                      <span>{profileSaving ? 'Saving...' : isCheckingBytecode ? 'Checking address...' : 'Continue'}</span>
                      <ArrowRight className="size-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 4: SET YOUR LIMITS */}
              {step === 4 && (
                <div className="space-y-6 my-auto">
                  <div className="space-y-1.5">
                    <h1 className="text-2xl font-extrabold tracking-tight text-foreground">
                      Set your savings limits
                    </h1>

                  </div>

                  <fieldset disabled={isActivating || hasConfirmedEnrollment || needsEnrollmentSyncRecovery} className="space-y-4 disabled:opacity-70">
                    <legend className="sr-only">Savings limits</legend>
                    {/* Control 1: Daily Savings Limit */}
                    <div className="rounded-2xl border border-border/80 bg-surface p-4 space-y-2.5 shadow-xs">
                      <div className="flex items-center justify-between">
                        <div className="relative">
                          <div className="flex items-center gap-1"><p className="text-xs font-bold text-foreground">Daily savings limit</p><button type="button" aria-label="About the daily savings limit" aria-expanded={help === 'daily'} aria-controls="daily-help" onClick={() => setHelp(help === 'daily' ? null : 'daily')} onKeyDown={(e) => { if (e.key === 'Escape') setHelp(null) }} className="inline-flex size-11 items-center justify-center"><CircleHelp size={16} /></button></div>
                          {help === 'daily' && <p id="daily-help" role="status" className="absolute z-10 mt-1 max-w-64 rounded-xl border border-border bg-surface p-3 text-xs text-foreground shadow-lg">Round-ups stop at {selectedCapFormatted()} per day. The limit resets at midnight UTC.</p>}
                        </div>
                        <span className="text-xs font-extrabold text-accent money">
                          {selectedCapFormatted()} per UTC day
                        </span>
                      </div>

                      <div className="grid grid-cols-4 gap-1.5">
                        {[2.0, 5.0, 10.0].map((cap) => (
                          <button
                            key={cap}
                            type="button"
                            aria-pressed={!isCustomCap && selectedDailyCap === cap}
                            onClick={() => {
                              clearDailyLimitValidationNotice()
                              setSelectedDailyCap(cap)
                              setIsCustomCap(false)
                            }}
                            className={`min-h-11 rounded-xl border text-xs font-bold transition-all ${
                              !isCustomCap && selectedDailyCap === cap
                                ? 'border-accent bg-accent-soft text-accent ring-1 ring-accent'
                                : 'border-border bg-background text-muted-foreground hover:bg-surface-subtle'
                            }`}
                          >
                            ${cap.toFixed(2)}
                          </button>
                        ))}
                        <button
                          type="button"
                          aria-pressed={isCustomCap}
                          onClick={() => {
                            clearDailyLimitValidationNotice()
                            setIsCustomCap(true)
                          }}
                          className={`min-h-11 rounded-xl border text-xs font-bold transition-all ${
                            isCustomCap
                              ? 'border-accent bg-accent-soft text-accent ring-1 ring-accent'
                              : 'border-border bg-background text-muted-foreground hover:bg-surface-subtle'
                          }`}
                        >
                          Custom
                        </button>
                      </div>

                      {isCustomCap && (
                        <div className="flex items-center gap-2 pt-1">
                          <label htmlFor="custom-daily-cap" className="sr-only">Custom daily savings limit in US dollars</label>
                          <input
                            type="number"
                            id="custom-daily-cap"
                            min="1"
                            max="500"
                            step="0.01"
                            placeholder="Enter daily cap"
                            value={customCapInput}
                            onChange={(e) => {
                              setCustomCapInput(e.target.value)
                              clearDailyLimitValidationNotice()
                            }}
                            className="min-h-11 flex-1 rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-bold"
                          />
                        </div>
                      )}
                    </div>

                    <div className="rounded-2xl border border-border/80 bg-surface p-4 space-y-2.5 shadow-xs">
                      <div className="flex items-center justify-between">
                        <div className="relative">
                          <div className="flex items-center gap-1"><p className="text-xs font-bold text-foreground">USDC allowance</p><button type="button" aria-label="About the USDC allowance" aria-expanded={help === 'allowance'} aria-controls="allowance-help" onClick={() => setHelp(help === 'allowance' ? null : 'allowance')} onKeyDown={(e) => { if (e.key === 'Escape') setHelp(null) }} className="inline-flex size-11 items-center justify-center"><CircleHelp size={16} /></button></div>
                          {help === 'allowance' && <p id="allowance-help" role="status" className="absolute z-10 mt-1 max-w-64 rounded-xl border border-border bg-surface p-3 text-xs text-foreground shadow-lg">The total USDC MOVY may transfer. A new amount replaces the current one.</p>}
                        </div>
                        <span className="text-xs font-extrabold text-accent money">
                          {formatUsdc6(selectedPermission6, 2)} total
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-2">
                        {PERMISSION_OPTIONS6.map((amt) => (
                          <button
                            key={amt.toString()}
                            type="button"
                            aria-pressed={selectedPermission6 === amt}
                            onClick={() => setSelectedPermission6(amt)}
                            className={`min-h-11 rounded-xl border text-xs font-bold transition-all ${
                              selectedPermission6 === amt
                                ? 'border-accent bg-accent-soft text-accent ring-1 ring-accent'
                                : 'border-border bg-background text-muted-foreground hover:bg-surface-subtle'
                            }`}
                          >
                            {formatUsdc6(amt, 2)}
                          </button>
                        ))}
                      </div>


                    </div>
                  </fieldset>

                  <p className="text-xs leading-5 text-muted-foreground">{ACTIVE_NETWORK === 'testnet' ? 'Arc Testnet uses test USDC.' : 'This uses Arc and USDC.'} Confirm enrollment and a USDC allowance in your wallet. Network fees may apply.</p>
                  {activationBlockNotice && (
                    <div
                      id="activation-unavailable-notice"
                      role="status"
                      className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5 space-y-1.5 text-xs text-foreground"
                    >
                      <div className="flex items-center gap-2 font-bold">
                        <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                        <span>Automatic saving unavailable</span>
                      </div>
                      <p className="text-muted-foreground">{activationBlockNotice}</p>
                    </div>
                  )}

                  {activationError && (
                    <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-3.5 space-y-1.5 text-xs text-destructive">
                      <div className="flex items-center gap-2 font-bold">
                        <AlertCircle className="size-4 shrink-0" />
                        <span>Activation Notice</span>
                      </div>
                      <p className="text-destructive/90">{activationError}</p>
                    </div>
                  )}

                  <div className="flex items-center gap-3 pt-2">
                    <button
                      type="button"
                      disabled={isActivating || hasConfirmedEnrollment || needsEnrollmentSyncRecovery}
                      onClick={handleBack}
                      aria-label="Back to your details"
                      className="min-h-11 rounded-2xl border px-4 text-xs font-bold text-muted-foreground hover:bg-muted disabled:opacity-40"
                    >
                      <ArrowLeft className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={isActivating || activationBlock !== null}
                      aria-describedby={activationBlock ? 'activation-unavailable-notice' : undefined}
                      onClick={needsEnrollmentSyncRecovery ? handleRetryEnrollmentSync : handleActivate}
                      className="flex min-h-12 flex-1 sm:flex-initial sm:px-8 items-center justify-center gap-2 rounded-2xl bg-primary text-xs font-bold text-primary-foreground shadow-sm hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
                    >
                      {isActivating ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          <span>
                            {activationStage === 'enrolling'
                              ? '1 of 2: Confirming enrollment...'
                              : '2 of 2: Confirming savings permission...'}
                          </span>
                        </>
                      ) : (
                        <>
                          <span>{activationBlock ? activationBlockLabel : needsEnrollmentSyncRecovery ? 'Retry enrollment sync' : hasConfirmedEnrollment ? 'Retry authorization' : 'Turn on automatic saving'}</span>
                          <ArrowRight aria-hidden="true" className="size-4" />
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 6: COMPLETE */}
              {step === 6 && (
                <div className="space-y-6 my-auto text-center sm:text-left animate-in zoom-in-95 duration-300">
                  <div className="space-y-2">
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-foreground">
                      Automatic saving is on.
                    </h1>
                  </div>

                  {/* Active Setup Badge */}
                  <div className="rounded-2xl border border-border/80 bg-surface p-4 text-left shadow-xs space-y-2.5">
                    <div className="flex items-center justify-between text-xs pb-2 border-b border-border/60">
                      <span className="text-muted-foreground">Daily limit</span>
                      <span className="font-extrabold money text-foreground">
                        {selectedCapFormatted()} per UTC day
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Savings address</span>
                      <span className="font-bold text-foreground">{maskedDestination}</span>
                    </div>
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={handleFinish}
                      className="flex min-h-12 w-full sm:w-auto px-8 items-center justify-center gap-2 rounded-2xl bg-primary text-sm font-bold text-primary-foreground shadow-sm hover:brightness-110 active:scale-[0.99] transition-all"
                    >
                      <span>Go to MOVY</span>
                      <ArrowRight className="size-4" />
                    </button>
                  </div>
                </div>
              )}
          </div>
        </section>
      </main>
    </div>
  )
}
