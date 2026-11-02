'use client'

import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Address, Hash } from 'viem'
import { useReadContract } from 'wagmi'
import { useWallet } from './use-wallet'
import { MOVY_ABI } from '@/lib/contract'
import { ACTIVE_CHAIN_ID, CANONICAL_ARC_USDC, type ArcNetwork } from '@/lib/chain'
import { ERC20_ABI } from '@/lib/abi/movy-auto-saver'
import { resolveMoneyQuery, type MoneyRead } from '@/lib/savings-accounting'
import { fetchPurchases, fetchWithdrawals, findDeploymentBlock, type Purchase, type Withdrawal } from '@/lib/events'
import { weiToCents } from '@/lib/money'

/**
 * Bound on a single `eth_getLogs` window.
 *
 * Arc's public RPC **rejects** a range above roughly 5,000 blocks with
 * `"requested range too large"`, so windowing is mandatory, not cautious.
 */
const BLOCK_WINDOW = 2_000n

/**
 * How many windows one activity read may walk.
 *
 * Walking the whole span back to the deployment block is ~28 windows, two queries
 * each, plus a `getBlock` per row. That was repeating every 15 seconds and it is
 * how a phone gets a dropped request and "Failed to fetch" instead of an activity
 * list. MOVY's purchases are seconds old, so the recent windows are the ones that
 * matter; older history is reported as truncated rather than silently omitted.
 */
const MAX_WINDOWS = 4

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Max blocks scanned by one read, for the "showing recent activity" hint. */
const MAX_BLOCKS_SCANNED = BigInt(MAX_WINDOWS) * BLOCK_WINDOW

/**
 * Pinned deployment block per network, or undefined to fall back to discovery.
 *
 * Static member expressions only. A computed `process.env[key]` is not statically
 * analysable, so the bundler leaves it as a runtime lookup and it evaluates to
 * `undefined` in the browser. That bug shipped once here and the same mistake is
 * now documented in `src/lib/contract.ts`.
 */
const PINNED_DEPLOY_BLOCK_TESTNET = process.env.NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_TESTNET
const PINNED_DEPLOY_BLOCK_MAINNET = process.env.NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET

function pinnedDeployBlock(network: ArcNetwork): string | undefined {
  return network === 'mainnet' ? PINNED_DEPLOY_BLOCK_MAINNET : PINNED_DEPLOY_BLOCK_TESTNET
}

export interface SavingsData {
  savingsWei: bigint
  savingsCents: bigint
  totalLiabilitiesWei: bigint
  purchases: Purchase[]
  withdrawals: Withdrawal[]
  savedThisWeekCents: bigint
  roundupCountThisWeek: number
  /** True when older history exists beyond what the bounded read scanned. */
  isTruncated: boolean
  isLoading: boolean
  isError: boolean
  error: string | null
  /** Current owner balance in the legacy MovySavings contract; errors remain unknown. */
  legacyVault: MoneyRead<bigint>
  /** Current USDC balance at the user's distinct, configured savings destination. */
  destinationBalance6: MoneyRead<bigint>
  /** Freshly re-read the legacy vault before an owner withdrawal is submitted. */
  refetchLegacyVault: () => Promise<MoneyRead<bigint>>
  refetch: () => void
  isStale: boolean
}

const ZERO = {
  savingsWei: 0n,
  totalLiabilitiesWei: 0n,
  purchases: [] as Purchase[],
  withdrawals: [] as Withdrawal[],
}

/**
 * Reads savings and activity from the chain.
 *
 * The legacy MovySavings vault and the separately owned ERC-20 savings wallet are
 * read independently. Numeric compatibility aliases remain for older read-only
 * consumers; transaction and money surfaces use the explicit read states below.
 */
