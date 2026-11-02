'use client'

import React from 'react'
import Link from 'next/link'
import { useMovyModeData } from '@/hooks/use-movy-mode-data'
import { EnrollmentBackendSyncError } from '@/lib/enrollment-activation'
import { savingsFigureText } from '@/lib/savings-accounting'
import { AutomationServiceNotice, AutomationSwitch, serviceNoticeKind } from '../automation-control'
import { GoalSummary } from '../consumer-finance'
import { Plus, Copy, Check, ChevronRight } from 'lucide-react'

export function SavingsView() {
  const data = useMovyModeData()
  const { isDemoMode, account, savings, automation, goals } = data
  const otherGoals = goals.items.filter((goal) => goal.id !== goals.primaryGoal?.id)
  const [copied, setCopied] = React.useState(false)
  const [copyError, setCopyError] = React.useState(false)
  const [feedback, setFeedback] = React.useState<string | null>(null)
  const blockedMessage = isDemoMode
    ? 'Example setup'
    : account.isWrongNetwork
        ? 'Switch to the supported network to change automatic saving.'
        : !automation.isEnrolled
          ? 'Complete setup before changing automatic saving.'
          : null
  const isAutomationBlocked = !account.isConnected || blockedMessage !== null
  const visibleBlockedMessage = account.isConnected ? blockedMessage : null
  const serviceNotice = serviceNoticeKind(automation, isDemoMode) !== null
  const describedBy = [
    feedback || visibleBlockedMessage ? 'savings-automation-toggle-status' : null,
    serviceNotice ? 'savings-automation-service-status' : null,
  ].filter(Boolean).join(' ') || undefined
  async function toggle() {
    if (isAutomationBlocked || automation.isPending) return
    setFeedback(null)
    try {
      await automation.toggleAutomation()
      setFeedback(
        isDemoMode
          ? `Demo only: automatic saving is ${automation.isActive ? 'paused' : 'on'}. No transaction was submitted.`
          : 'Automatic saving updated.',
      )
    } catch (error) {
      setFeedback(
        error instanceof EnrollmentBackendSyncError
          ? 'The transaction was confirmed, but MOVY is still syncing. Retry in Settings.'
          : 'Could not confirm the update. Check your wallet before retrying.',
      )
    }
  }
  async function copy() {
    if (!account.savingsDestination) return
    setCopyError(false)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(account.savingsDestination)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
      setCopyError(true)
    }
  }
  return (
    <div className="consumer-page savings-page">
      <div className="consumer-page-heading">
        <h1>Savings</h1>
      </div>
      {!isDemoMode && (
        <div className="consumer-status">
          {account.isWrongNetwork ? (
            <Link href="/settings" role="alert">Switch network</Link>
          ) : null}
          {savings.isLoading && (
            <p role="status">Loading savings…</p>
          )}
          {savings.isError && (
            <div role="alert">
              <p>{savings.errorMessage || 'Savings could not be loaded.'}</p>
              <button type="button" onClick={savings.refetch}>
                Retry
              </button>
            </div>
          )}
        </div>
      )}
      {goals.primaryGoal && (
        <section id="goals" aria-labelledby="featured-goal-heading">
          <h2 id="featured-goal-heading" className="sr-only">
            Featured goal
          </h2>
        <GoalSummary
          goal={goals.primaryGoal}
          mode={goals.progressMode}
          editHref={!isDemoMode ? `/savings/${encodeURIComponent(goals.primaryGoal.id)}/edit` : undefined}
        />
        </section>
      )}
      {otherGoals.length > 0 && (
        <section id={goals.primaryGoal ? undefined : 'goals'} aria-labelledby="your-goals-heading">
          <div className="consumer-section-heading">
            <h2 id="your-goals-heading">Your goals</h2>
          </div>
          <div className="consumer-goals-list">
            {otherGoals.map((goal) => (
              <GoalSummary
                key={goal.id}
                goal={goal}
                mode={goals.progressMode}
                editHref={!isDemoMode ? `/savings/${encodeURIComponent(goal.id)}/edit` : undefined}
              />
            ))}
          </div>
        </section>
      )}
      {!goals.primaryGoal && otherGoals.length === 0 && (
        <p id="goals" className="consumer-empty">No goals yet.</p>
      )}
      <Link href="/savings/new" className="create-goal-action create-goal-action--savings">
        <Plus aria-hidden="true" />
        Create goal
      </Link>
      {(isDemoMode || account.isConnected) && <section aria-label="Savings controls" className="savings-management">
        <div className="settings-row">
          <span>Automatic saving</span>
          <AutomationSwitch
            automation={automation}
            isDemoMode={isDemoMode}
            disabled={isAutomationBlocked || automation.isPending}
            describedBy={describedBy}
            onToggle={toggle}
          />
        </div>
        <AutomationServiceNotice automation={automation} isDemoMode={isDemoMode} id="savings-automation-service-status" />
        {(feedback || visibleBlockedMessage) && (
          <p id="savings-automation-toggle-status" role="status" className="settings-note">
            {feedback || visibleBlockedMessage}{' '}
            {isDemoMode && !automation.isEnrolled && (
              <Link href="/onboarding">Complete saving setup</Link>
            )}
          </p>
        )}
        <div className="settings-row">
          <span>
            Savings destination<small>{account.maskedAccount}</small>
          </span>
          <button
            type="button"
            className="consumer-icon-action"
            disabled={!account.savingsDestination}
            onClick={copy}
            aria-label={copied ? 'Account ID Copied' : 'Copy Savings Address'}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
        </div>
        {copyError && (
          <div>
            <p role="alert" className="consumer-error">
              Clipboard unavailable. Select this address to copy it.
            </p>
            <input
              className="consumer-copy-fallback"
              aria-label="Savings address to copy manually"
              readOnly
              value={account.savingsDestination}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        )}
        <Link
          href="/settings"
          className="settings-row"
          aria-label={`Daily savings limit: ${automation.dailyCapFormatted}. Resets at 00:00 UTC.`}
        >
          <span>Daily savings limit</span>
          <span className="row-value">
            {automation.dailyCapFormatted.replace(' per UTC day', '/day')}
          </span>
          <ChevronRight aria-hidden="true" />
        </Link>
      </section>}
      {!isDemoMode && (
        <section className="savings-recovery" aria-labelledby="savings-balances-heading">
          <h2 id="savings-balances-heading">Savings wallet</h2>
          <dl>
            <div>
              <dt>Current balance</dt>
              <dd>
                {!account.isConnected ? (
                  <Link href="/onboarding" className="savings-balance-link">Connect wallet</Link>
                ) : account.isWrongNetwork ? (
                  <Link href="/settings" className="savings-balance-link">Switch network</Link>
                ) : savingsFigureText(savings.destinationWallet)}
              </dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  )
}
