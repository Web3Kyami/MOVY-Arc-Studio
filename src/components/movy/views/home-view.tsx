'use client'

import React from 'react'
import Link from 'next/link'
import { useMovyModeData } from '@/hooks/use-movy-mode-data'
import { useLocalProfile } from '@/hooks/use-local-profile'
import { EnrollmentBackendSyncError } from '@/lib/enrollment-activation'
import { AutomationServiceNotice, AutomationSwitch, serviceNoticeKind } from '../automation-control'
import { GoalSummary, ConsumerActivityRow, SavingsTotal } from '../consumer-finance'
import { PiggyBank, Target, Plus, ChevronRight } from 'lucide-react'

export function HomeView() {
  const data = useMovyModeData()
  const { isDemoMode, account, savings, automation, goals, activities } = data
  const { profile } = useLocalProfile()
  const [greeting, setGreeting] = React.useState('Welcome')
  React.useEffect(() => {
    const update = () => {
      const hour = new Date().getHours()
      setGreeting(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening')
    }
    update()
    const timer = window.setInterval(update, 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const [feedback, setFeedback] = React.useState<string | null>(null)
  const roundupStatus = savings.confirmedRoundups
  const showSavingsStatus =
    account.isWrongNetwork ||
    !account.isConnected ||
    roundupStatus.status === 'error' ||
    (roundupStatus.status === 'unavailable' && roundupStatus.reason !== 'not-enrolled')
  const blocked =
    isDemoMode || !automation.isEnrolled || (!account.isConnected || account.isWrongNetwork)
  const blockMessage = isDemoMode
    ? 'Example setup'
    : account.isWrongNetwork
      ? 'Switch to the supported network to change automatic saving.'
      : !account.isConnected
        ? null
        : !automation.isEnrolled
          ? 'Automatic saving is off.'
          : null
  const serviceNotice = serviceNoticeKind(automation, isDemoMode) !== null
  const describedBy = [
    blockMessage || feedback ? 'home-automation-toggle-status' : null,
    serviceNotice ? 'home-automation-service-status' : null,
  ].filter(Boolean).join(' ') || undefined
  async function toggle() {
    if (blocked) return
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
  return (
    <div className="consumer-page home-page">
      <h1 className="sr-only">Home</h1>
      <p className="home-greeting">
        {greeting}{profile.name && <>,<br /><strong>{profile.name}</strong></>}
      </p>
      <section className="home-savings" aria-label="Savings overview">
        <Link href="/savings" className="home-total-link">
          <SavingsTotal data={data} animated />
          <span className="home-total-arrow">
            <ChevronRight aria-hidden="true" />
            <span className="sr-only">View savings</span>
          </span>
        </Link>
        {goals.primaryGoal && (
          <>
            <h2 className="sr-only">Featured goal</h2>
            <GoalSummary
              goal={goals.primaryGoal}
              mode={goals.progressMode}
              editHref={!isDemoMode ? `/savings/${encodeURIComponent(goals.primaryGoal.id)}/edit` : undefined}
            />
          </>
        )}
      </section>
      {!isDemoMode && showSavingsStatus && (
        <div
          className="consumer-status"
          role={roundupStatus.status === 'error' ? 'alert' : 'status'}
        >
          {account.isWrongNetwork ? (
            <p>Switch networks to read connected savings.</p>
          ) : !account.isConnected ? (
            <Link href="/onboarding">Connect wallet</Link>
          ) : roundupStatus.status === 'error' ? (
            <>
              <p>{roundupStatus.message}</p>
              <button onClick={savings.refetch}>Retry</button>
            </>
          ) : (
            <p>Savings history is unavailable.</p>
          )}
        </div>
      )}
      {/* Outside the desktop-only switch section so the service state is visible at every width. */}
      <AutomationServiceNotice automation={automation} isDemoMode={isDemoMode} id="home-automation-service-status" />
      <nav className="home-shortcuts" aria-label="Quick actions">
        {[
          { href: '/savings', label: 'Savings', icon: PiggyBank },
          { href: '/savings#goals', label: 'Goals', icon: Target },
        ].map(({ href, label, icon: Icon }) => (
          <Link key={label} href={href}>
            <span>
              <Icon aria-hidden="true" />
            </span>
            {label}
          </Link>
        ))}
      </nav>
      <section className="home-saving-control" aria-labelledby="home-saving-label">
        <div className="settings-row">
          <span id="home-saving-label">Automatic saving</span>
          <AutomationSwitch
            automation={automation}
            isDemoMode={isDemoMode}
            disabled={blocked || automation.isPending}
            describedBy={describedBy}
            onToggle={toggle}
          />
        </div>
        {(blockMessage || feedback) && (
          <p id="home-automation-toggle-status" role="status" className="settings-note">
            {feedback || blockMessage}{' '}
            {isDemoMode && !automation.isEnrolled && (
              <Link href="/onboarding">Finish setup</Link>
            )}
            {!isDemoMode && account.isConnected && !account.isWrongNetwork && !automation.isEnrolled && (
              <Link href="/onboarding">Finish setup</Link>
            )}
          </p>
        )}
      </section>
      <section aria-labelledby="recent-activity-heading">
        <div className="consumer-section-heading">
          <h2 id="recent-activity-heading">Recent activity</h2>
          <Link href="/activity">See all</Link>
        </div>
        {activities.isLoading ? (
          <p role="status" className="consumer-empty">
            Loading activity…
          </p>
        ) : activities.isError ? (
          <div role="alert" className="consumer-status">
            <p>{activities.errorMessage || 'Activity could not be loaded.'}</p>
            <button onClick={activities.refetch}>Retry</button>
          </div>
        ) : activities.recentItems.length ? (
          <div className="consumer-activity-list">
            {activities.recentItems.slice(0, 3).map((item) => (
              <ConsumerActivityRow key={item.id} item={item} compact exampleOnly={isDemoMode} />
            ))}
          </div>
        ) : (
          <p className="consumer-empty home-activity-empty">
            {isDemoMode ? 'No activity to show.' : 'No payments recorded yet.'}
          </p>
        )}
      </section>
      {!goals.primaryGoal && (
        <Link className="create-goal-action create-goal-action--home" href="/savings/new">
          <Plus aria-hidden="true" size={18} /> Create goal
        </Link>
      )}
    </div>
  )
}
