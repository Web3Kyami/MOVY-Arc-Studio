import { runWorkerCycle } from '@/lib/server/worker'
import { handleWorkerTick } from '@/lib/server/worker-api'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'

export async function POST(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  return handleWorkerTick(request, runWorkerCycle, process.env.MOVY_WORKER_AUTH_TOKEN)
}

export const runtime = 'nodejs'
export const maxDuration = 60
