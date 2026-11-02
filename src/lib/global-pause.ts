/**
 * Contract-wide pause reporting for the connected app.
 *
 * `MovyAutoSaver.paused()` is the owner's emergency switch. It is NOT the user's
 * own pause: a person can pause or resume only their personal setting, and
 * nothing in the app can change the contract-wide flag. The app therefore has
 * to answer a separate question, "is the service itself accepting round-ups
 * right now?", and answer it truthfully when it does not know.
 *
 * Rules enforced here:
 *  - Only a successfully read boolean is a known state.
 *  - A loading or failed read is never treated as "not paused" and never as
 *    "active". A failed refetch discards any older value instead of reusing it.
 *  - A read that is not applicable (no wallet, wrong network, no contract
 *    address) is `idle`, so no value from another account or network survives.
 */

export type GlobalPauseRead =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'running' }
  | { status: 'paused' }
  | { status: 'error'; message: string }

/**
 * The only text a failed or unconfigured pause read can ever produce. Provider and RPC
 * error content (which can carry endpoint URLs or API keys) and configuration
 * diagnostics never reach the UI through this helper.
 */
export const GLOBAL_PAUSE_UNAVAILABLE_MESSAGE = 'Saving status is unavailable. Try again.'

export interface GlobalPauseReadInput {
  /** True only when a wallet is connected on the build's Arc network and the read is enabled. */
  applicable: boolean
  contractConfigured: boolean
  isError: boolean
  isStale?: boolean
  data: unknown
}

export function resolveGlobalPauseRead(input: GlobalPauseReadInput): GlobalPauseRead {
  if (!input.applicable) return { status: 'idle' }
  if (!input.contractConfigured) return { status: 'error', message: GLOBAL_PAUSE_UNAVAILABLE_MESSAGE }
  // Error wins over any retained value: stale data is not evidence of the current state.
  // The error object itself is deliberately never read.
  if (input.isError) return { status: 'error', message: GLOBAL_PAUSE_UNAVAILABLE_MESSAGE }
  // An old reading remains unknown even when an offline refresh cannot start.
  if (input.isStale) return { status: 'loading' }
  if (typeof input.data === 'boolean') return { status: input.data ? 'paused' : 'running' }
  return { status: 'loading' }
}

export type ServiceStatus = 'available' | 'paused' | 'checking' | 'unavailable' | 'not-applicable'

export type AutomationStatusLabel =
  | 'Active'
  | 'Paused'
  | 'Service Paused'
  | 'Checking Service'
  | 'Service Unavailable'
  | 'Not Enrolled'
  | 'Updating...'

export interface AutomationAvailabilityInput {
  /** Enrollment verified onchain and by the backend record. */
  isEnrolled: boolean
  /** The user's own pause flag. Meaningful only when `isEnrolled`. */
  personalPaused: boolean
  globalPause: GlobalPauseRead
  isPending: boolean
}

export interface AutomationAvailability {
  /** Effective: verified enrollment AND personal not paused AND a confirmed unpaused service. */
  isActive: boolean
  /** The user's own permission only. Never reflects the service state. */
  personalActive: boolean
  serviceStatus: ServiceStatus
  statusLabel: AutomationStatusLabel
}

export function serviceStatusOf(globalPause: GlobalPauseRead): ServiceStatus {
  switch (globalPause.status) {
    case 'running':
      return 'available'
    case 'paused':
      return 'paused'
    case 'loading':
      return 'checking'
    case 'error':
      return 'unavailable'
    case 'idle':
      return 'not-applicable'
  }
}

export function resolveAutomationAvailability(input: AutomationAvailabilityInput): AutomationAvailability {
  const serviceStatus = serviceStatusOf(input.globalPause)
  const personalActive = input.isEnrolled && !input.personalPaused
  const isActive = personalActive && serviceStatus === 'available'

  let statusLabel: AutomationStatusLabel = 'Not Enrolled'
  if (input.isPending) {
    statusLabel = 'Updating...'
  } else if (!input.isEnrolled) {
    statusLabel = 'Not Enrolled'
  } else if (input.personalPaused) {
    statusLabel = 'Paused'
  } else if (serviceStatus === 'available') {
    statusLabel = 'Active'
  } else if (serviceStatus === 'paused') {
    statusLabel = 'Service Paused'
  } else if (serviceStatus === 'unavailable') {
    statusLabel = 'Service Unavailable'
  } else {
    statusLabel = 'Checking Service'
  }

  return { isActive, personalActive, serviceStatus, statusLabel }
}
