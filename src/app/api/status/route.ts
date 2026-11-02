import { NextResponse } from 'next/server'
import { getCursor, getStats } from '@/lib/server/db'
import { getAutoSaverAddress } from '@/lib/server/config'
import { resolveRequestedChainId } from '@/lib/server/request-network'
import { getRelayerAccount } from '@/lib/server/relayer'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'

export async function GET(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  const { searchParams } = new URL(request.url)
  let network
  try {
    network = resolveRequestedChainId(searchParams.get('chainId'))
  } catch {
    return NextResponse.json({ error: 'MOVY network configuration is unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!network.ok) {
    return NextResponse.json({ error: `Unsupported network. This MOVY deployment is configured for ${network.networkName} (chain ${network.expectedChainId})` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const chainId = network.chainId

  let autoSaverAddress: string | null = null
  try {
    autoSaverAddress = getAutoSaverAddress(chainId)
  } catch {
    // ignore
  }

  let cursor
  let stats
  let relayer
  try {
    const [currentCursor, currentStats] = await Promise.all([getCursor(chainId), getStats(chainId)])
    cursor = currentCursor
    stats = currentStats
    relayer = getRelayerAccount()?.address ?? null
  } catch {
    return NextResponse.json({ error: 'Status is temporarily unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  return NextResponse.json({
    chainId,
    cursor,
    autoSaverAddress,
    relayerAddress: relayer,
    relayerConfigured: relayer !== null,
    activeUsers: stats.activeUsers,
    totalSaved6: stats.totalSaved6.toString(),
    totalRoundups: stats.totalRoundups,
    timestamp: new Date().toISOString(),
  })
}
