import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getActiveChainId, getConfiguredNetwork } from './config'
import { networkLabel } from '../chain'
import { resolveRequestedChainId } from './request-network'
import { consumeRateLimit } from './db'

const MAX_BODY_BYTES = 4_096
const WINDOW_MS = 60_000
const GET_IP_LIMIT = 120
const GET_WALLET_LIMIT = 30
const POST_IP_LIMIT = 30
const POST_WALLET_LIMIT = 10
const GET_CACHE_TTL_MS = 5_000
const MAX_CACHE_ENTRIES = 1_000

type EnrollmentApiResult = {
  enrollment: unknown
  onchainConfig: unknown
}

type EnrollmentSync = (chainId: number, wallet: string) => Promise<EnrollmentApiResult>

interface CacheEntry {
  expiresAt: number
  result: EnrollmentApiResult
}

const enrollmentCache = new Map<string, CacheEntry>()

function cacheKey(chainId: number, wallet: string): string {
  return `${chainId}:${wallet.toLowerCase()}`
}

function cachedEnrollment(key: string): EnrollmentApiResult | null {
  const entry = enrollmentCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    enrollmentCache.delete(key)
    return null
  }
  return entry.result
}

function cacheEnrollment(key: string, result: EnrollmentApiResult): void {
  const now = Date.now()
  for (const [existingKey, entry] of enrollmentCache) {
    if (entry.expiresAt <= now) enrollmentCache.delete(existingKey)
  }
  while (enrollmentCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = enrollmentCache.keys().next().value
    if (oldestKey === undefined) break
    enrollmentCache.delete(oldestKey)
  }
  enrollmentCache.set(key, { result, expiresAt: now + GET_CACHE_TTL_MS })
}

function invalidateEnrollmentCache(chainId: number, wallet: string): void {
  enrollmentCache.delete(cacheKey(chainId, wallet))
}

function clientIdentity(request: Request): string {
  // Only trust the proxy header when deployment explicitly opts in and the
  // reverse proxy overwrites it. Otherwise every caller shares a conservative
  // bucket rather than being able to spoof identities to evade throttling.
  if (process.env.MOVY_TRUST_PROXY_IP_HEADER !== 'x-real-ip') return 'unknown-client'
  const forwardedIp = request.headers.get('x-real-ip')?.trim()
  return forwardedIp && isIP(forwardedIp) ? forwardedIp : 'unknown-client'
}

function hashRateKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function limitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: 'Too many enrollment requests. Please retry shortly.' },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSeconds),
      },
    }
  )
}

async function applyRateLimit(request: Request, scope: string, identity: string, limit: number): Promise<Response | null> {
  try {
    const result = await consumeRateLimit(hashRateKey(`enrollment:${scope}:${identity}`), limit, WINDOW_MS)
    return result.allowed ? null : limitResponse(result.retryAfterSeconds)
  } catch {
    // Rate limiting is safety-critical: if its durable store is unavailable,
    // fail closed with a service error instead of bypassing the limit or
    // leaking an uncaught database exception as HTTP 500.
    return NextResponse.json({ error: 'Enrollment service is temporarily unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}

function parseQuery(request: Request): { chainId: number; wallet: string } | null {
  const { searchParams } = new URL(request.url)
  const wallet = searchParams.get('wallet')
  const rawChainId = searchParams.get('chainId')
  const network = resolveRequestedChainId(rawChainId)
  if (!wallet || !isAddress(wallet, { strict: false }) || !network.ok) return null
  return { chainId: network.chainId, wallet }
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

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function handleEnrollmentGet(request: Request, sync: EnrollmentSync) {
  const source = clientIdentity(request)
  const ipLimited = await applyRateLimit(request, 'get-ip', source, GET_IP_LIMIT)
  if (ipLimited) return ipLimited

  let query: ReturnType<typeof parseQuery>
  try {
    query = parseQuery(request)
  } catch {
    return NextResponse.json({ error: 'Enrollment network configuration is unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  if (!query) {
    return NextResponse.json({ error: `A valid wallet and this deployment's Arc chainId (${getActiveChainId()}) are required` }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const walletLimited = await applyRateLimit(request, 'get-wallet', query.wallet.toLowerCase(), GET_WALLET_LIMIT)
  if (walletLimited) return walletLimited

  const key = cacheKey(query.chainId, query.wallet)
  const cached = cachedEnrollment(key)
  if (cached) {
    return NextResponse.json({ chainId: query.chainId, wallet: query.wallet, ...cached }, {
      headers: { 'Cache-Control': `private, max-age=${GET_CACHE_TTL_MS / 1_000}` },
    })
  }

  try {
    const result = await sync(query.chainId, query.wallet)
    cacheEnrollment(key, result)
    return NextResponse.json({ chainId: query.chainId, wallet: query.wallet, ...result }, {
      headers: { 'Cache-Control': `private, max-age=${GET_CACHE_TTL_MS / 1_000}` },
    })
  } catch {
    return NextResponse.json({ error: 'Enrollment verification is temporarily unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}

export async function handleEnrollmentPost(request: Request, sync: EnrollmentSync) {
  const source = clientIdentity(request)
  const ipLimited = await applyRateLimit(request, 'post-ip', source, POST_IP_LIMIT)
  if (ipLimited) return ipLimited

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Enrollment request body is too large' }, {
      status: 413,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  let text: string | null
  try {
    text = await readBoundedBody(request)
  } catch {
    return NextResponse.json({ error: 'Could not read enrollment request body' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  if (text === null) {
    return NextResponse.json({ error: 'Enrollment request body is too large' }, {
      status: 413,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  let body: unknown
  try {
    body = text.trim() ? JSON.parse(text) : null
  } catch {
    return NextResponse.json({ error: 'Invalid enrollment request' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid enrollment request' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const { chainId, wallet } = body as { chainId?: unknown; wallet?: unknown }
  let activeChainId: number
  try {
    activeChainId = getActiveChainId()
  } catch {
    return NextResponse.json({ error: 'Enrollment network configuration is unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  if (chainId !== activeChainId || typeof wallet !== 'string' || !isAddress(wallet, { strict: false })) {
    return NextResponse.json({ error: `A valid wallet and ${networkLabel(getConfiguredNetwork())} chainId (${activeChainId}) are required` }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const walletLimited = await applyRateLimit(request, 'post-wallet', wallet.toLowerCase(), POST_WALLET_LIMIT)
  if (walletLimited) return walletLimited

  try {
    const result = await sync(chainId, wallet)
    invalidateEnrollmentCache(chainId, wallet)
    const enrollment = result.enrollment as { status?: string } | null
    if (!enrollment) {
      return NextResponse.json({ error: `Wallet is not enrolled on ${networkLabel(getConfiguredNetwork())}` }, {
        status: 409,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    return NextResponse.json({ success: true, enrollment }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json({ error: 'Enrollment verification is temporarily unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
