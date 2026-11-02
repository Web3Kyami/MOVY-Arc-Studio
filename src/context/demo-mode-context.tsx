'use client'

import React, { createContext, useContext, useState, useEffect, useCallback, useSyncExternalStore } from 'react'

export interface DemoGoal {
  id: string
  title: string
  target: number
  current: number
  icon: string
  category?: string
}

export interface DemoActivityItem {
  id: string
  merchant: string
  originalAmount: number
  roundedAmount: number
  savedAmount: number
  multiplier: 1 | 2 | 3
  timestamp: string
  txHash: string
  category: 'coffee' | 'grocery' | 'transport' | 'tech' | 'dining' | 'payment' | 'deposit' | 'withdrawal'
  type: 'roundup' | 'deposit' | 'withdrawal'
  status?: 'confirmed' | 'pending' | 'failed' | 'skipped'
  skipReason?: string
  paymentTxHash?: string
  relayerTxHash?: string
  logIndex?: number
  /** Exact connected-mode display values, kept as strings to avoid float rounding. */
  originalAmountText?: string
  roundedAmountText?: string
  savedAmountText?: string
  /** Observer rows have recorded/indexed time, not verified payment time. */
  timestampBasis?: 'recorded' | 'on-chain' | 'simulated'
  /** Fees are only shown when sourced from an actual transaction receipt. */
  feeText?: string
}

export interface DemoProfile {
  name: string
  isEnrolled: boolean
  isPaused: boolean
  dailyCap: number
  totalSaved: number
}

interface DemoModeContextType {
  isDemoMode: boolean
  browserTestFixturesEnabled: boolean
  profile: DemoProfile
  goals: DemoGoal[]
  addGoal: (goal: Omit<DemoGoal, 'id' | 'current'>) => void
  updateGoal: (id: string, updates: Partial<DemoGoal>) => void
  activities: DemoActivityItem[]
}

const DEFAULT_PROFILE: DemoProfile = {
  name: 'Alex',
  isEnrolled: true,
  isPaused: false,
  dailyCap: 5.0,
  totalSaved: 355.00,
}

const DEFAULT_GOALS: DemoGoal[] = [
  {
    id: 'g1',
    title: 'Emergency Cushion',
    target: 500,
    current: 355,
    icon: '🛡️',
    category: 'Safety',
  },
  {
    id: 'g2',
    title: 'Japan Adventure',
    target: 1000,
    current: 0,
    icon: '✈️',
    category: 'Travel',
  },
  {
    id: 'g3',
    title: 'Next Gadget Stash',
    target: 250,
    current: 0,
    icon: '⚡',
    category: 'Tech',
  },
]

const DEFAULT_ACTIVITIES: DemoActivityItem[] = [
  {
    id: 'a1',
    merchant: 'Arc Coffee Roasters',
    originalAmount: 3.4,
    roundedAmount: 4.0,
    savedAmount: 0.6,
    multiplier: 1,
    timestamp: 'Example entry',
    txHash: '',
    category: 'coffee',
    type: 'roundup',
  },
  {
    id: 'a2',
    merchant: 'Whole Foods Market',
    originalAmount: 47.1,
    roundedAmount: 48.0,
    savedAmount: 0.9,
    multiplier: 1,
    timestamp: 'Example entry',
    txHash: '',
    category: 'grocery',
    type: 'roundup',
  },
  {
    id: 'a3',
    merchant: 'Uber Ride',
    originalAmount: 18.25,
    roundedAmount: 19.0,
    savedAmount: 0.75,
    multiplier: 1,
    timestamp: 'Example entry',
    txHash: '',
    category: 'transport',
    type: 'roundup',
  },
  {
    id: 'a4',
    merchant: 'Apple Services',
    originalAmount: 9.99,
    roundedAmount: 10.0,
    savedAmount: 0.01,
    multiplier: 1,
    timestamp: 'Example entry',
    txHash: '',
    category: 'tech',
    type: 'roundup',
  },
  {
    id: 'a5',
    merchant: 'Joe & The Juice',
    originalAmount: 8.35,
    roundedAmount: 9.0,
    savedAmount: 0.65,
    multiplier: 1,
    timestamp: 'Example entry',
    txHash: '',
    category: 'coffee',
    type: 'roundup',
  },
]

const DemoModeContext = createContext<DemoModeContextType | null>(null)

const subscribeHydration = () => () => {}

export function DemoModeProvider({ children, siteRole, browserTestFixturesEnabled = false }: {
  children: React.ReactNode
  siteRole: 'product' | 'demo'
  browserTestFixturesEnabled?: boolean
}) {
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false)
  // The server-selected origin is authoritative. Browser storage and query
  // parameters can never switch the product into Demo or unlock the wallet.
  const isDemoMode = siteRole === 'demo'

  const profile = DEFAULT_PROFILE

  const [goals, setGoals] = useState<DemoGoal[]>(() => {
    if (siteRole === 'demo' && typeof window !== 'undefined') {
      const stored = localStorage.getItem('movy_demo_v2_goals')
      if (stored) {
        try {
          return JSON.parse(stored)
        } catch {
          // ignore
        }
      }
    }
    return DEFAULT_GOALS
  })

  // Example activity and savings data never change; the Demo origin permits
  // edits only to profile and goal-plan storage.
  const activities = DEFAULT_ACTIVITIES

  useEffect(() => {
    if (siteRole === 'demo' && typeof window !== 'undefined') {
      localStorage.setItem('movy_demo_v2_goals', JSON.stringify(goals))
    }
  }, [goals, siteRole])

  const addGoal = useCallback((goal: Omit<DemoGoal, 'id' | 'current'>) => {
    if (siteRole !== 'demo') return
    const newGoal: DemoGoal = { ...goal, id: `g_${crypto.randomUUID()}`, current: 0 }
    const nextGoals = [...goals, newGoal]
    // Persist before reporting success, so quota/permission failures stay recoverable.
    localStorage.setItem('movy_demo_v2_goals', JSON.stringify(nextGoals))
    setGoals(nextGoals)
  }, [goals, siteRole])

  const updateGoal = useCallback((id: string, updates: Partial<DemoGoal>) => {
    if (siteRole !== 'demo') return
    setGoals((prev) => prev.map((g) => (g.id === id ? { ...g, ...updates } : g)))
  }, [siteRole])

  return (
    <DemoModeContext.Provider
      value={{
        isDemoMode,
        browserTestFixturesEnabled: browserTestFixturesEnabled && siteRole === 'product',
        profile: siteRole === 'demo' && !hydrated ? DEFAULT_PROFILE : profile,
        goals: siteRole === 'demo' && !hydrated ? DEFAULT_GOALS : goals,
        addGoal,
        updateGoal,
        activities: siteRole === 'demo' && !hydrated ? DEFAULT_ACTIVITIES : activities,
      }}
    >
      {children}
    </DemoModeContext.Provider>
  )
}

export function useDemoMode() {
  const context = useContext(DemoModeContext)
  if (!context) {
    throw new Error('useDemoMode must be used within a DemoModeProvider')
  }
  return context
}
