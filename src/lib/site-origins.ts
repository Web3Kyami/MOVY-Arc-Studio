/**
 * Runtime origin allowlists for MOVY's consumer and isolated Demo surfaces.
 * Values are exact origins (scheme + host + optional port), never URL prefixes.
 */
export type SiteRole = 'product' | 'demo'

export interface SiteOrigins {
  product: ReadonlySet<string>
  demo: ReadonlySet<string>
  demoEntry: string | null
}

export class SiteOriginConfigurationError extends Error {
  constructor() {
    super('MOVY site origins are missing or invalid')
    this.name = 'SiteOriginConfigurationError'
  }
}

function parseOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return []
  const origins = value.split(/[\s,]+/).filter(Boolean).map((candidate) => {
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      throw new SiteOriginConfigurationError()
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      candidate.includes('*') || url.origin !== candidate.replace(/\/$/, '')
    ) {
      throw new SiteOriginConfigurationError()
    }
    return url.origin
  })
  return [...new Set(origins)]
}

function getVercelPreviewOrigin(env: NodeJS.ProcessEnv): string | null {
  if (env.VERCEL_ENV !== 'preview' || !env.VERCEL_URL?.trim()) return null
  const origin = parseOrigins(`https://${env.VERCEL_URL.trim()}`)[0]
  if (!origin || !new URL(origin).hostname.toLowerCase().endsWith('.vercel.app')) {
    throw new SiteOriginConfigurationError()
  }
  return origin
}

export function getSiteOrigins(env: NodeJS.ProcessEnv = process.env): SiteOrigins {
  const localDefaults = env.NODE_ENV !== 'production'
  const productValue = env.MOVY_PRODUCT_ORIGINS?.trim() || (localDefaults ? 'http://localhost:3000 http://localhost:3111' : undefined)
  const demoValue = env.MOVY_DEMO_ORIGINS?.trim() || (localDefaults ? 'http://localhost:3001 http://localhost:3112' : undefined)
  const product = parseOrigins(productValue)
  const vercelPreviewOrigin = getVercelPreviewOrigin(env)
  if (vercelPreviewOrigin && !product.includes(vercelPreviewOrigin)) product.push(vercelPreviewOrigin)
  const demo = parseOrigins(demoValue)
  if (!product.length || !demo.length || product.some((origin) => demo.includes(origin))) {
    throw new SiteOriginConfigurationError()
  }

  const configuredEntry = env.MOVY_DEMO_ENTRY_ORIGIN?.trim() || (localDefaults ? 'http://localhost:3001' : undefined)
  const configuredEntries = configuredEntry ? parseOrigins(configuredEntry) : []
  if (configuredEntry && configuredEntries.length !== 1) throw new SiteOriginConfigurationError()
  const demoEntry = configuredEntry
    ? configuredEntries[0] ?? null
    : demo.length === 1 ? demo[0] : null
  if (!demoEntry || !demo.includes(demoEntry)) throw new SiteOriginConfigurationError()

  return { product: new Set(product), demo: new Set(demo), demoEntry }
}

export function classifyOrigin(origin: string, origins: SiteOrigins): SiteRole | null {
  if (origins.product.has(origin)) return 'product'
  if (origins.demo.has(origin)) return 'demo'
  return null
}

/** Bind the effective origin to the HTTP authority, which Next can normalize out of its URL. */
export function resolveRequestOrigin(requestUrl: string, host: string | null): string | null {
  try {
    const url = new URL(requestUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (host === null) return url.origin
    if (!host || /[\s,\\/?#@%]/.test(host)) return null
    const authority = new URL(`${url.protocol}//${host}`)
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) return null
    return authority.origin
  } catch {
    return null
  }
}
