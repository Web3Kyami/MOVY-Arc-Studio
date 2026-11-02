'use client'

import { useMemo, useCallback, useSyncExternalStore } from 'react'
import { useDemoMode, type DemoGoal, type DemoActivityItem } from '@/context/demo-mode-context'
import { useWallet } from '@/hooks/use-wallet'
import { useAutoSaver } from '@/hooks/use-auto-saver'
import { useAutoActivity } from '@/hooks/use-auto-activity'
import { useSavings } from '@/hooks/use-savings'
import { centsToUsdc6, formatCents, formatFee, formatUsdc6, formatUsdc6Exact, parseCents } from '@/lib/money'
import {
  buildSavingsFigures,
  confirmedRoundupsCents,
  resolveMoneyQuery,
  type DisplayMoneyRead,
  type MoneyRead,
} from '@/lib/savings-accounting'
import { ZERO_ADDRESS, isLegacyCheckoutContract } from '@/lib/destination-rules'
import { ACTIVE_CHAIN_ID, ACTIVE_NETWORK_LABEL } from '@/lib/chain'
import {
  GLOBAL_PAUSE_UNAVAILABLE_MESSAGE,
  resolveAutomationAvailability,
  type AutomationStatusLabel,
  type GlobalPauseRead,
  type ServiceStatus,
} from '@/lib/global-pause'

export interface MovyModeData {
  // Mode selection & indicators (TASK A & Finding 2: Connected-mode guard)
  isDemoMode: boolean
  isArcMode: boolean
  canSwitchToConnected: boolean
  requestConnectedMode: () => { success: boolean; reason?: 'wallet_not_connected' }
  setIsDemoMode: (val: boolean) => void
  toggleMode: () => boolean
  modeLabel: string
  modeBadge: {
    label: string
    isDemo: boolean
    sublabel: string
  }
  totalSavedFormatted: string

  // Account identity
  account: {
    isConnected: boolean
    address: string | undefined
    displayAddress: string
    maskedAccount: string
    savingsDestination: string
    hasDestination: boolean
    isWrongNetwork: boolean
  }

  // Balance & savings metrics (Finding 3: Truthful loading & RPC states)
  savings: {
    totalSavedFormatted: string
    totalSavedCents: bigint
    /** Historical confirmed AutoSaver transfers, in 6-decimal USDC units. */
    confirmedRoundups: DisplayMoneyRead<bigint>
    /** Exact count of confirmed eligible round-ups from the unbounded wallet summary. */
    confirmedRoundupCount: bigint | null
    /** Current USDC balance of the user's separate configured savings wallet. */
    destinationWallet: DisplayMoneyRead<bigint>
    /** Current owner balance in the legacy MovySavings vault, in native 18-decimal units. */
    legacyVault: DisplayMoneyRead<bigint>
    maxWithdrawWei: bigint | null
    canTransferFromLegacyVault: boolean
    /** Preview-only simulated pot; never populated from connected wallet data. */
    previewBalanceCents: bigint | null
    /** Uses observer recording time; it does not claim to use payment dates. */
    recordedLast7DaysFormatted: string
    roundupCountFormatted: string
    isLoading: boolean
    isError: boolean
    errorMessage: string | null
    isVaultFunded: boolean
    isConfirmedZero: boolean
    refetch: () => void
  }

  // Authoritative Automation State & Controls (TASK B)
  automation: {
    isEnrolled: boolean
    /** The user's OWN pause flag. Independent of the service-wide pause. */
    isPaused: boolean
    /** Effective: verified enrollment, personal not paused, AND a confirmed unpaused service. */
    isActive: boolean
    /** The user's own permission only (enrolled and not personally paused). The switch shows this. */
    personalActive: boolean
    /**
     * Contract-wide service state. Only `available` is a confirmed unpaused read;
     * `checking` and `unavailable` are unknown and never count as available.
     */
    service: {
      status: ServiceStatus
      /** Re-reads the service state. Does not change any setting. */
      retry: () => void
    }
    isPending: boolean
    statusLabel: AutomationStatusLabel
    toggleAutomation: () => Promise<void>
    dailyCapFormatted: string
    dailyCapValue: number
    dailyCap6: bigint | null
    usdcAllowanceFormatted: string
    usdcAllowance6: bigint | null
  }

  // Goal tracking
  goals: {
    progressMode: 'simulated' | 'manual-plan'
    items: DemoGoal[]
    primaryGoal: DemoGoal | null
    supportingGoals: DemoGoal[]
    addGoal: (goal: Omit<DemoGoal, 'id' | 'current'>) => void
    updateGoal: (id: string, updates: Partial<DemoGoal>) => void
  }

  // Activity stream
  activities: {
    items: DemoActivityItem[]
    recentItems: DemoActivityItem[]
    totalSaved: number | null
    totalRoundupSavings: number | null
    /** Exact display string for the simulated Preview activity summary only. */
    previewTotalRoundupSavingsFormatted?: string | null
    count: number
    roundupsCount: number | null
    hasActivities: boolean
    isLoading: boolean
    isError: boolean
    errorMessage: string | null
    refetch: () => void
  }
}

function unavailableSavingsFigures(
  reason: 'disconnected' | 'wrong-network' | 'not-enrolled' | 'no-destination' | 'preview-mode',
) {
  const unavailable: MoneyRead<bigint> = { status: 'unavailable', reason }
  return buildSavingsFigures({
    confirmedRoundups6: unavailable,
    destinationUsdc6: unavailable,
    legacyVaultWei: unavailable,
  })
}

const WALLET_GOALS_EVENT = 'movy:wallet-goals-change'
const TEST_FIXTURE_EVENT = 'movy:test-fixture-change'

function subscribeToWalletGoals(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('storage', onStoreChange)
  window.addEventListener(WALLET_GOALS_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', onStoreChange)
    window.removeEventListener(WALLET_GOALS_EVENT, onStoreChange)
  }
}

function walletGoalsSnapshot(key: string | null): string {
  if (typeof window === 'undefined' || !key) return '[]'
  try {
    return window.localStorage.getItem(key) ?? '[]'
  } catch {
    return '[]'
  }
}

function subscribeToTestFixtures(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('storage', onStoreChange)
  window.addEventListener('popstate', onStoreChange)
  window.addEventListener(TEST_FIXTURE_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', onStoreChange)
    window.removeEventListener('popstate', onStoreChange)
    window.removeEventListener(TEST_FIXTURE_EVENT, onStoreChange)
  }
}

