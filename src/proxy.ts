import { NextRequest, NextResponse } from 'next/server'
import { classifyOrigin, getSiteOrigins, resolveRequestOrigin, SiteOriginConfigurationError } from '@/lib/site-origins'

const DEMO_ROUTES = new Set([
  '/home',
  '/savings',
  '/savings/new',
  '/activity',
  '/settings',
  '/settings/profile',
])
const DEMO_ASSET_PREFIXES = ['/avatars/', '/artwork/']

function closed(status: number, message: string) {
  return new NextResponse(message, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Host, Origin',
    },
  })
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function proxy(request: NextRequest) {
  let origins
  try {
    origins = getSiteOrigins()
  } catch (error) {
    if (!(error instanceof SiteOriginConfigurationError)) throw error
    return closed(503, 'MOVY is temporarily unavailable.')
  }

  const origin = resolveRequestOrigin(request.nextUrl.href, request.headers.get('host'))
  const role = origin ? classifyOrigin(origin, origins) : null
  if (!origin || !role) return closed(421, 'This MOVY address is not configured.')

  const path = request.nextUrl.pathname
  if (
    role === 'product' &&
    process.env.MOVY_BROWSER_TEST_FIXTURES === 'true' &&
    !isLoopbackHostname(new URL(origin).hostname)
  ) {
    return closed(503, 'Browser test fixtures are restricted to local development.')
  }

  if (role === 'demo') {
    if (path.startsWith('/api/')) return closed(404, 'Not found.')
    if (path === '/') {
      const home = new URL('/home', origin)
      home.search = request.nextUrl.search
      return NextResponse.redirect(home, {
        status: 307,
        headers: { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Host, Origin' },
      })
    }
    const isDemoAsset = DEMO_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix))
    if (!path.startsWith('/_next/') && !DEMO_ROUTES.has(path) && !isDemoAsset) {
      return closed(404, 'This page is not available here.')
    }
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-movy-site-role', role)

  // Browser fixture overrides are enabled only by the isolated CI harness and
  // never on the Demo origin. The allowlist stays server-side and request scoped.
  if (role === 'product' && process.env.MOVY_BROWSER_TEST_FIXTURES === 'true') {
    const fixture = request.nextUrl.searchParams.get('fixture')
    const allowed = new Set([
      'disconnected', 'connected-loading', 'connected-error', 'connected-unenrolled',
      'connected-active', 'connected-paused', 'connected-rpc-error', 'connected-toggle-failure',
      'connected-service-paused', 'connected-service-checking', 'connected-service-unavailable',
      'connected-paused-service-paused',
    ])
    if (fixture && allowed.has(fixture)) requestHeaders.set('x-movy-browser-fixture', fixture)
  } else {
    requestHeaders.delete('x-movy-browser-fixture')
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Vary', 'Host, Origin')
  if (!path.startsWith('/_next/')) response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
}
