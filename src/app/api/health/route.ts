import { getDatabaseHealth } from '@/lib/server/db'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  try {
    const database = await getDatabaseHealth()
    if (!database.ready) {
      return Response.json({ status: 'not_ready', database: { ready: false } }, {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    return Response.json({
      status: 'ok',
      database: { ready: true, schemaVersion: database.version },
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ status: 'not_ready', database: { ready: false } }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