function testFixtureSnapshot(enabled: boolean): string | null {
  if (!enabled || typeof window === 'undefined') return null
  try {
    return new URLSearchParams(window.location.search).get('fixture') || window.localStorage.getItem('movy_test_fixture')
  } catch {
    return new URLSearchParams(window.location.search).get('fixture')
  }
}

function parseWalletGoals(snapshot: string): DemoGoal[] {
  try {
    const value: unknown = JSON.parse(snapshot)
    return Array.isArray(value) ? value as DemoGoal[] : []
  } catch {
    return []
  }
}

/**
 * Authoritative selector and adapter that guarantees complete separation between
 * simulated preview/demo mode and genuine connected-account data (TASK A, TASK B, TASK D).
 *
 * Presentation components consume this adapter directly so they never accidentally
 * mix seeded mock balances or goals with connected-wallet state.
 */
/** Verification fixtures are mock readings; they never read the contract-wide pause. */
const FIXTURE_SERVICE_AVAILABLE: MovyModeData['automation']['service'] = { status: 'available', retry: () => {} }
const FIXTURE_SERVICE_IDLE: MovyModeData['automation']['service'] = { status: 'not-applicable', retry: () => {} }

/**
 * Local verification fixtures for the personal switch versus the contract-wide service state.
 * They are reachable only when the server enabled browser test fixtures (loopback development),
 * and they run the same availability rules as production, so a fixture can never show Active
 * for a paused, checking, or unavailable service.
 */
const SERVICE_STATE_FIXTURES = {
  'connected-paused': { personalPaused: true, service: 'available' },
  'connected-service-paused': { personalPaused: false, service: 'paused' },
  'connected-service-checking': { personalPaused: false, service: 'checking' },
  'connected-service-unavailable': { personalPaused: false, service: 'unavailable' },
  'connected-paused-service-paused': { personalPaused: true, service: 'paused' },
} as const satisfies Record<string, { personalPaused: boolean; service: 'available' | 'paused' | 'checking' | 'unavailable' }>

function fixtureGlobalPause(service: 'available' | 'paused' | 'checking' | 'unavailable'): GlobalPauseRead {
  switch (service) {
    case 'available': return { status: 'running' }
    case 'paused': return { status: 'paused' }
    case 'checking': return { status: 'loading' }
    case 'unavailable': return { status: 'error', message: GLOBAL_PAUSE_UNAVAILABLE_MESSAGE }
  }
}

type FixtureWindow = Window & { __movyFixtureSetPaused?: boolean[]; __movyFixtureServiceRetries?: number }

