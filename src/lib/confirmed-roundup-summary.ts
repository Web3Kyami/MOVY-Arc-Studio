export interface ConfirmedRoundupSummary {
  confirmedRoundups6: bigint
  confirmedRoundupCount: bigint
  recordedLast7DaysRoundups6: bigint
}

interface SummaryPayload {
  chainId?: unknown
  wallet?: unknown
  confirmedRoundups6?: unknown
  confirmedRoundupCount?: unknown
  recordedLast7DaysRoundups6?: unknown
  error?: unknown
}

function integerString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

/** Fetch and validate the unbounded, wallet-specific confirmed-roundup summary. */
export async function fetchConfirmedRoundupSummary(
  wallet: string,
  chainId: number,
  fetcher: typeof fetch = fetch,
): Promise<ConfirmedRoundupSummary> {
  const query = new URLSearchParams({ wallet, chainId: String(chainId) })
  const response = await fetcher(`/api/auto-saver/activity/summary?${query.toString()}`)

  let payload: SummaryPayload | null = null
  try {
    payload = await response.json() as SummaryPayload
  } catch {
    // A failed or malformed response remains an error, never a zero aggregate.
  }

  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string'
      ? payload.error
      : 'Failed to fetch confirmed round-up totals.')
  }

  if (
    !payload ||
    payload.chainId !== chainId ||
    typeof payload.wallet !== 'string' ||
    payload.wallet.toLowerCase() !== wallet.toLowerCase()
  ) {
    throw new Error('Confirmed round-up totals did not match the connected wallet and network.')
  }

  if (
    !integerString(payload.confirmedRoundups6) ||
    !integerString(payload.confirmedRoundupCount) ||
    !integerString(payload.recordedLast7DaysRoundups6)
  ) {
    throw new Error('Confirmed round-up totals are invalid.')
  }

  return {
    confirmedRoundups6: BigInt(payload.confirmedRoundups6),
    confirmedRoundupCount: BigInt(payload.confirmedRoundupCount),
    recordedLast7DaysRoundups6: BigInt(payload.recordedLast7DaysRoundups6),
  }
}
