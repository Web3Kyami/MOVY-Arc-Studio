'use client'

import React, { useState, useRef } from 'react'
import Link from 'next/link'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { hasWalletConnectProjectId } from '@/lib/wagmi'
import { useLocalProfile } from '@/hooks/use-local-profile'
import { ProfileAvatar } from '../profile-avatar'
import { useMovyModeData } from '@/hooks/use-movy-mode-data'
import { useWallet } from '@/hooks/use-wallet'
import { useAutoSaver } from '@/hooks/use-auto-saver'
import { validateSavingsDestination } from '@/lib/destination-rules'
import { EnrollmentBackendSyncError } from '@/lib/enrollment-activation'
import { AutoSaverWriteSafetyError } from '@/lib/auto-saver-write-safety'
import { EnrollmentRevocationControl } from './enrollment-revocation-control'
import { AutomationServiceNotice, AutomationSwitch, serviceNoticeKind } from '../automation-control'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { ACTIVE_NETWORK_LABEL } from '@/lib/chain'
import {
  formatUsdcAllowance,
  parseUsdcAllowanceTarget,
  resolveAllowanceReadState,
} from '@/lib/spending-permissions'
import { centsToUsdc6, formatCents, parseCents } from '@/lib/money'
import {
  ShieldCheck,
  Check,
  Copy,
  ChevronRight,
  AlertTriangle,
  LogOut,
  Info,
  Sliders,
  Wallet,
  X,
  Lock,
  Camera,
} from 'lucide-react'