export function useMovyModeData(): MovyModeData {
  const {
    isDemoMode,
    browserTestFixturesEnabled,
    profile,
    goals: demoGoals,
    addGoal: addDemoGoal,
    updateGoal: updateDemoGoal,
    activities: demoActivities,
  } = useDemoMode()

  const wallet = useWallet({ readEnabled: !isDemoMode })
  const autoSaver = useAutoSaver({ enabled: !isDemoMode })
  const autoActivity = useAutoActivity({ enabled: !isDemoMode })
  const configuredDestination = autoSaver.userConfig?.destination
  const hasValidDestination = Boolean(
    configuredDestination &&
    configuredDestination !== ZERO_ADDRESS &&
    !isLegacyCheckoutContract(configuredDestination)
  )
  const savings = useSavings(
    autoSaver.isEnrolled && hasValidDestination && !isDemoMode ? configuredDestination : undefined,
    { enabled: !isDemoMode },
  )

  // Wallet-scoped local goals subscribe to storage so account switches read the
  // correct key without copying one wallet's data into another wallet's state.
  const walletGoalsKey = wallet.address ? `movy_goals_${wallet.address.toLowerCase()}` : null
  const walletGoalsSnapshotValue = useSyncExternalStore(
    subscribeToWalletGoals,
    () => walletGoalsSnapshot(walletGoalsKey),
    () => '[]',
  )
  const walletGoals = useMemo(() => parseWalletGoals(walletGoalsSnapshotValue), [walletGoalsSnapshotValue])

  // Persist wallet goals
  const saveWalletGoals = useCallback(
    (newGoals: DemoGoal[]) => {
      if (typeof window !== 'undefined' && walletGoalsKey) {
        window.localStorage.setItem(walletGoalsKey, JSON.stringify(newGoals))
        window.dispatchEvent(new Event(WALLET_GOALS_EVENT))
      }
    },
    [walletGoalsKey]
  )

  const canSwitchToConnected = false
  const requestConnectedMode = useCallback((): { success: boolean; reason?: 'wallet_not_connected' } => ({
    success: false,
    reason: 'wallet_not_connected',
  }), [])
  const toggleMode = useCallback((): boolean => false, [])
  const handleSetIsDemoMode = useCallback(() => {}, [])

  // --- 1. Mode Badge & Labels ---
  const modeBadge = useMemo(() => {
    if (isDemoMode) {
      return {
        label: 'Demo',
        isDemo: true,
        sublabel: '',
      }
    }
    if (wallet.isConnected) {
      if (wallet.isWrongNetwork) {
        return {
          label: 'Wrong Network',
          isDemo: false,
          sublabel: `Switch to ${ACTIVE_NETWORK_LABEL}`,
        }
      }
      return {
        label: 'Connected',
        isDemo: false,
        sublabel: autoSaver.isEnrolled
          ? autoSaver.isPaused
            ? 'Spending Wallet · Paused'
            : autoSaver.globalPause.status === 'paused'
              ? 'Spending Wallet · Service paused'
              : autoSaver.globalPause.status === 'error'
                ? 'Spending Wallet · Service status unavailable'
                : 'Spending Wallet · Enrolled'
          : 'Spending Wallet · Not Enrolled',
      }
    }
    return {
      label: 'Disconnected',
      isDemo: false,
      sublabel: `Connect wallet on ${ACTIVE_NETWORK_LABEL}`,
    }
  }, [isDemoMode, wallet.isConnected, wallet.isWrongNetwork, autoSaver.isEnrolled, autoSaver.isPaused, autoSaver.globalPause.status])

  // --- 2. Account Identity ---
  const account = useMemo(() => {
    if (isDemoMode) {
      return {
        isConnected: false,
        address: undefined,
        displayAddress: 'Example account',
        maskedAccount: 'Example savings destination',
        savingsDestination: '',
        hasDestination: false,
        isWrongNetwork: false,
      }
    }

    if (!wallet.isConnected || !wallet.address) {
      return {
        isConnected: false,
        address: undefined,
        displayAddress: 'Not Connected',
        maskedAccount: 'Savings destination not set',
        savingsDestination: '',
        hasDestination: false,
        isWrongNetwork: wallet.isWrongNetwork,
      }
    }

    const onchainDest = autoSaver.userConfig?.destination
    const hasValidOnchainDest = Boolean(
      onchainDest &&
      onchainDest !== ZERO_ADDRESS &&
      !isLegacyCheckoutContract(onchainDest)
    )
    const effectiveDest = hasValidOnchainDest ? onchainDest! : ''

    return {
      isConnected: true,
      address: wallet.address,
      displayAddress: `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
      maskedAccount: hasValidOnchainDest
        ? `Savings •••• ${effectiveDest.slice(-4).toUpperCase()}`
        : 'Savings destination not set',
      savingsDestination: effectiveDest,
      hasDestination: hasValidOnchainDest,
      isWrongNetwork: wallet.isWrongNetwork,
    }
  }, [isDemoMode, wallet.isConnected, wallet.address, wallet.isWrongNetwork, autoSaver.userConfig?.destination])

  // --- 3. Balance & Savings Metrics (TASK A & Finding 3: Truthful loading & RPC states) ---
  const savingsData = useMemo(() => {
    const refetchAll = () => {
      savings.refetch()
      autoActivity.refetch()
      autoSaver.refetch()
    }

    if (isDemoMode) {
      const cents = BigInt(Math.round(profile.totalSaved * 100))
      const previewOnly: MoneyRead<bigint> = { status: 'unavailable', reason: 'preview-mode' }
      const figures = buildSavingsFigures({
        confirmedRoundups6: previewOnly,
        destinationUsdc6: previewOnly,
        legacyVaultWei: previewOnly,
      })
      return {
        ...figures,
        totalSavedFormatted: profile.totalSaved.toFixed(2),
        totalSavedCents: cents,
        previewBalanceCents: cents,
        confirmedRoundupCount: null,
        recordedLast7DaysFormatted: 'Example activity',
        roundupCountFormatted: '18 roundups this month',
        isLoading: false,
        isError: false,
        errorMessage: null,
        isVaultFunded: false,
        isConfirmedZero: false,
        refetch: () => {},
      }
    }

    const confirmedRoundupsRead = resolveMoneyQuery({
      isConnected: wallet.isConnected && Boolean(wallet.address),
      isWrongNetwork: wallet.isWrongNetwork,
      isLoading: autoActivity.summaryIsLoading,
      isError: autoActivity.summaryIsError,
      error: autoActivity.summaryErrorMessage,
      data: autoActivity.confirmedRoundups6,
    })

    let destinationRead: MoneyRead<bigint>
    if (!wallet.isConnected || !wallet.address) {
      destinationRead = { status: 'unavailable', reason: 'disconnected' }
    } else if (wallet.isWrongNetwork) {
      destinationRead = { status: 'unavailable', reason: 'wrong-network' }
    } else if (autoSaver.enrollmentStatusError) {
      destinationRead = { status: 'error', message: autoSaver.enrollmentStatusError }
    } else if (autoSaver.enrollmentStatusLoading) {
      destinationRead = { status: 'loading' }
    } else if (!autoSaver.isEnrolled) {
      destinationRead = { status: 'unavailable', reason: 'not-enrolled' }
    } else if (!hasValidDestination) {
      destinationRead = { status: 'unavailable', reason: 'no-destination' }
    } else {
      destinationRead = savings.destinationBalance6
    }

    const figures = buildSavingsFigures({
      confirmedRoundups6: confirmedRoundupsRead,
      destinationUsdc6: destinationRead,
      legacyVaultWei: savings.legacyVault,
    })
    const reads = [confirmedRoundupsRead, destinationRead, savings.legacyVault]
    const isLoading = reads.some((read) => read.status === 'loading')
    const errorRead = reads.find((read) => read.status === 'error')
    const isError = errorRead?.status === 'error'
    const totalSavedFormatted = figures.confirmedRoundups.formatted?.replace(/^\$/, '') ?? '--.--'
    const recordedLast7DaysFormatted = confirmedRoundupsRead.status === 'error'
      ? 'Unavailable'
      : confirmedRoundupsRead.status !== 'ready'
        ? 'Loading...'
        : (autoActivity.recordedLast7DaysRoundups6 ?? 0n) > 0n
          ? `${formatUsdc6Exact(autoActivity.recordedLast7DaysRoundups6 ?? 0n)} recorded by MOVY in the last 7 days`
          : '$0.00 recorded by MOVY in the last 7 days'

    return {
      ...figures,
      confirmedRoundupCount: autoActivity.confirmedRoundupCount ?? null,
      totalSavedFormatted,
      totalSavedCents: confirmedRoundupsRead.status === 'ready'
        ? confirmedRoundupsCents(confirmedRoundupsRead.value)
        : 0n,
      previewBalanceCents: null,
      recordedLast7DaysFormatted,
      roundupCountFormatted: confirmedRoundupsRead.status === 'ready'
        ? `${autoActivity.confirmedRoundupCount?.toString() ?? '0'} lifetime confirmed AutoSaver round-ups`
        : confirmedRoundupsRead.status === 'error'
          ? 'Round-up history unavailable'
          : confirmedRoundupsRead.status === 'loading'
            ? 'Fetching confirmed round-up history...'
            : 'No active connection',
      isLoading,
      isError,
      errorMessage: errorRead?.status === 'error' ? errorRead.message : null,
      isVaultFunded: figures.canTransferFromLegacyVault,
      isConfirmedZero: confirmedRoundupsRead.status === 'ready' && confirmedRoundupsRead.value === 0n,
      refetch: refetchAll,
    }
  }, [
    isDemoMode,
    profile.totalSaved,
    wallet.isConnected,
    wallet.address,
    wallet.isWrongNetwork,
    autoSaver.enrollmentStatusLoading,
    autoSaver.enrollmentStatusError,
    autoSaver.isEnrolled,
    hasValidDestination,
    autoSaver.refetch,
    autoActivity.confirmedRoundups6,
    autoActivity.confirmedRoundupCount,
    autoActivity.recordedLast7DaysRoundups6,
    autoActivity.items,
    autoActivity.summaryIsLoading,
    autoActivity.summaryIsError,
    autoActivity.summaryErrorMessage,
    autoActivity.refetch,
    savings.destinationBalance6,
    savings.legacyVault,
    savings.refetch,
  ])

  // --- 4. Authoritative Savings Automation Controls (TASK B) ---
  const automation = useMemo<MovyModeData['automation']>(() => {
    if (isDemoMode) {
      const isEnrolled = profile.isEnrolled
      const isPaused = profile.isPaused
      const isActive = isEnrolled && !isPaused

      return {
        isEnrolled,
        isPaused,
        isActive,
        personalActive: isActive,
        service: { status: 'not-applicable', retry: () => {} },
        isPending: false,
        statusLabel: isActive ? 'Active' : isEnrolled ? 'Paused' : 'Not Enrolled',
        toggleAutomation: async () => { throw new Error('Automatic saving controls are examples in Demo.') },
        dailyCapFormatted: `${formatCents(BigInt(Math.round(profile.dailyCap * 100)))} per UTC day`,
        dailyCapValue: profile.dailyCap,
        dailyCap6: centsToUsdc6(BigInt(Math.round(profile.dailyCap * 100))),
        usdcAllowanceFormatted: `${formatUsdc6(22_090_000n, 6)} USDC`,
        usdcAllowance6: 22_090_000n,
      }
    }

    // Connected onchain mode
    const isEnrolled = autoSaver.isEnrolled
    // Personal pause only. The contract-wide pause is reported separately through `service`.
    const isPaused = autoSaver.isPaused
    const isPending = autoSaver.isPending
    const availability = resolveAutomationAvailability({
      isEnrolled,
      personalPaused: isPaused,
      globalPause: autoSaver.globalPause,
      isPending,
    })
    const { isActive, personalActive, statusLabel } = availability

    const dailyCap6 = autoSaver.userConfig?.dailyCap6 ?? 0n
    const hasVerifiedCap = wallet.isConnected && !wallet.isWrongNetwork && isEnrolled && autoSaver.userConfig !== null
    const dailyCapDollars = hasVerifiedCap ? Number(dailyCap6) / 1_000_000 : 0
    const allowance6 = autoSaver.allowance
    const usdcAllowanceFormatted = wallet.isWrongNetwork
      ? `Switch to ${ACTIVE_NETWORK_LABEL}`
      : autoSaver.isAllowanceLoading
        ? 'Checking USDC allowance…'
        : autoSaver.isAllowanceError
          ? 'USDC allowance unavailable'
          : allowance6 === null
            ? 'USDC allowance unknown'
            : `${formatUsdc6(allowance6, 6)} USDC`

    return {
      isEnrolled,
      isPaused,
      isActive,
      personalActive,
      service: { status: availability.serviceStatus, retry: autoSaver.refetchGlobalPause },
      isPending,
      statusLabel,
      // Always flips the user's PERSONAL pause. It never touches, and cannot lift, the service pause.
      toggleAutomation: async () => {
        if (!wallet.isConnected) throw new Error('Connect a wallet before changing automatic saving.')
        if (wallet.isWrongNetwork) throw new Error(`Switch to ${ACTIVE_NETWORK_LABEL} before changing automatic saving.`)
        if (!isEnrolled) throw new Error(`Verify ${ACTIVE_NETWORK_LABEL} enrollment before changing automatic saving.`)
        await autoSaver.setPaused(!isPaused)
      },
      dailyCapFormatted: wallet.isWrongNetwork
        ? `Switch to ${ACTIVE_NETWORK_LABEL}`
        : !wallet.isConnected
          ? 'Connect wallet'
          : hasVerifiedCap
            ? `${formatUsdc6Exact(dailyCap6)} per UTC day`
            : 'Not configured',
      dailyCapValue: dailyCapDollars,
      dailyCap6: hasVerifiedCap ? dailyCap6 : null,
      usdcAllowanceFormatted,
      usdcAllowance6: allowance6,
    }
  }, [isDemoMode, profile.isEnrolled, profile.isPaused, profile.dailyCap, autoSaver, wallet.isConnected, wallet.isWrongNetwork])

  // --- 5. Goals Data (TASK A: Never show seeded demo goals in connected mode) ---
  const goalsData = useMemo(() => {
    if (isDemoMode) {
      const primaryGoal = demoGoals.length > 0 ? demoGoals[0] : null
      const supportingGoals = demoGoals.slice(1)
      return {
        progressMode: 'simulated' as const,
        items: demoGoals,
        primaryGoal,
        supportingGoals,
        addGoal: addDemoGoal,
        updateGoal: updateDemoGoal,
      }
    }

    // Connected mode: return only user's wallet-scoped goals (empty by default, not seeded Alex goals!)
    const primaryGoal = walletGoals.length > 0 ? walletGoals[0] : null
    const supportingGoals = walletGoals.slice(1)

    const addGoal = (goal: Omit<DemoGoal, 'id' | 'current'>) => {
      const newGoal: DemoGoal = {
        ...goal,
        id: `wg_${crypto.randomUUID()}`,
        current: 0,
      }
      saveWalletGoals([...walletGoals, newGoal])
    }

    const updateGoal = (id: string, updates: Partial<DemoGoal>) => {
      saveWalletGoals(walletGoals.map((g) => (g.id === id ? { ...g, ...updates } : g)))
    }

    return {
      progressMode: 'manual-plan' as const,
      items: walletGoals,
      primaryGoal,
      supportingGoals,
      addGoal,
      updateGoal,
    }
  }, [isDemoMode, demoGoals, addDemoGoal, updateDemoGoal, walletGoals, saveWalletGoals])

  // --- 6. Activities Data (TASK A: Never show seeded demo activities in connected mode) ---
  const activitiesData = useMemo(() => {
    if (isDemoMode) {
      const confirmedDemoRoundups = demoActivities.filter((a) =>
        a.type === 'roundup' && (a.status === undefined || a.status === 'confirmed') && a.savedAmount > 0,
      )
      const totalSavedCents = confirmedDemoRoundups.reduce((sum, item) => {
        const amountCents = parseCents(String(item.savedAmount))
        return sum + (amountCents ?? 0n)
      }, 0n)
      const totalSaved = Number(totalSavedCents) / 100
      return {
        items: demoActivities,
        recentItems: demoActivities.slice(0, 5),
        totalSaved,
        totalRoundupSavings: totalSaved,
        previewTotalRoundupSavingsFormatted: formatCents(totalSavedCents),
        count: demoActivities.length,
        roundupsCount: confirmedDemoRoundups.length,
        hasActivities: demoActivities.length > 0,
        isLoading: false,
        isError: false,
        errorMessage: null,
        refetch: () => {},
      }
    }

    if (!wallet.isConnected || !wallet.address) {
      return {
        items: [],
        recentItems: [],
        totalSaved: null,
        totalRoundupSavings: null,
        previewTotalRoundupSavingsFormatted: null,
        count: 0,
        roundupsCount: null,
        hasActivities: false,
        isLoading: false,
        isError: false,
        errorMessage: null,
        refetch: () => {},
      }
    }

    // Network guard: Never silently substitute or query unsupported networks
    if (wallet.isWrongNetwork) {
      return {
        items: [],
        recentItems: [],
        totalSaved: null,
        totalRoundupSavings: null,
        previewTotalRoundupSavingsFormatted: null,
        count: 0,
        roundupsCount: null,
        hasActivities: false,
        isLoading: false,
        isError: true,
        errorMessage: `Connected wallet is on an unsupported network. Please switch to ${ACTIVE_NETWORK_LABEL} (chain ${ACTIVE_CHAIN_ID}).`,
        refetch: () => {},
      }
    }

    // Connected mode: unified ledger combining automatic roundups (AutoSaver) + contract events (Savings & Withdrawals)
    const rawAutoItems = autoActivity.items || []
    const seenEventKeys = new Set<string>()
    const ineligibleTransferTxHashes = new Set<string>()

    const mappedAutoItems: (DemoActivityItem & { rawTimestamp: number })[] = []

    for (const item of rawAutoItems) {
      const original6 = BigInt(item.amount6)
      const roundup6 = BigInt(item.roundup6)
      const origDollars = Number(original6) / 1_000_000
      let savedDollars = Number(roundup6) / 1_000_000
      const roundedDollars = Number(original6 + roundup6) / 1_000_000

      let status: 'confirmed' | 'pending' | 'failed' | 'skipped' = 'confirmed'
      let skipReason = item.skipReason

      if (item.roundupStatus === 'whole_dollar') {
        status = 'confirmed'
        savedDollars = 0
        skipReason = 'Whole dollar payment - zero spare change'
      } else if (item.roundupStatus === 'skipped') {
        status = 'skipped'
        savedDollars = 0
        skipReason = item.skipReason || 'Skipped per automation policy'
      } else if (item.roundupStatus === 'pending') {
        status = 'pending'
        savedDollars = 0
      } else if (item.roundupStatus === 'failed') {
        status = 'failed'
        savedDollars = 0
      } else if (item.roundupStatus === 'saved') {
        status = 'confirmed'
      }

      const eventKey = `autosaver:${item.txHash.toLowerCase()}:${item.logIndex}`
      seenEventKeys.add(eventKey)
      if (item.paymentKey) {
        seenEventKeys.add(item.paymentKey.toLowerCase())
      }

      if (!item.isEligible && (item.exclusionReason === 'movy_contract' || item.exclusionReason === 'unsupported_contract_interaction')) {
        ineligibleTransferTxHashes.add(item.txHash.toLowerCase())
      }

      const merchantLabel = item.recipient
        ? `Recipient (${item.recipient.slice(0, 6)}...${item.recipient.slice(-4)})`
        : 'Arc USDC payment'

      const rawTime = new Date(item.createdAt).getTime()

      mappedAutoItems.push({
        id: item.paymentKey || eventKey,
        merchant: merchantLabel,
        originalAmount: origDollars,
        roundedAmount: roundedDollars,
        savedAmount: savedDollars,
        originalAmountText: formatUsdc6Exact(original6),
        roundedAmountText: formatUsdc6Exact(original6 + roundup6),
        savedAmountText: status === 'confirmed'
          ? formatUsdc6Exact(item.roundupStatus === 'whole_dollar' ? 0n : roundup6)
          : status === 'pending'
            ? 'Pending'
            : status === 'failed'
              ? 'Failed'
              : 'Skipped',
        multiplier: 1,
        timestamp: new Date(item.createdAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        txHash: item.relayerTxHash || item.txHash,
        paymentTxHash: item.txHash,
        relayerTxHash: item.relayerTxHash,
        logIndex: item.logIndex,
        category: 'payment',
        type: 'roundup',
        status,
        skipReason,
        timestampBasis: 'recorded',
        feeText: 'Network fee not recorded',
        rawTimestamp: isNaN(rawTime) ? 0 : rawTime,
      })
    }

    // Integrate legacy/direct checkout purchases if not already captured
    const mappedPurchases: (DemoActivityItem & { rawTimestamp: number })[] = []
    for (const p of savings.purchases || []) {
      const eventKey = `purchase:${p.txHash.toLowerCase()}:${p.logIndex}`
      // Granular event deduplication: only skip if this exact event log was already recorded
      if (seenEventKeys.has(eventKey) || seenEventKeys.has(p.key.toLowerCase())) {
        continue
      }
      seenEventKeys.add(eventKey)

      const origDollars = Number(p.purchaseCents) / 100
      const savedDollars = p.status === 'confirmed' ? Number(p.roundupCents) / 100 : 0
      const roundedDollars = Number(p.totalCents) / 100

      mappedPurchases.push({
        id: p.key,
        merchant: `Recipient (${p.merchant.slice(0, 6)}...${p.merchant.slice(-4)})`,
        originalAmount: origDollars,
        roundedAmount: roundedDollars,
        savedAmount: savedDollars,
        originalAmountText: formatCents(BigInt(p.purchaseCents)),
        roundedAmountText: formatCents(BigInt(p.totalCents)),
        savedAmountText: p.status === 'confirmed' ? formatCents(BigInt(p.roundupCents)) : p.status,
        multiplier: 1,
        timestamp: new Date(p.timestamp).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        txHash: p.txHash,
        paymentTxHash: p.txHash,
        logIndex: p.logIndex,
        category: 'payment',
        type: 'roundup',
        status: p.status,
        timestampBasis: 'on-chain',
        feeText: p.feeWei === null ? 'Network fee not recorded' : formatFee(p.feeWei),
        rawTimestamp: p.timestamp,
      })
    }

    // If a rich PurchaseRounded event exists for an ineligible raw Transfer log in the same tx,
    // filter out the raw ineligible Transfer log so the user sees the clean purchase receipt
    const filteredAutoItems = mappedAutoItems.filter((item) => {
      if (ineligibleTransferTxHashes.has(item.paymentTxHash?.toLowerCase() || '')) {
        const hasRichPurchase = mappedPurchases.some(
          (p) => p.paymentTxHash?.toLowerCase() === item.paymentTxHash?.toLowerCase()
        )
        if (hasRichPurchase) return false
      }
      return true
    })

    // Integrate withdrawals from savings vault
    const mappedWithdrawals: (DemoActivityItem & { rawTimestamp: number })[] = []
    for (const w of savings.withdrawals || []) {
      const eventKey = `withdrawal:${w.txHash.toLowerCase()}:${w.logIndex}`
      if (seenEventKeys.has(eventKey) || seenEventKeys.has(w.key.toLowerCase())) {
        continue
      }
      seenEventKeys.add(eventKey)

      const amountDollars = Number(w.amountCents) / 100
      mappedWithdrawals.push({
        id: w.key,
        merchant: 'Savings Withdrawal',
        originalAmount: amountDollars,
        roundedAmount: amountDollars,
        savedAmount: -amountDollars,
        originalAmountText: formatCents(BigInt(w.amountCents)),
        roundedAmountText: formatCents(BigInt(w.amountCents)),
        savedAmountText: formatCents(-BigInt(w.amountCents)),
        multiplier: 1,
        timestamp: new Date(w.timestamp).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        txHash: w.txHash,
        paymentTxHash: w.txHash,
        logIndex: w.logIndex,
        category: 'withdrawal',
        type: 'withdrawal',
        status: w.status,
        timestampBasis: 'on-chain',
        feeText: w.feeWei === null ? 'Network fee not recorded' : formatFee(w.feeWei),
        rawTimestamp: w.timestamp,
      })
    }

    // Combine and sort chronologically descending (newest first)
    const combinedItems = [...filteredAutoItems, ...mappedPurchases, ...mappedWithdrawals]
      .sort((a, b) => b.rawTimestamp - a.rawTimestamp)
      .map(({ rawTimestamp, ...item }) => item)

    const isLoading = autoActivity.isLoading || savings.isLoading
    const isError = autoActivity.isError || savings.isError
    const errorMessage = isError
      ? (autoActivity.isError ? 'Failed to fetch activity records from server' : null) ||
        (typeof savings.error === 'string' ? savings.error : null) ||
        `Unable to load activity records from ${ACTIVE_NETWORK_LABEL}.`
      : null

    const refetchAll = () => {
      autoActivity.refetch()
      savings.refetch()
    }

    return {
      items: combinedItems,
      recentItems: combinedItems.slice(0, 5),
      totalSaved: null,
      totalRoundupSavings: null,
      previewTotalRoundupSavingsFormatted: null,
      count: combinedItems.length,
      roundupsCount: null,
      hasActivities: combinedItems.length > 0,
      isLoading,
      isError,
      errorMessage,
      refetch: refetchAll,
    }
  }, [
    isDemoMode,
    demoActivities,
    wallet.isConnected,
    wallet.address,
    wallet.isWrongNetwork,
    autoActivity.items,
    autoActivity.isLoading,
    autoActivity.isError,
    autoActivity.refetch,
    savings.purchases,
    savings.withdrawals,
    savings.isLoading,
    savings.isError,
    savings.error,
    savings.refetch,
  ])

  // --- SAFE VERIFICATION FIXTURES ---
  // Only active when explicitly requested via URL param (?fixture=...) or localStorage key
  const testFixture = useSyncExternalStore(
    subscribeToTestFixtures,
    () => testFixtureSnapshot(browserTestFixturesEnabled),
    () => null,
  )

  if (testFixture === 'disconnected') {
    return {
      isDemoMode: false,
      isArcMode: true,
      canSwitchToConnected: false,
      requestConnectedMode: () => ({ success: false, reason: 'wallet_not_connected' }),
      setIsDemoMode: () => {},
      toggleMode: () => false,
      modeLabel: 'Disconnected',
      modeBadge: { label: 'Disconnected', isDemo: false, sublabel: `Connect wallet on ${ACTIVE_NETWORK_LABEL}` },
      totalSavedFormatted: '--.--',
      account: {
        isConnected: false,
        address: undefined,
        displayAddress: 'Not Connected',
        maskedAccount: 'Savings destination not set',
        savingsDestination: '',
        hasDestination: false,
        isWrongNetwork: false,
      },
      savings: {
        ...unavailableSavingsFigures('disconnected'),
        totalSavedFormatted: '--.--',
        totalSavedCents: 0n,
        previewBalanceCents: null,
        confirmedRoundupCount: null,
        recordedLast7DaysFormatted: '--',
        roundupCountFormatted: 'No active connection',
        isLoading: false,
        isError: false,
        errorMessage: null,
        isVaultFunded: false,
        isConfirmedZero: false,
        refetch: () => {},
      },
      automation: {
        isEnrolled: false,
        isPaused: false,
        isActive: false,
        personalActive: false,
        service: FIXTURE_SERVICE_IDLE,
        isPending: false,
        statusLabel: 'Not Enrolled',
        toggleAutomation: async () => {},
        dailyCapFormatted: 'Not configured',
        dailyCapValue: 0,
        dailyCap6: null,
        usdcAllowanceFormatted: 'USDC allowance unknown',
        usdcAllowance6: null,
      },
      goals: {
        progressMode: 'manual-plan',
        items: [],
        primaryGoal: null,
        supportingGoals: [],
        addGoal: () => {},
        updateGoal: () => {},
      },
      activities: {
        items: [],
        recentItems: [],
        totalSaved: 0,
        totalRoundupSavings: null,
        count: 0,
        roundupsCount: null,
        hasActivities: false,
        isLoading: false,
        isError: false,
        errorMessage: null,
        refetch: () => {},
      },
    }
  }

  if (testFixture === 'connected-unenrolled') {
    return {
      isDemoMode: false,
      isArcMode: true,
      canSwitchToConnected: true,
      requestConnectedMode: () => ({ success: true }),
      setIsDemoMode: () => {},
      toggleMode: () => true,
      modeLabel: 'Connected Mode',
      modeBadge: { label: 'Verification Fixture', isDemo: false, sublabel: 'Mock readings · no live funds' },
      totalSavedFormatted: '0.00',
      account: {
        isConnected: true,
        address: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        displayAddress: '0x71C8...3A9F',
        maskedAccount: 'Savings destination not set',
        savingsDestination: '',
        hasDestination: false,
        isWrongNetwork: false,
      },
      savings: {
        ...buildSavingsFigures({
          confirmedRoundups6: { status: 'ready', value: 0n },
          destinationUsdc6: { status: 'unavailable', reason: 'not-enrolled' },
          legacyVaultWei: { status: 'ready', value: 0n },
        }),
        totalSavedFormatted: '0.00',
        totalSavedCents: 0n,
        previewBalanceCents: null,
        confirmedRoundupCount: 0n,
        recordedLast7DaysFormatted: '$0.00 recorded by MOVY in the last 7 days',
        roundupCountFormatted: '0 roundups recorded',
        isLoading: false,
        isError: false,
        errorMessage: null,
        isVaultFunded: false,
        isConfirmedZero: true,
        refetch: () => {},
      },
      automation: {
        isEnrolled: false,
        isPaused: false,
        isActive: false,
        personalActive: false,
        service: FIXTURE_SERVICE_IDLE,
        isPending: false,
        statusLabel: 'Not Enrolled',
        toggleAutomation: async () => {},
        dailyCapFormatted: 'Not configured',
        dailyCapValue: 0,
        dailyCap6: null,
        usdcAllowanceFormatted: 'USDC allowance unknown',
        usdcAllowance6: null,
      },
      goals: {
        progressMode: 'manual-plan',
        items: [],
        primaryGoal: null,
        supportingGoals: [],
        addGoal: () => {},
        updateGoal: () => {},
      },
      activities: {
        items: [],
        recentItems: [],
        totalSaved: 0,
        totalRoundupSavings: 0,
        count: 0,
        roundupsCount: 0,
        hasActivities: false,
        isLoading: false,
        isError: false,
        errorMessage: null,
        refetch: () => {},
      },
    }
  }

  if (testFixture === 'connected-loading') {
    return {
      isDemoMode: false,
      isArcMode: true,
      canSwitchToConnected: true,
      requestConnectedMode: () => ({ success: true }),
      setIsDemoMode: () => {},
      toggleMode: () => true,
      modeLabel: 'Connected Mode',
      modeBadge: { label: 'Verification Fixture', isDemo: false, sublabel: 'Mock loading state' },
      totalSavedFormatted: '--.--',
      account: {
        isConnected: true,
        address: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        displayAddress: '0x71C8...3A9F',
        maskedAccount: 'Savings •••• 3A9F',
        savingsDestination: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        hasDestination: true,
        isWrongNetwork: false,
      },
      savings: {
        ...buildSavingsFigures({
          confirmedRoundups6: { status: 'loading' },
          destinationUsdc6: { status: 'loading' },
          legacyVaultWei: { status: 'loading' },
        }),
        totalSavedFormatted: '--.--',
        totalSavedCents: 0n,
        previewBalanceCents: null,
        confirmedRoundupCount: null,
        recordedLast7DaysFormatted: 'Loading...',
        roundupCountFormatted: 'Loading savings activity…',
        isLoading: true,
        isError: false,
        errorMessage: null,
        isVaultFunded: false,
        isConfirmedZero: false,
        refetch: () => {},
      },
      automation: {
        isEnrolled: true,
        isPaused: false,
        isActive: true,
        personalActive: true,
        service: FIXTURE_SERVICE_AVAILABLE,
        isPending: false,
        statusLabel: 'Active' as const,
        toggleAutomation: async () => {},
        dailyCapFormatted: '$5.00 per UTC day',
        dailyCapValue: 5,
        dailyCap6: 5_000_000n,
        usdcAllowanceFormatted: `${formatUsdc6(50_000_000n, 6)} USDC`,
        usdcAllowance6: 50_000_000n,
      },
      goals: {
        progressMode: 'manual-plan',
        items: [],
        primaryGoal: null,
        supportingGoals: [],
        addGoal: () => {},
        updateGoal: () => {},
      },
      activities: {
        items: [],
        recentItems: [],
        totalSaved: 0,
        totalRoundupSavings: 0,
        count: 0,
        roundupsCount: 0,
        hasActivities: false,
        isLoading: true,
        isError: false,
        errorMessage: null,
        refetch: () => {},
      },
    }
  }

  if (testFixture === 'connected-error') {
    return {
      isDemoMode: false,
      isArcMode: true,
      canSwitchToConnected: true,
      requestConnectedMode: () => ({ success: true }),
      setIsDemoMode: () => {},
      toggleMode: () => true,
      modeLabel: 'Connected Mode',
      modeBadge: { label: 'Verification Fixture', isDemo: false, sublabel: 'Mock RPC error state' },
      totalSavedFormatted: '--.--',
      account: {
        isConnected: true,
        address: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        displayAddress: '0x71C8...3A9F',
        maskedAccount: 'Savings •••• 3A9F',
        savingsDestination: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        hasDestination: true,
        isWrongNetwork: false,
      },
      savings: {
        ...buildSavingsFigures({
          confirmedRoundups6: { status: 'error', message: `${ACTIVE_NETWORK_LABEL} RPC connection timeout` },
          destinationUsdc6: { status: 'error', message: `${ACTIVE_NETWORK_LABEL} RPC connection timeout` },
          legacyVaultWei: { status: 'error', message: `${ACTIVE_NETWORK_LABEL} RPC connection timeout` },
        }),
        totalSavedFormatted: '--.--',
        totalSavedCents: 0n,
        previewBalanceCents: null,
        confirmedRoundupCount: null,
        recordedLast7DaysFormatted: 'Unavailable',
        roundupCountFormatted: 'RPC connection error',
        isLoading: false,
        isError: true,
        errorMessage: `${ACTIVE_NETWORK_LABEL} RPC connection timeout`,
        isVaultFunded: false,
        isConfirmedZero: false,
        refetch: () => {},
      },
      automation: {
        isEnrolled: true,
        isPaused: false,
        isActive: true,
        personalActive: true,
        service: FIXTURE_SERVICE_AVAILABLE,
        isPending: false,
        statusLabel: 'Active',
        toggleAutomation: async () => {},
        dailyCapFormatted: '$5.00 per UTC day',
        dailyCapValue: 5,
        dailyCap6: 5_000_000n,
        usdcAllowanceFormatted: `${formatUsdc6(50_000_000n, 6)} USDC`,
        usdcAllowance6: 50_000_000n,
      },
      goals: {
        progressMode: 'manual-plan',
        items: [],
        primaryGoal: null,
        supportingGoals: [],
        addGoal: () => {},
        updateGoal: () => {},
      },
      activities: {
        items: [],
        recentItems: [],
        totalSaved: 0,
        totalRoundupSavings: 0,
        count: 0,
        roundupsCount: 0,
        hasActivities: false,
        isLoading: false,
        isError: true,
        errorMessage: 'Failed to fetch activity records from server',
        refetch: () => {},
      },
    }
  }

  if (testFixture === 'connected-zero') {
    return {
      isDemoMode: false,
      isArcMode: true,
      canSwitchToConnected: true,
      requestConnectedMode: () => ({ success: true }),
      setIsDemoMode: () => {},
      toggleMode: () => true,
      modeLabel: 'Connected Mode',
      modeBadge: { label: 'Verification Fixture', isDemo: false, sublabel: 'Mock readings · no live funds' },
      totalSavedFormatted: '0.00',
      account: {
        isConnected: true,
        address: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        displayAddress: '0x71C8...3A9F',
        maskedAccount: 'Savings •••• 3A9F',
        savingsDestination: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        hasDestination: true,
        isWrongNetwork: false,
      },
      savings: {
        ...buildSavingsFigures({
          confirmedRoundups6: { status: 'simulated', value: 0n },
          destinationUsdc6: { status: 'simulated', value: 0n },
          legacyVaultWei: { status: 'simulated', value: 0n },
        }),
        totalSavedFormatted: '0.00',
        totalSavedCents: 0n,
        previewBalanceCents: null,
        confirmedRoundupCount: 0n,
        recordedLast7DaysFormatted: '$0.00 recorded by MOVY in the last 7 days',
        roundupCountFormatted: '0 roundups recorded',
        isLoading: false,
        isError: false,
        errorMessage: null,
        isVaultFunded: false,
        isConfirmedZero: true,
        refetch: () => {},
      },
      automation: {
        isEnrolled: true,
        isPaused: false,
        isActive: true,
        personalActive: true,
        service: FIXTURE_SERVICE_AVAILABLE,
        isPending: false,
        statusLabel: 'Active',
        toggleAutomation: async () => {},
        dailyCapFormatted: '$5.00 per UTC day',
        dailyCapValue: 5,
        dailyCap6: 5_000_000n,
        usdcAllowanceFormatted: `${formatUsdc6(50_000_000n, 6)} USDC`,
        usdcAllowance6: 50_000_000n,
      },
      goals: {
        progressMode: 'manual-plan',
        items: [],
        primaryGoal: null,
        supportingGoals: [],
        addGoal: () => {},
        updateGoal: () => {},
      },
      activities: {
        items: [],
        recentItems: [],
        totalSaved: 0,
        totalRoundupSavings: 0,
        count: 0,
        roundupsCount: 0,
        hasActivities: false,
        isLoading: false,
        isError: false,
        errorMessage: null,
        refetch: () => {},
      },
    }
  }

  const serviceFixture = testFixture !== null && Object.hasOwn(SERVICE_STATE_FIXTURES, testFixture)
    ? SERVICE_STATE_FIXTURES[testFixture as keyof typeof SERVICE_STATE_FIXTURES]
    : null
  if (testFixture === 'connected-active' || testFixture === 'connected-toggle-failure' || serviceFixture) {
    const fixtureActivityItem: DemoActivityItem = {
      id: 'act_1',
      merchant: 'USDC Payment',
      originalAmount: 3.4,
      roundedAmount: 4.0,
      savedAmount: 0.6,
      multiplier: 1,
      timestamp: 'Fixture recording time',
      txHash: '0x8f2d...4a1e',
      category: 'payment',
      type: 'roundup',
      status: 'confirmed',
      timestampBasis: 'recorded',
    }
    const fixtureGoal: DemoGoal = {
      id: 'wg_1',
      title: 'Emergency Cushion',
      target: 500,
      current: 48.6,
      icon: 'shield',
    }

    const fixturePersonalPaused = serviceFixture?.personalPaused ?? false
    const fixtureAvailability = resolveAutomationAvailability({
      isEnrolled: true,
      personalPaused: fixturePersonalPaused,
      globalPause: fixtureGlobalPause(serviceFixture?.service ?? 'available'),
      isPending: false,
    })

    return {
      isDemoMode: false,
      isArcMode: true,
      canSwitchToConnected: true,
      requestConnectedMode: () => ({ success: true }),
      setIsDemoMode: () => {},
      toggleMode: () => true,
      modeLabel: 'Connected Mode',
      modeBadge: { label: 'Verification Fixture', isDemo: false, sublabel: 'Mock readings · no live funds' },
      totalSavedFormatted: '48.60',
      account: {
        isConnected: true,
        address: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        displayAddress: '0x71C8...3A9F',
        maskedAccount: 'Savings •••• 3A9F',
        savingsDestination: '0x71C8A375E7B7A24B7f1013401c4B9A7659423A9F',
        hasDestination: true,
        isWrongNetwork: false,
      },
      savings: {
        ...buildSavingsFigures({
          confirmedRoundups6: { status: 'ready', value: 48_600_000n },
          destinationUsdc6: { status: 'simulated', value: 5_000_000n },
          legacyVaultWei: { status: 'simulated', value: 2n * 10n ** 18n },
        }),
        totalSavedFormatted: '48.60',
        totalSavedCents: 4860n,
        previewBalanceCents: null,
        confirmedRoundupCount: 48n,
        recordedLast7DaysFormatted: '$7.20 recorded by MOVY in the last 7 days',
        roundupCountFormatted: '9 roundups recorded',
        isLoading: false,
        isError: false,
        errorMessage: null,
        isVaultFunded: true,
        isConfirmedZero: false,
        refetch: () => {},
      },
      automation: {
        isEnrolled: true,
        isPaused: fixturePersonalPaused,
        isActive: fixtureAvailability.isActive,
        personalActive: fixtureAvailability.personalActive,
        service: {
          status: fixtureAvailability.serviceStatus,
          retry: () => {
            const target = window as FixtureWindow
            target.__movyFixtureServiceRetries = (target.__movyFixtureServiceRetries ?? 0) + 1
          },
        },
        isPending: false,
        statusLabel: fixtureAvailability.statusLabel,
        toggleAutomation: async () => {
          if (testFixture === 'connected-toggle-failure') {
            throw new Error('Mocked transaction receipt failure')
          }
          // Records the PERSONAL pause value the real flow would submit (never the service state).
          const target = window as FixtureWindow
          target.__movyFixtureSetPaused = [...(target.__movyFixtureSetPaused ?? []), !fixturePersonalPaused]
        },
        dailyCapFormatted: '$5.00 per UTC day',
        dailyCapValue: 5,
        dailyCap6: 5_000_000n,
        usdcAllowanceFormatted: `${formatUsdc6(50_000_000n, 6)} USDC`,
        usdcAllowance6: 50_000_000n,
      },
      goals: {
        progressMode: 'manual-plan',
        items: [fixtureGoal],
        primaryGoal: fixtureGoal,
        supportingGoals: [],
        addGoal: () => {},
        updateGoal: () => {},
      },
      activities: {
        items: [fixtureActivityItem],
        recentItems: [fixtureActivityItem],
        totalSaved: 48.6,
        totalRoundupSavings: 48.6,
        count: 1,
        roundupsCount: 1,
        hasActivities: true,
        isLoading: false,
        isError: false,
        errorMessage: null,
        refetch: () => {},
      },
    }
  }

  return {
    isDemoMode,
    isArcMode: !isDemoMode,
    canSwitchToConnected,
    requestConnectedMode,
    setIsDemoMode: handleSetIsDemoMode,
    toggleMode,
    modeLabel: isDemoMode ? 'Demo' : 'Connected',
    modeBadge,
    totalSavedFormatted: savingsData.totalSavedFormatted,
    account,
    savings: savingsData,
    automation,
    goals: goalsData,
    activities: activitiesData,
  }
}
