import { NextResponse } from 'next/server'
import { classifyOrigin, getSiteOrigins, resolveRequestOrigin, SiteOriginConfigurationError } from '@/lib/site-origins'

type ProductApiGuardOptions = {
  /** Require an explicit same-origin browser signal before entering a route with GET side effects. */
  requireBrowserRequest?: boolean
}

function forbiddenResponse() {
  return NextResponse.json({ error: 'Forbidden' }, {
    status: 403,
    headers: {
      'Cache-Control': 'no-store',
      'Vary': 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest',
    },
  })
}

/** Called at the start of every API handler, before database, RPC or worker code. */
export function guardProductApiRequest(
  request: Request,
  options: ProductApiGuardOptions = {}
): Response | null {
  let origins
  try {
    origins = getSiteOrigins()
  } catch (error) {
    if (!(error instanceof SiteOriginConfigurationError)) throw error
    return NextResponse.json({ error: 'Service unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const targetOrigin = resolveRequestOrigin(request.url, request.headers.get('host'))
  const role = targetOrigin ? classifyOrigin(targetOrigin, origins) : null
  if (role !== 'product') {
    return NextResponse.json({ error: 'Not found' }, {
      status: role === null ? 421 : 404,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const requestOrigin = request.headers.get('origin')
  if (requestOrigin !== null && requestOrigin !== targetOrigin) return forbiddenResponse()

  // An origin can be omitted on GET and navigation requests. Fetch Metadata
  // still distinguishes the product origin from a sibling Demo host, which
  // browsers report as "same-site" even though it is cross-origin.
  const fetchSiteHeader = request.headers.get('sec-fetch-site')
  const fetchSite = fetchSiteHeader?.trim().toLowerCase()
  if (fetchSiteHeader !== null && fetchSite !== 'same-origin') return forbiddenResponse()

  // Product APIs are consumed through fetch, never by top-level navigation or
  // embedded resources. Reject those requests even when an older browser omits
  // the Origin header.
  const fetchMode = request.headers.get('sec-fetch-mode')?.trim().toLowerCase()
  const fetchDestination = request.headers.get('sec-fetch-dest')?.trim().toLowerCase()
  if (fetchMode === 'navigate' || (fetchDestination && fetchDestination !== 'empty')) {
    return forbiddenResponse()
  }

  // The enrollment GET refreshes chain state and the database. Require either
  // an exact Origin or Fetch Metadata from a same-origin browser fetch so a
  // no-header navigation cannot trigger those side effects. Authenticated
  // worker/cron routes keep their separate server-to-server paths.
  if (options.requireBrowserRequest && requestOrigin === null && fetchSite !== 'same-origin') {
    return forbiddenResponse()
  }

  return null
}
