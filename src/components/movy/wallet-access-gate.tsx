'use client'

import { useCallback, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { useDemoMode } from '@/context/demo-mode-context'
import { Wordmark } from '@/components/movy/nav'

const subscribeToHydration = () => () => {}
const getClientSnapshot = () => true
const getServerSnapshot = () => false
const TEST_FIXTURE_EVENT = 'movy:test-fixture-change'

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

function browserFixtureSnapshot(enabled: boolean): string | null {
  if (!enabled || typeof window === 'undefined') return null
  const queryFixture = new URLSearchParams(window.location.search).get('fixture')
  try {
    return queryFixture ?? window.localStorage.getItem('movy_test_fixture')
  } catch {
    return queryFixture
  }
}

function WalletAccessLoading() {
  return (
    <div className="min-h-dvh bg-[#f6f5f0] px-5" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Checking wallet connection</span>
      <div className="mx-auto w-full max-w-[520px]">
        <header className="flex h-[68px] items-center">
          <Wordmark className="text-xl" />
        </header>
        <main className="grid min-h-[calc(100dvh-68px)] place-items-center">
          <div aria-hidden="true" className="w-full max-w-sm space-y-6">
            <div className="mx-auto h-8 w-56 rounded-lg bg-stone-200 motion-safe:animate-pulse" />
            <div className="h-12 w-full rounded-full bg-stone-200 motion-safe:animate-pulse" />
          </div>
        </main>
      </div>
    </div>
  )
}

function ConnectWalletGate() {
  return (
    <div className="min-h-dvh bg-[#f6f5f0] px-5">
      <div className="mx-auto w-full max-w-[520px]">
        <header className="flex h-[68px] items-center">
          <Wordmark className="text-xl" />
        </header>
        <main id="main" className="grid min-h-[calc(100dvh-68px)] place-items-center">
          <section aria-labelledby="wallet-access-title" className="w-full max-w-sm">
            <h1 id="wallet-access-title" className="text-center text-2xl font-bold tracking-tight text-[#191d1a]">
              Connect your wallet
            </h1>
            <Link
              href="/onboarding"
              className="mt-7 flex min-h-12 w-full items-center justify-center rounded-full bg-[#087f5b] px-5 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-[#066848] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#087f5b]"
            >
              Connect wallet
            </Link>
          </section>
        </main>
      </div>
    </div>
  )
}

export function WalletAccessGate({ children }: { children: React.ReactNode }) {
  const { status } = useAccount()
  const { isDemoMode, browserTestFixturesEnabled } = useDemoMode()
  const clientReady = useSyncExternalStore(
    subscribeToHydration,
    getClientSnapshot,
    getServerSnapshot
  )
  const getFixtureSnapshot = useCallback(
    () => browserFixtureSnapshot(browserTestFixturesEnabled),
    [browserTestFixturesEnabled]
  )
  const browserFixture = useSyncExternalStore(
    subscribeToTestFixtures,
    getFixtureSnapshot,
    () => null
  )
  const connectedTestFixture = browserTestFixturesEnabled && browserFixture?.startsWith('connected-')

  // The isolated demo origin has its own sample identity and no wallet connector.
  if (isDemoMode || connectedTestFixture) return children

  if (!clientReady || status === 'connecting' || status === 'reconnecting') {
    return <WalletAccessLoading />
  }

  if (status !== 'connected') return <ConnectWalletGate />

  return children
}
