'use client'

import { useAccount } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { ACTIVE_CHAIN_ID } from '@/lib/chain'
import { fetchConfirmedRoundupSummary } from '@/lib/confirmed-roundup-summary'
import type { WalletActivityItem } from '@/types/activity'

export function useAutoActivity({ enabled = true }: { enabled?: boolean } = {}) {
  const { address, chainId, isConnected } = useAccount()
  const isWrongNetwork = Boolean(isConnected && chainId !== ACTIVE_CHAIN_ID)

  // The recent feed deliberately stays capped for UI performance. It is not a
  // source for lifetime totals; those come from the independent DB aggregate.
  const activityQuery = useQuery<{ activity: WalletActivityItem[] }>({
    queryKey: ['autoActivity', address, ACTIVE_CHAIN_ID],
    queryFn: async () => {
      if (!address || isWrongNetwork) return { activity: [] }
      let res = await fetch(`/api/auto-saver/activity?wallet=${address}&chainId=${ACTIVE_CHAIN_ID}`)
      if (!res.ok) {
        // Fallback to legacy endpoint if needed
        res = await fetch(`/api/activity?wallet=${address}&chainId=${ACTIVE_CHAIN_ID}`)
      }
      if (!res.ok) throw new Error('Failed to fetch recent round-up activity')
      const payload = await res.json() as { activity?: WalletActivityItem[] }
      return { activity: Array.isArray(payload.activity) ? payload.activity : [] }
    },
    enabled: Boolean(enabled && isConnected && address && !isWrongNetwork),
    refetchInterval: 3000,
  })

  const summaryQuery = useQuery({
    queryKey: ['autoActivity-summary', address, ACTIVE_CHAIN_ID],
    queryFn: async () => {
      if (!address) throw new Error('Connect the enrolled wallet to read confirmed round-up totals.')
      return fetchConfirmedRoundupSummary(address, ACTIVE_CHAIN_ID)
    },
    enabled: Boolean(enabled && isConnected && address && !isWrongNetwork),
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: 2,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
  })

  return {
    items: activityQuery.data?.activity ?? [],
    confirmedRoundups6: summaryQuery.data?.confirmedRoundups6,
    confirmedRoundupCount: summaryQuery.data?.confirmedRoundupCount,
    recordedLast7DaysRoundups6: summaryQuery.data?.recordedLast7DaysRoundups6,
    summaryIsLoading: summaryQuery.isLoading,
    summaryIsError: summaryQuery.isError,
    summaryErrorMessage: (summaryQuery.error as Error | null)?.message ?? null,
    isLoading: activityQuery.isLoading,
    isError: activityQuery.isError,
    errorMessage: (activityQuery.error as Error | null)?.message ?? null,
    isWrongNetwork,
    refetch: () => {
      return Promise.all([activityQuery.refetch(), summaryQuery.refetch()]).then(() => undefined)
    },
  }
}
