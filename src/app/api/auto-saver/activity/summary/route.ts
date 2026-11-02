import { NextResponse } from 'next/server'
import { resolveRequestedChainId } from '@/lib/server/request-network'
import { getConfirmedRoundupSummaryForWallet } from '@/lib/server/db'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function GET(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  const { searchParams } = new URL(request.url)
  const wallet = searchParams.get('wallet')
  let network
  try {
    network = resolveRequestedChainId(searchParams.get('chainId'))
  } catch {
    return NextResponse.json({ error: 'MOVY network configuration is unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!network.ok) {
    return NextResponse.json(
      { error: `Unsupported network. This MOVY deployment is configured for ${network.networkName} (chain ${network.expectedChainId})` },
      { status: 400 },
    )
  }
  const chainId = network.chainId

  if (!wallet) {
    return NextResponse.json({ error: 'Missing wallet query parameter' }, { status: 400 })
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: 'Invalid wallet address format' }, { status: 400 })
  }

  try {
    const sinceIso = new Date(Date.now() - SEVEN_DAYS_MS).toISOString()
    const summary = await getConfirmedRoundupSummaryForWallet(chainId, wallet, sinceIso)

    return NextResponse.json({ chainId, wallet, ...summary })
  } catch {
    return NextResponse.json(
      { error: 'Confirmed round-up totals are temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
