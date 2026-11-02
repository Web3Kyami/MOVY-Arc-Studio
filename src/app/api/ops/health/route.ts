import { timingSafeEqual } from 'node:crypto'
import { getOperationalSignals } from '@/lib/server/db'
import { getActiveChainId } from '@/lib/server/config'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 10

function authorized(request: Request): boolean {
  const token = process.env.MOVY_OPS_AUTH_TOKEN
  const header = request.headers.get('authorization')
  if (!token || Buffer.byteLength(token, 'utf8') < 32 || !header || header.length > 1024) return false
  const match = /^Bearer ([^\s]+)$/i.exec(header)
  if (!match) return false
  const provided = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

export async function GET(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  if (!authorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  try {
    const chainId = getActiveChainId()
    const signals = await getOperationalSignals(chainId)
    return Response.json({ chainId, ...signals }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: 'Operational signals are temporarily unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