export function SettingsView() {
  const {
    isDemoMode,
    account,
    automation,
  } = useMovyModeData()

  const wallet = useWallet({ readEnabled: !isDemoMode })
  const { openConnectModal } = useConnectModal()
  const autoSaver = useAutoSaver({ enabled: !isDemoMode })

  const localProfile = useLocalProfile()
  const financialIdentity = `${isDemoMode ? 'demo' : wallet.address?.toLowerCase() || 'disconnected'}:${wallet.chainId}`
  const [financialSnapshot, setFinancialSnapshot] = useState<string | null>(null)
  const capModalRef = useRef<HTMLDivElement>(null)

  // Daily cap state
  const [isCustomCap, setIsCustomCap] = useState(false)
  const [customCapInput, setCustomCapInput] = useState('')
  const [capError, setCapError] = useState<string | null>(null)

  // Copy Account ID feedback
  const [copiedAccount, setCopiedAccount] = useState(false)
  const [copyAccountError, setCopyAccountError] = useState(false)

  // Confirmation Modals
  const [showWalletModal, setShowWalletModal] = useState(false)
  const walletModalRef = useRef<HTMLDivElement>(null)
  useDialogFocus(showWalletModal, walletModalRef, () => setShowWalletModal(false))
  const [showAllowanceModal, setShowAllowanceModal] = useState(false)
  const [showResetAllowanceModal, setShowResetAllowanceModal] = useState(false)
  const [showLogoutModal, setShowLogoutModal] = useState(false)
  const [showHowItWorksModal, setShowHowItWorksModal] = useState(false)
  const [allowanceTargetInput, setAllowanceTargetInput] = useState('25.00')
  const allowanceModalRef = useRef<HTMLDivElement>(null)
  const resetAllowanceModalRef = useRef<HTMLDivElement>(null)
  const logoutModalRef = useRef<HTMLDivElement>(null)
  const howItWorksModalRef = useRef<HTMLDivElement>(null)

  useDialogFocus(showAllowanceModal, allowanceModalRef, () => setShowAllowanceModal(false))
  useDialogFocus(showResetAllowanceModal, resetAllowanceModalRef, () => setShowResetAllowanceModal(false))
  useDialogFocus(showLogoutModal, logoutModalRef, () => setShowLogoutModal(false))
  useDialogFocus(showHowItWorksModal, howItWorksModalRef, () => setShowHowItWorksModal(false))

  useDialogFocus(isCustomCap, capModalRef, () => setIsCustomCap(false))

  // Status message toast
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setFeedbackMessage(msg)
    setTimeout(() => setFeedbackMessage(null), 3200)
  }

  // Derive active automation status from authoritative mode data
  // The switch and its toasts describe the user's PERSONAL setting, never the service-wide pause.
  const isAutomationActive = automation.personalActive
  const automationToggleBlockMessage = isDemoMode
    ? !automation.isEnrolled
      ? 'Saving is off. Complete setup to turn it on again.'
      : null
    : !wallet.isConnected
      ? 'Connect your wallet before changing automatic saving.'
      : wallet.isWrongNetwork
        ? 'Switch networks before changing automatic saving.'
        : !automation.isEnrolled
          ? 'Complete setup before changing automatic saving.'
          : null
  const isAutomationToggleBlocked = automation.isPending || automationToggleBlockMessage !== null
  const showAutomationToggleBlockMessage = wallet.isConnected && automationToggleBlockMessage !== null
  const automationDescribedBy = [
    showAutomationToggleBlockMessage ? 'saving-blocked' : null,
    serviceNoticeKind(automation, isDemoMode) ? 'settings-service-status' : null,
  ].filter(Boolean).join(' ') || undefined
  // Derive account destination truthfully from authoritative mode data
  const rawAddress = account.savingsDestination
  const hasConfiguredAccount = account.hasDestination && Boolean(rawAddress && rawAddress.length >= 4)
  const maskedAccount = account.maskedAccount

  const allowanceState = resolveAllowanceReadState({
    isDemoMode,
    isConnected: wallet.isConnected,
    isWrongNetwork: wallet.isWrongNetwork,
    isLoading: autoSaver.isAllowanceLoading,
    isError: autoSaver.isAllowanceError,
    allowance6: autoSaver.allowance,
    demoAllowance6: 0n,
  })
  const allowanceCanChange = !isDemoMode && !autoSaver.isPending && (
    wallet.isConnected && !wallet.isWrongNetwork && allowanceState.status === 'ready'
  )
  const displayedAllowance = allowanceState.status === 'ready' || allowanceState.status === 'preview'
    ? formatUsdcAllowance(allowanceState.allowance6)
    : allowanceState.status === 'loading'
      ? 'Checking…'
      : allowanceState.status === 'wrong-network'
        ? 'Switch network'
        : allowanceState.status === 'error'
          ? 'Could not verify'
          : 'Connect wallet'

  // Handle Automation Toggle via single authoritative control path
  const handleToggleAutomation = async () => {
    if (isDemoMode) return
    if (isAutomationToggleBlocked) {
      if (automationToggleBlockMessage) showToast(automationToggleBlockMessage)
      return
    }
    try {
      await automation.toggleAutomation()
      showToast(isDemoMode
        ? isAutomationActive ? 'Saving paused' : 'Saving resumed'
        : isAutomationActive ? 'Automatic saving paused' : 'Automatic saving resumed')
      } catch (error) {
        showToast(error instanceof EnrollmentBackendSyncError || error instanceof AutoSaverWriteSafetyError ? error.message : 'Failed to update automation state')
    }
  }

  // Handle Daily Cap Update
  const handleSelectCap = async (capCents: bigint) => {
    if (isDemoMode) return

    if (!wallet.isConnected) {
      showToast('Connect your wallet to change the daily limit.')
      return
    }
    if (wallet.isWrongNetwork) {
      showToast('Switch networks to change the daily limit.')
      return
    }
    if (!autoSaver.isOnchainEnrolled) {
      showToast('Complete setup before changing the daily limit.')
      return
    }

    if (wallet.isConnected) {
      const dest = autoSaver.userConfig?.destination
      const validation = validateSavingsDestination({
        destination: dest,
        walletAddress: wallet.address,
      })
      if (!validation.valid || !dest) {
        showToast('Cannot update limit: valid savings destination not configured')
        return
      }
      try {
        const maxRoundup = autoSaver.userConfig?.maxRoundup6 ?? BigInt(1e6)
        await autoSaver.updateConfig(dest as `0x${string}`, maxRoundup, centsToUsdc6(capCents))
        setIsCustomCap(false)
        showToast(`Daily limit set to ${formatCents(capCents)} per UTC day`)
      } catch (error) {
        showToast(error instanceof EnrollmentBackendSyncError || error instanceof AutoSaverWriteSafetyError ? error.message : 'Failed to update daily limit')
      }
    }
  }

  const handleSaveCustomCap = async () => {
    if (financialSnapshot !== financialIdentity) { showToast('Your wallet or mode changed. Reopen the limit editor.'); setIsCustomCap(false); return }
    const cents = parseCents(customCapInput)
    if (cents !== null && cents >= 100n && cents <= 50_000n) {
      await handleSelectCap(cents)
    } else {
      setCapError('Enter a limit between $1 and $500, with up to two decimal places.')
    }
  }

  // Handle Copy Account ID
  const handleCopyAccountId = async () => {
    if (!hasConfiguredAccount || !rawAddress) return
    setCopyAccountError(false)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(rawAddress)
      setCopiedAccount(true)
      showToast('Savings address copied')
      setTimeout(() => setCopiedAccount(false), 2500)
    } catch {
      setCopiedAccount(false)
      setCopyAccountError(true)
      showToast('Clipboard access failed. Select the address below to copy it manually.')
    }
  }

  const revocationWallet = {
    isConnected: wallet.isConnected,
    address: wallet.address,
    chainId: wallet.chainId,
    isWrongNetwork: wallet.isWrongNetwork,
  }
  const revocationEnrollment = {
    isOnchainEnrolled: autoSaver.isOnchainEnrolled,
    configEpoch: autoSaver.userConfig?.configEpoch ?? null,
    isOnchainLoading: autoSaver.onchainEnrollmentStatusLoading,
    onchainError: autoSaver.onchainEnrollmentStatusError,
    isPending: autoSaver.isOnchainTransactionPending,
  }
  const revocationBackendStatus = {
    isLoading: autoSaver.backendEnrollmentStatusLoading,
    error: autoSaver.backendEnrollmentStatusError,
    isPending: autoSaver.isBackendSyncPending,
  }

  const revocationControlProps = {
    wallet: revocationWallet,
    enrollment: revocationEnrollment,
    backendStatus: revocationBackendStatus,
    onConnectedRevoke: (expectedConfigEpoch: number) => autoSaver.revoke(expectedConfigEpoch),
    onMessage: showToast,
  }

  // Set an absolute USDC allowance target. ERC-20 approve replaces the old value.
  const handleConfirmAllowanceTarget = async () => {
    if (financialSnapshot !== financialIdentity || !allowanceCanChange) { showToast('Your wallet, mode, or allowance changed. Reopen this confirmation.'); setShowAllowanceModal(false); setShowResetAllowanceModal(false); return }
    if (isDemoMode) return
    const targetAllowance6 = parseUsdcAllowanceTarget(allowanceTargetInput)
    if (targetAllowance6 === null || targetAllowance6 <= 0n) {
      showToast('Enter a valid USDC allowance target with up to two decimal places.')
      return
    }
    setShowAllowanceModal(false)
    if (wallet.isConnected && !isDemoMode) {
      try {
        const result = await autoSaver.setUsdcAllowance(targetAllowance6)
        showToast(result.walletContextChanged
          ? `USDC allowance set for the signing wallet to ${formatUsdcAllowance(result.allowance6)}. The active wallet changed.`
          : result.backendSyncPending
            ? `Total USDC allowance set and verified as ${formatUsdcAllowance(result.allowance6)}. MOVY enrollment sync is pending; retry it below.`
          : `Total USDC allowance set to ${formatUsdcAllowance(result.allowance6)}.`)
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Could not verify the USDC allowance change')
      }
    }
  }

  const handleConfirmAllowanceReset = async () => {
    if (financialSnapshot !== financialIdentity || !allowanceCanChange) { showToast('Your wallet, mode, or allowance changed. Reopen this confirmation.'); setShowAllowanceModal(false); setShowResetAllowanceModal(false); return }
    if (isDemoMode) return
    setShowResetAllowanceModal(false)
    if (wallet.isConnected && !isDemoMode) {
      try {
        const result = await autoSaver.setUsdcAllowance(0n)
        showToast(result.walletContextChanged
          ? `USDC allowance confirmed as zero for the signing wallet. The active wallet changed.`
          : 'USDC allowance set to zero.')
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Could not verify that the USDC allowance was cleared')
      }
    }
  }

  // End the MOVY session without changing on-chain saving or allowance settings.
  const handleConfirmLogout = () => {
    setShowLogoutModal(false)
    if (wallet.isConnected) {
      wallet.disconnect()
      showToast('Logged out of MOVY.')
    }
  }

  return (
    <div className="consumer-settings">
      <h1>Settings</h1>
      {feedbackMessage && <p role="status" aria-live="polite" className="settings-alert">{feedbackMessage}</p>}
      <div className="profile-summary">
        <>{localProfile.identity ? <Link href="/settings/profile" aria-label="Edit profile photo" className="profile-edit-photo"><ProfileAvatar profile={localProfile.profile} size={96} /><span className="photo-badge"><Camera size={16} /></span></Link> : <ProfileAvatar profile={localProfile.profile} size={96} />}</>
        <strong>{localProfile.displayName}</strong>
        {localProfile.identity && <Link href="/settings/profile">Edit profile <ChevronRight size={14} /></Link>}
      </div>
      {autoSaver.backendSyncError && <div role="alert" className="settings-alert">
        <p>{autoSaver.backendSyncError}</p>
        <button type="button" disabled={autoSaver.isBackendSyncPending} onClick={async () => {
          try { await autoSaver.retryBackendSync(); showToast('MOVY synchronization completed') }
          catch (error) { showToast(error instanceof Error ? error.message : 'MOVY synchronization is still unavailable') }
        }}>{autoSaver.isBackendSyncPending ? 'Retrying…' : 'Retry'}</button>
      </div>}
      {isDemoMode ? (
        <section className="settings-group" aria-labelledby="saving-settings-title">
          <h2 id="saving-settings-title">Saving</h2>
          <div className="settings-rows">
            <div className="settings-row">
              <Sliders />
              <span>Automatic saving</span>
              <span className="row-value">On</span>
            </div>
            <div className="settings-row">
              <ShieldCheck />
              <span>Daily savings limit</span>
              <span className="row-value limit-value">{automation.dailyCapFormatted.replace(' per UTC day', '/day')}</span>
            </div>
            <div className="settings-row">
              <Wallet />
              <span>Savings destination</span>
            </div>
          </div>
        </section>
      ) : !wallet.isConnected ? (
        <section className="settings-group" aria-labelledby="saving-settings-title">
          <h2 id="saving-settings-title">Saving</h2>
          <button type="button" className="settings-row settings-connect-action" disabled={wallet.isConnecting} onClick={() => setShowWalletModal(true)}>
            <Wallet />
            <span>Connect wallet</span>
            <ChevronRight />
          </button>
        </section>
      ) : <section className="settings-group" aria-labelledby="saving-settings-title">
        <h2 id="saving-settings-title">Saving</h2>
        <div className="settings-rows">
          <div className="settings-row"><Sliders /><span>Automatic saving{showAutomationToggleBlockMessage && <small id="saving-blocked">{automationToggleBlockMessage}</small>}</span>
            <AutomationSwitch automation={automation} isDemoMode={isDemoMode} ariaLabel="Toggle Automatic Saving" describedBy={automationDescribedBy} disabled={isAutomationToggleBlocked} onToggle={handleToggleAutomation} />
          </div>
          <AutomationServiceNotice automation={automation} isDemoMode={isDemoMode} id="settings-service-status" />
          <button type="button" className="settings-row" aria-label={`Daily savings limit: ${automation.dailyCapFormatted}. Resets at 00:00 UTC.`} onClick={() => { setCapError(null); setFinancialSnapshot(financialIdentity); setCustomCapInput(automation.dailyCapValue.toFixed(2)); setIsCustomCap(true) }}><ShieldCheck /><span>Daily savings limit</span><span className="row-value limit-value">{automation.dailyCapFormatted.replace(' per UTC day', '/day')}</span><ChevronRight /></button>
          <div className="settings-row"><Wallet /><span>Savings destination<small>{maskedAccount}</small></span>{hasConfiguredAccount && <button type="button" aria-label="Copy savings address" onClick={handleCopyAccountId} className="min-h-11 min-w-11 flex items-center justify-center">{copiedAccount ? <Check size={18} /> : <Copy size={18} />}</button>}</div>
          {copyAccountError && <div><p role="alert" className="consumer-error">Clipboard unavailable. Select the address to copy it.</p><input aria-label="Savings address to copy" readOnly value={rawAddress} onFocus={event => event.currentTarget.select()} className="w-full min-h-11 rounded-xl border px-3 text-sm" /></div>}
          <div className="settings-allowance" role="group" aria-labelledby="allowance-setting-title">
            <div className="settings-row"><Lock /><span id="allowance-setting-title">USDC allowance</span><span className="row-value">{displayedAllowance}</span></div>
            <div className="allowance-actions">
              <button type="button" disabled={!allowanceCanChange} onClick={() => { setFinancialSnapshot(financialIdentity); setShowAllowanceModal(true) }}>Change allowance</button>
              <button type="button" className="danger" disabled={!allowanceCanChange || allowanceState.status === 'ready' && allowanceState.allowance6 === 0n} onClick={() => { setFinancialSnapshot(financialIdentity); setShowResetAllowanceModal(true) }}>Revoke allowance</button>
            </div>
          </div>
          {allowanceState.status === 'error' && <p className="settings-note" role="status">Could not verify allowance. <button type="button" onClick={() => autoSaver.refetch()} className="min-h-11 underline">Retry</button></p>}
        </div>
      </section>}
      {!isDemoMode && wallet.isConnected && <>
      <section className="settings-group" aria-labelledby="wallet-settings-title">
        <h2 id="wallet-settings-title">Wallet</h2>
        {wallet.isWrongNetwork && !isDemoMode && <button type="button" className="settings-row" onClick={() => wallet.switchChain()}><Wallet /><span>Switch network</span><ChevronRight /></button>}
        {wallet.connectError && <p role="alert" className="consumer-error">{wallet.connectError.message}</p>}
        {wallet.switchChainError && <p role="alert" className="consumer-error">{wallet.switchChainError}</p>}
        {!isDemoMode && !automation.isEnrolled && wallet.isConnected && <Link href="/onboarding" className="settings-row"><ShieldCheck /><span>Set up automatic saving</span><ChevronRight /></Link>}
      </section>
      <section className="settings-group" aria-labelledby="security-settings-title">
        <h2 id="security-settings-title">Security</h2>
        <EnrollmentRevocationControl {...revocationControlProps} buttonContent={<><ShieldCheck /><span>Stop automatic saving</span><ChevronRight /></>} buttonClassName="settings-row destructive" />
        {wallet.isConnected && <button type="button" className="settings-row" onClick={() => setShowLogoutModal(true)}><LogOut /><span>Log out</span><ChevronRight /></button>}
      </section>
      </>}
      <section className="settings-group" aria-labelledby="about-settings-title">
        <h2 id="about-settings-title">About</h2>
        <button type="button" className="settings-row" onClick={() => setShowHowItWorksModal(true)}><Info /><span>How MOVY Works</span><ChevronRight /></button>
        <div className="settings-row"><span>Version</span><span className="row-value">0.1.0</span></div>
      </section>
      {showWalletModal && <div className="consumer-overlay"><div ref={walletModalRef} role="dialog" aria-modal="true" aria-labelledby="wallet-connect-title" className="consumer-dialog" tabIndex={-1}>
        <h2 id="wallet-connect-title">Connect wallet</h2>
        <p className="settings-note">Your public address is shared. Connecting does not move funds.</p>
        <p className="settings-note">The next screen lists supported browser and mobile wallets.</p>
        {hasWalletConnectProjectId ? <button type="button" className="consumer-primary" disabled={!openConnectModal} onClick={() => { setShowWalletModal(false); openConnectModal?.() }}>Choose wallet</button> : wallet.connectors.map((connector) => <button key={connector.uid} type="button" className="consumer-primary" disabled={wallet.isConnecting} onClick={async () => { try { await wallet.connectAsync({ connector }); setShowWalletModal(false) } catch { showToast('Could not connect your wallet. Try again.') } }}>Connect {connector.name}</button>)}
        <button type="button" data-dialog-autofocus onClick={() => setShowWalletModal(false)}>Cancel</button>
      </div></div>}
      {isCustomCap && !isDemoMode && <div className="consumer-overlay"><div ref={capModalRef} role="dialog" aria-modal="true" aria-labelledby="daily-cap-title" className="consumer-dialog" tabIndex={-1}>
        <h2 id="daily-cap-title">Daily savings limit</h2>
        <p className="settings-note">Updates on {ACTIVE_NETWORK_LABEL}. Confirm in your wallet; fees may apply. Resets at 00:00 UTC.</p>
        <label className="editor-field">Limit (USDC)<input type="text" inputMode="decimal" aria-label="Daily savings limit" data-dialog-autofocus value={customCapInput} aria-invalid={Boolean(capError)} aria-describedby={capError ? 'cap-error' : undefined} onChange={event => { setCustomCapInput(event.target.value); setCapError(null) }} /></label>
        {capError && <p id="cap-error" className="consumer-error" role="alert">{capError}</p>}
        <div className="settings-actions">{[2,5,10].map(cap => <button key={cap} type="button" aria-pressed={customCapInput === cap.toFixed(2)} onClick={() => setCustomCapInput(cap.toFixed(2))}>${cap.toFixed(2)}</button>)}</div>
        <button type="button" className="consumer-primary" disabled={autoSaver.isPending} onClick={() => void handleSaveCustomCap()}>Save limit</button>
        <button type="button" onClick={() => setIsCustomCap(false)}>Cancel</button>
      </div></div>}
      {/* MODAL 2: SET AN ABSOLUTE USDC ALLOWANCE */}
      {showAllowanceModal && (
        <div
          ref={allowanceModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="allowance-dialog-title"
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 backdrop-blur-xs animate-in fade-in duration-200"
          onClick={() => setShowAllowanceModal(false)}
        >
          <div
            className="w-full md:max-w-sm rounded-t-3xl md:rounded-3xl border border-border bg-card p-6 shadow-2xl space-y-4 animate-in slide-in-from-bottom md:zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Mobile Drag Indicator */}
            <div className="mx-auto h-1 w-10 rounded-full bg-border md:hidden -mt-1 mb-2" />

            <div className="flex items-center justify-between">
              <div className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <ShieldCheck className="size-5" />
              </div>
              <button
                type="button"
                aria-label="Close allowance dialog"
                onClick={() => setShowAllowanceModal(false)}
                className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="space-y-1">
              <h3 id="allowance-dialog-title" className="text-lg font-bold text-foreground">
                Change allowance
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Your allowance on {ACTIVE_NETWORK_LABEL} will be replaced, not increased. Fees may apply.
              </p>
            </div>

            <label className="block space-y-1.5 text-sm font-semibold text-foreground">
              Total allowance (USDC)
              <input
                type="text"
                inputMode="decimal"
                value={allowanceTargetInput}
                onChange={(event) => setAllowanceTargetInput(event.target.value)}
                aria-label="Total USDC allowance"
                data-dialog-autofocus
                className="min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm font-bold"
              />
            </label>

            <div className="grid grid-cols-3 gap-2">
              {['25.00', '50.00', '100.00'].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setAllowanceTargetInput(amt)}
                  className={`min-h-11 rounded-xl border text-sm font-bold transition-all ${
                    allowanceTargetInput === amt
                      ? 'border-accent bg-accent-soft text-accent ring-1 ring-accent'
                      : 'border-border bg-background text-muted-foreground hover:bg-surface-subtle'
                  }`}
                >
                  ${amt}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={handleConfirmAllowanceTarget}
                disabled={!allowanceCanChange || parseUsdcAllowanceTarget(allowanceTargetInput) === null || parseUsdcAllowanceTarget(allowanceTargetInput) === 0n}
                className="w-full min-h-11 rounded-xl bg-primary py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90"
              >
                Save allowance
              </button>
              <button
                type="button"
                onClick={() => setShowAllowanceModal(false)}
                className="w-full min-h-11 rounded-xl border border-border py-2 text-sm font-medium text-muted-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: RESET ERC-20 ALLOWANCE */}
      {showResetAllowanceModal && (
        <div
          ref={resetAllowanceModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-allowance-dialog-title"
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 backdrop-blur-xs animate-in fade-in duration-200"
          onClick={() => setShowResetAllowanceModal(false)}
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
              <h3 id="reset-allowance-dialog-title" className="text-lg font-bold text-foreground">Revoke USDC allowance?</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                This sets your allowance to zero on {ACTIVE_NETWORK_LABEL}. Automatic saving stays on; fees may apply.
              </p>
            </div>
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={handleConfirmAllowanceReset}
                disabled={!allowanceCanChange}
                className="w-full min-h-11 rounded-xl bg-destructive py-2.5 text-sm font-bold text-destructive-foreground hover:opacity-90"
              >
                Revoke USDC Allowance
              </button>
              <button
                type="button"
                data-dialog-autofocus
                onClick={() => setShowResetAllowanceModal(false)}
                className="w-full min-h-11 rounded-xl border border-border py-2.5 text-sm font-bold text-foreground hover:bg-surface-subtle"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: LOG OUT */}
      {showLogoutModal && (
        <div
          ref={logoutModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-dialog-title"
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 backdrop-blur-xs animate-in fade-in duration-200"
          onClick={() => setShowLogoutModal(false)}
        >
          <div
            className="w-full md:max-w-sm rounded-t-3xl md:rounded-3xl border border-border bg-card p-6 shadow-2xl space-y-4 animate-in slide-in-from-bottom md:zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Mobile Drag Indicator */}
            <div className="mx-auto h-1 w-10 rounded-full bg-border md:hidden -mt-1 mb-2" />

            <div className="flex size-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-700 dark:bg-amber-950/40">
              <LogOut className="size-6" />
            </div>

            <div className="space-y-1">
              <h3 id="logout-dialog-title" className="text-lg font-bold text-foreground">Log out of MOVY?</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Logging out leaves automatic saving and your USDC allowance unchanged.
              </p>
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={handleConfirmLogout}
                className="w-full min-h-11 rounded-xl bg-destructive py-2.5 text-sm font-bold text-destructive-foreground hover:opacity-90"
              >
                Log out
              </button>
              <button
                type="button"
                data-dialog-autofocus
                onClick={() => setShowLogoutModal(false)}
                className="w-full min-h-11 rounded-xl border border-border py-2.5 text-sm font-bold text-foreground hover:bg-surface-subtle"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 5: HOW MOVY WORKS */}
      {showHowItWorksModal && (
        <div
          ref={howItWorksModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="how-it-works-dialog-title"
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 backdrop-blur-xs animate-in fade-in duration-200"
          onClick={() => setShowHowItWorksModal(false)}
        >
          <div
            className="w-full md:max-w-sm rounded-t-3xl md:rounded-3xl border border-border bg-card p-6 shadow-2xl space-y-4 animate-in slide-in-from-bottom md:zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Mobile Drag Indicator */}
            <div className="mx-auto h-1 w-10 rounded-full bg-border md:hidden -mt-1 mb-2" />

            <div className="flex items-center justify-between">
              <h3 id="how-it-works-dialog-title" className="text-lg font-bold text-foreground">How MOVY Works</h3>
              <button
                type="button"
                aria-label="Close How MOVY Works dialog"
                data-dialog-autofocus
                onClick={() => setShowHowItWorksModal(false)}
                className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="space-y-3 text-sm text-muted-foreground">
              <div className="flex gap-3 items-start">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent font-extrabold text-sm">
                  1
                </span>
                <div>
                  <p className="font-bold text-foreground">Pay normally</p>
                  <p>{isDemoMode ? 'Example purchases round to the next whole dollar.' : 'Pay with your connected wallet.'}</p>
                </div>
              </div>

              <div className="flex gap-3 items-start">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent font-extrabold text-sm">
                  2
                </span>
                <div>
                  <p className="font-bold text-foreground">Round up</p>
                  <p>Eligible USDC payments round to the next dollar.</p>
                </div>
              </div>

              <div className="flex gap-3 items-start">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent font-extrabold text-sm">
                  3
                </span>
                <div>
                  <p className="font-bold text-foreground">Save automatically</p>
                  <p>{isDemoMode ? 'Example round-ups appear in your activity.' : 'Confirmed round-ups go to your savings wallet. Network fees may apply.'}</p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowHowItWorksModal(false)}
                className="w-full min-h-11 rounded-xl bg-primary py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90"
            >
              Got It
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
