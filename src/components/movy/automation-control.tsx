'use client'

import type { MovyModeData } from '@/hooks/use-movy-mode-data'
import { GLOBAL_PAUSE_UNAVAILABLE_MESSAGE } from '@/lib/global-pause'

type Automation = MovyModeData['automation']

/**
 * Shared pieces for the automatic-saving switch.
 *
 * The switch is the user's PERSONAL permission. It shows On, Paused or Off from
 * the user's own enrollment and personal pause flag, and its action always
 * pauses or resumes that personal flag. It never reflects the contract-wide
 * service pause, so a paused service can neither relabel it "Resume" nor make
 * the user think they can restart the service. Service availability is a
 * separate notice. Pausing, revoking and resetting the allowance stay available
 * whatever the service state is.
 */

export interface AutomationSwitchView {
  checked: boolean
  ariaLabel: string
  text: string
}

export function automationSwitchView(
  automation: Pick<Automation, 'isEnrolled' | 'personalActive' | 'isPending'>,
  options: { isDemoMode?: boolean } = {},
): AutomationSwitchView {
  const ariaLabel = options.isDemoMode && !automation.isEnrolled
    ? 'Demo enrollment off'
    : automation.personalActive
      ? 'Pause automatic savings'
      : 'Resume automatic savings'
  const text = automation.isPending
    ? 'Updating…'
    : automation.personalActive
      ? 'On'
      : automation.isEnrolled
        ? 'Paused'
        : 'Off'
  return { checked: automation.personalActive, ariaLabel, text }
}

export type ServiceNoticeKind = 'paused' | 'unavailable' | null

/**
 * Show only actionable service states for a verified enrollment. Routine status
 * reads continue in the background; their five-second polling state should not
 * interrupt the connected product UI.
 */
export function serviceNoticeKind(
  automation: Pick<Automation, 'isEnrolled' | 'service'>,
  isDemoMode: boolean,
): ServiceNoticeKind {
  if (isDemoMode || !automation.isEnrolled) return null
  const status = automation.service.status
  return status === 'paused' || status === 'unavailable' ? status : null
}

export function AutomationSwitch({
  automation,
  isDemoMode = false,
  disabled,
  describedBy,
  onToggle,
  ariaLabel,
  className = 'settings-switch',
}: {
  automation: Pick<Automation, 'isEnrolled' | 'personalActive' | 'isPending'>
  isDemoMode?: boolean
  disabled: boolean
  describedBy?: string
  onToggle: () => void
  /** Overrides the default label where a screen uses a fixed one. */
  ariaLabel?: string
  className?: string
}) {
  const view = automationSwitchView(automation, { isDemoMode })
  return (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel ?? view.ariaLabel}
      aria-checked={view.checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onToggle}
      className={className}
    >
      <span className="row-value">{view.text}</span>
      <span className="switch-track" />
    </button>
  )
}

export function AutomationServiceNotice({
  automation,
  isDemoMode = false,
  id,
}: {
  automation: Pick<Automation, 'isEnrolled' | 'service'>
  isDemoMode?: boolean
  id: string
}) {
  const kind = serviceNoticeKind(automation, isDemoMode)
  if (!kind) return null
  if (kind === 'unavailable') {
    return (
      <div id={id} role="alert" className="consumer-status">
        <p>{GLOBAL_PAUSE_UNAVAILABLE_MESSAGE}</p>
        <button type="button" className="min-h-11" onClick={automation.service.retry}>Retry</button>
      </div>
    )
  }
  return (
    <p id={id} role="status" className="settings-note">
      Service-wide pause. Your setting is unchanged; you can still pause or revoke.
    </p>
  )
}