export function useSavings(destination?: Address, { enabled: surfaceEnabled = true }: { enabled?: boolean } = {}) {
  const { address, contract, isConnected, isWrongNetwork, network } = useWallet({ readEnabled: surfaceEnabled })
  const queryClient = useQueryClient()

  // Connected round-ups run on the AutoSaver and the user's separate savings wallet. The legacy
  // MovySavings contract is optional: its reads and events are gated on ITS address, and the
  // savings-wallet balance does not depend on it.
  const walletReady = surfaceEnabled && isConnected && !isWrongNetwork && address !== undefined
  const enabled = walletReady && contract !== undefined
  const destinationEnabled = walletReady && destination !== undefined

  const savingsRead = useReadContract({
    chainId: ACTIVE_CHAIN_ID,
    address: contract,
    abi: MOVY_ABI,
    functionName: 'savingsOf',
    args: [address ?? '0x0000000000000000000000000000000000000000' as Address],
    query: {
      enabled,
      // A public endpoint on a phone drops requests. Retry with backoff before
      // calling it an error.
      retry: 2,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
      refetchOnWindowFocus: false,
    },
  })

  const destinationRead = useReadContract({
    chainId: ACTIVE_CHAIN_ID,
    address: CANONICAL_ARC_USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: destination ? [destination] : undefined,
    query: {
      enabled: destinationEnabled,
      retry: 2,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
      refetchOnWindowFocus: false,
    },
  })

  const liabilitiesRead = useReadContract({
    chainId: ACTIVE_CHAIN_ID,
    address: contract,
    abi: MOVY_ABI,
    functionName: 'totalLiabilities',
    query: { enabled, retry: 2, retryDelay: 1_500, refetchOnWindowFocus: false },
  })

  const activity = useQuery({
    queryKey: ['movy-activity', network, contract, address],
    enabled,
    staleTime: 15_000,
    // 60s, not 15s, and paused while the tab is hidden: one read is several
    // requests, so a 15s interval is enough to get a phone rate-limited.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 2,
    retryDelay: (attempt) => Math.min(1_500 * 2 ** attempt, 10_000),
    queryFn: async () => {
      if (!contract || !address) {
        return { purchases: [] as Purchase[], withdrawals: [] as Withdrawal[], truncated: false }
      }
      const { publicClientFor } = await import('@/lib/events')
      const client = publicClientFor(network)

      const pinned = pinnedDeployBlock(network)
      const fromBlock = pinned ? BigInt(pinned) : await findDeploymentBlock(client, contract)

      const head = await client.getBlockNumber()
      const purchases: Purchase[] = []
      const withdrawals: Withdrawal[] = []

      let to = head
      let windows = 0
      while (to >= fromBlock && windows < MAX_WINDOWS) {
        const from = to - BLOCK_WINDOW > fromBlock ? to - BLOCK_WINDOW : fromBlock
        const [p, w] = await Promise.all([
          fetchPurchases(client, {
            address: contract,
            payer: address,
            fromBlock: from,
            toBlock: to,
            limit: 60,
          }),
          fetchWithdrawals(client, {
            address: contract,
            owner: address,
            fromBlock: from,
            toBlock: to,
            limit: 60,
          }),
        ])
        purchases.push(...p)
        withdrawals.push(...w)
        to = from - 1n
        windows += 1
      }

      return {
        purchases,
        withdrawals,
        truncated: to >= fromBlock,
        // Bucketed here rather than during render: `Date.now()` is not a pure
        // function and must not be called while rendering.
        savedThisWeekCents: purchases
          .filter((p) => p.timestamp >= Date.now() - WEEK_MS)
          .reduce((sum, p) => sum + p.roundupCents, 0n),
        roundupCountThisWeek: purchases.filter((p) => p.timestamp >= Date.now() - WEEK_MS).length,
      }
    },
  })

  const purchases = useMemo(() => activity.data?.purchases ?? [], [activity.data])
  const withdrawals = useMemo(() => activity.data?.withdrawals ?? [], [activity.data])

  // Absent legacy contract: unavailable/not configured. A configured contract keeps its RPC
  // errors visible.
  const legacyVault = resolveMoneyQuery({
    isConnected,
    isWrongNetwork,
    isLoading: savingsRead.isLoading,
    isError: savingsRead.isError,
    error: savingsRead.error,
    data: savingsRead.data as bigint | undefined,
    unavailableReason: contract === undefined ? 'not-configured' : undefined,
  })

  const destinationBalance6 = resolveMoneyQuery({
    isConnected,
    isWrongNetwork,
    isLoading: destinationRead.isLoading,
    isError: destinationRead.isError,
    error: destinationRead.error,
    data: destinationRead.data as bigint | undefined,
    unavailableReason: destination ? undefined : 'no-destination',
  })

  const refetchLegacyVault = useCallback(async (): Promise<MoneyRead<bigint>> => {
    if (!enabled) {
      return resolveMoneyQuery<bigint>({
        isConnected,
        isWrongNetwork,
        isLoading: false,
        isError: false,
        error: null,
        data: undefined,
        unavailableReason: contract === undefined ? 'not-configured' : undefined,
      })
    }

    const result = await savingsRead.refetch()
    return resolveMoneyQuery({
      isConnected,
      isWrongNetwork,
      isLoading: result.isFetching,
      isError: result.isError,
      error: result.error,
      data: result.data as bigint | undefined,
    })
  }, [enabled, contract, isConnected, isWrongNetwork, savingsRead])

  // `refetch()` ignores a query's `enabled` flag, so only refetch what is actually configured.
  const refetch = useCallback(() => {
    if (enabled) {
      void savingsRead.refetch()
      void liabilitiesRead.refetch()
      void activity.refetch()
    }
    if (destinationEnabled) void destinationRead.refetch()
  }, [enabled, destinationEnabled, savingsRead, destinationRead, liabilitiesRead, activity])

  // Keep these numeric aliases for legacy read-only consumers. Money-sensitive
  // surfaces use `legacyVault` so an unavailable RPC read is never represented as
  // a confirmed zero balance.
  const savingsWei = legacyVault.status === 'ready' ? legacyVault.value : 0n

  return {
    savingsWei,
    savingsCents: weiToCents(savingsWei),
    legacyVault,
    destinationBalance6,
    refetchLegacyVault,
    totalLiabilitiesWei: (liabilitiesRead.data as bigint | undefined) ?? 0n,
    purchases,
    withdrawals,
    savedThisWeekCents: activity.data?.savedThisWeekCents ?? 0n,
    roundupCountThisWeek: activity.data?.roundupCountThisWeek ?? 0,
    isTruncated: activity.data?.truncated ?? false,
    // Legacy vault and legacy event reads only. The savings-wallet balance has its own read state
    // (`destinationBalance6`), which surfaces its own errors; it must not mark the purchase and
    // withdrawal history as failed or loading.
    isLoading: savingsRead.isLoading || activity.isLoading,
    isError: savingsRead.isError || activity.isError,
    error:
      (savingsRead.error as Error | null)?.message ??
      (activity.error as Error | null)?.message ??
      null,
    refetch,
    // "Stale" means a previous chain read is on screen while a newer one is in
    // flight. Derived, not stored, so it can never disagree with the query.
    isStale: savingsRead.isFetching && !savingsRead.isLoading,
    queryClient,
  } satisfies SavingsData & { queryClient: unknown }
}

export { ZERO, MAX_BLOCKS_SCANNED }
export type { Address, Hash }
