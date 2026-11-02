import { timingSafeEqual } from 'node:crypto'
import { runWorkerCycle } from '@/lib/server/worker'
import { getActiveChainId } from '@/lib/server/config'
import { MAX_WORKER_BLOCKS } from '@/lib/server/worker-limits'
import { WorkerAlreadyRunningError, WorkerLockLostError } from '@/lib/server/worker-lock'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

function response(body: unknown, status: number) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  const header = request.headers.get('authorization')
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || !header || header.length > 1024) return false
  const match = /^Bearer ([^\s]+)$/i.exec(header)
  if (!match) return false
  const provided = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(secret, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

/** Vercel Cron target. It has no schedule in the default vercel.json. */
export async function GET(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  if (!isAuthorized(request)) return response({ error: 'Unauthorized' }, 401)
  if (process.env.MOVY_WORKER_ENABLED !== 'true') return response({ error: 'Worker execution is disabled' }, 503)

  const configuredMax = process.env.MOVY_WORKER_MAX_BLOCKS
  const maxBlocks = configuredMax === undefined ? MAX_WORKER_BLOCKS : Number(configuredMax)
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_WORKER_BLOCKS) {
    return response({ error: 'Worker block limit configuration is invalid' }, 503)
  }

  try {
    const chainId = getActiveChainId()
    return response(await runWorkerCycle(chainId, { maxBlocks }), 200)
  } catch (error) {
    if (error instanceof WorkerAlreadyRunningError) return response({ error: 'A worker cycle is already running' }, 409)
    if (error instanceof WorkerLockLostError) return response({ error: 'Worker cycle lost its execution lease' }, 503)
    console.error('movy_scheduled_worker_failed', { code: error instanceof Error ? error.name : 'unknown' })
    return response({ error: 'Worker cycle failed' }, 500)
  }
}
