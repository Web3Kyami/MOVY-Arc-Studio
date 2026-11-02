import { NextResponse } from 'next/server'
import { getActivityForWallet } from '@/lib/server/db'
import { resolveRequestedChainId } from '@/lib/server/request-network'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'

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
    return NextResponse.json({ error: `Unsupported network. This MOVY deployment is configured for ${network.networkName} (chain ${network.expectedChainId})` }, { status: 400 })
  }
  const chainId = network.chainId

  if (!wallet) {
    return NextResponse.json({ error: 'Missing wallet query parameter' }, { status: 400 })
  }

  // Address validation: must be a 20-byte hex string
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return NextResponse.json({ error: 'Invalid wallet address format' }, { status: 400 })
  }

  let items
  try {
    items = await getActivityForWallet(chainId, wallet)
  } catch {
    return NextResponse.json({ error: 'Activity is temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json({
    chainId,
    wallet,
    activity: items,
  })
}
