import { timingSafeEqual } from 'node:crypto'
import { isAddress, type Address } from 'viem'
import { getActiveChainId } from './config'
import { MAX_WORKER_BLOCKS } from './worker-limits'
import { WorkerAlreadyRunningError, WorkerLockLostError } from './worker-lock'

export { MAX_WORKER_BLOCKS } from './worker-limits'
const MAX_BODY_BYTES = 4_096
const MIN_TOKEN_BYTES = 32

type WorkerCycle = (
  chainId: number,
  options: { maxBlocks: number; targetWallet?: Address }
) => Promise<unknown>

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function matchesBearerToken(request: Request, configuredToken: string | undefined): 'unconfigured' | 'unauthorized' | 'authorized' {
  if (!configuredToken || Buffer.byteLength(configuredToken, 'utf8') < MIN_TOKEN_BYTES) {
    return 'unconfigured'
  }

  const header = request.headers.get('authorization')
  if (!header || header.length > 1_024) return 'unauthorized'
  const match = /^Bearer ([^\s]+)$/i.exec(header)
  if (!match) return 'unauthorized'

  const provided = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(configuredToken, 'utf8')
  if (provided.length !== expected.length) return 'unauthorized'
  return timingSafeEqual(provided, expected) ? 'authorized' : 'unauthorized'
}

async function readBoundedBody(request: Request): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    byteLength += value.byteLength
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function parseWorkerBody(value: unknown, activeChainId: number):
  | { ok: true; options: { maxBlocks: number; targetWallet?: Address } }
  | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }

  const body = value as Record<string, unknown>
  const allowedKeys = new Set(['chainId', 'maxBlocks', 'targetWallet'])
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return { ok: false, error: 'Request contains unsupported fields' }
  }

  if (body.chainId !== undefined && body.chainId !== activeChainId) {
    return { ok: false, error: `Request chainId must match this MOVY deployment (chain ${activeChainId})` }
  }

  const maxBlocks = body.maxBlocks === undefined ? MAX_WORKER_BLOCKS : body.maxBlocks
  if (typeof maxBlocks !== 'number' || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_WORKER_BLOCKS) {
    return { ok: false, error: `maxBlocks must be an integer from 1 to ${MAX_WORKER_BLOCKS}` }
  }

  if (body.targetWallet !== undefined && (typeof body.targetWallet !== 'string' || !isAddress(body.targetWallet, { strict: false }))) {
    return { ok: false, error: 'targetWallet must be a valid address' }
  }

  return {
    ok: true,
    options: {
      maxBlocks,
      ...(typeof body.targetWallet === 'string' ? { targetWallet: body.targetWallet as Address } : {}),
    },
  }
}

export async function handleWorkerTick(
  request: Request,
  runCycle: WorkerCycle,
  configuredToken: string | undefined
): Promise<Response> {
  const auth = matchesBearerToken(request, configuredToken)
  if (auth === 'unconfigured') {
    return json({ error: 'Worker execution is not configured' }, 503)
  }
  if (auth === 'unauthorized') {
    return json({ error: 'Unauthorized' }, 401)
  }
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: 'Request body is too large' }, 413)
  }

  let text: string | null
  try {
    text = await readBoundedBody(request)
  } catch {
    return json({ error: 'Could not read request body' }, 400)
  }
  if (text === null) return json({ error: 'Request body is too large' }, 413)

  let body: unknown = {}
  try {
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return json({ error: 'Request body must be valid JSON' }, 400)
  }

  let activeChainId: number
  try {
    activeChainId = getActiveChainId()
  } catch {
    return json({ error: 'Worker network configuration is unavailable' }, 503)
  }
  const parsed = parseWorkerBody(body, activeChainId)
  if (!parsed.ok) return json({ error: parsed.error }, 400)
  if (process.env.MOVY_WORKER_ENABLED !== 'true') {
    return json({ error: 'Worker execution is disabled' }, 503)
  }

  try {
    const result = await runCycle(activeChainId, parsed.options)
    return json(result, 200)
  } catch (error) {
    if (error instanceof WorkerAlreadyRunningError) {
      return json({ error: 'A worker cycle is already running' }, 409)
    }
    if (error instanceof WorkerLockLostError) {
      return json({ error: 'Worker cycle lost its execution lease' }, 503)
    }
    return json({ error: 'Worker cycle failed' }, 500)
  }
}
