import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { classifyOrigin, getSiteOrigins, resolveRequestOrigin, SiteOriginConfigurationError } from '../src/lib/site-origins'
import { guardProductApiRequest } from '../src/lib/server/api-origin-guard'
import { GET as enrollmentGet } from '../src/app/api/enrollment/route'
import { GET as activityGet } from '../src/app/api/activity/route'
import { GET as cronGet } from '../src/app/api/worker/cron/route'
import { proxy } from '../src/proxy'

const product = 'https://app.movy.example'
const demo = 'https://try.movy.example'
Object.assign(process.env, { NODE_ENV: 'production' })
process.env.MOVY_PRODUCT_ORIGINS = product
process.env.MOVY_DEMO_ORIGINS = demo
process.env.MOVY_DEMO_ENTRY_ORIGIN = demo
process.env.MOVY_BROWSER_TEST_FIXTURES = 'true'

const origins = getSiteOrigins()
assert.equal(classifyOrigin(product, origins), 'product')
assert.equal(classifyOrigin(demo, origins), 'demo')
assert.equal(classifyOrigin('https://unknown.movy.example', origins), null)
assert.throws(() => getSiteOrigins({
  NODE_ENV: 'production',
  MOVY_PRODUCT_ORIGINS: `${product}/path`,
  MOVY_DEMO_ORIGINS: demo,
  MOVY_DEMO_ENTRY_ORIGIN: demo,
}), SiteOriginConfigurationError)
assert.throws(() => getSiteOrigins({
  NODE_ENV: 'production',
  MOVY_PRODUCT_ORIGINS: product,
  MOVY_DEMO_ORIGINS: demo,
  MOVY_DEMO_ENTRY_ORIGIN: `${demo},https://extra.movy.example`,
}), SiteOriginConfigurationError)
assert.throws(() => getSiteOrigins({
  NODE_ENV: 'production',
  MOVY_PRODUCT_ORIGINS: product,
  MOVY_DEMO_ORIGINS: `${product} https://other.example`,
  MOVY_DEMO_ENTRY_ORIGIN: product,
}), SiteOriginConfigurationError)

const vercelPreviewHost = 'movy-git-codex-live-product-entry-web3kyamis-projects.vercel.app'
const vercelPreviewOrigins = getSiteOrigins({
  NODE_ENV: 'production',
  MOVY_PRODUCT_ORIGINS: product,
  MOVY_DEMO_ORIGINS: demo,
  MOVY_DEMO_ENTRY_ORIGIN: demo,
  VERCEL_ENV: 'preview',
  VERCEL_URL: vercelPreviewHost,
})
assert.equal(classifyOrigin(`https://${vercelPreviewHost}`, vercelPreviewOrigins), 'product',
  'The exact Vercel Preview URL is admitted to the product origin allowlist')
assert.equal(classifyOrigin('https://other-preview.vercel.app', vercelPreviewOrigins), null,
  'Vercel Preview support does not admit sibling deployment hosts')
const vercelProductionOrigins = getSiteOrigins({
  NODE_ENV: 'production',
  MOVY_PRODUCT_ORIGINS: product,
  MOVY_DEMO_ORIGINS: demo,
  MOVY_DEMO_ENTRY_ORIGIN: demo,
  VERCEL_ENV: 'production',
  VERCEL_URL: vercelPreviewHost,
})
assert.equal(classifyOrigin(`https://${vercelPreviewHost}`, vercelProductionOrigins), null,
  'A production deployment does not add VERCEL_URL as a preview origin')
assert.throws(() => getSiteOrigins({
  NODE_ENV: 'production',
  MOVY_PRODUCT_ORIGINS: product,
  MOVY_DEMO_ORIGINS: demo,
  MOVY_DEMO_ENTRY_ORIGIN: demo,
  VERCEL_ENV: 'preview',
  VERCEL_URL: 'attacker.example',
}), SiteOriginConfigurationError,
  'Vercel Preview host must be a Vercel-managed deployment hostname')

const demoLanding = proxy(new NextRequest(`${demo}/`, {
  headers: { 'x-movy-site-role': 'product' },
}))
assert.equal(demoLanding.status, 307, 'Demo root should enter its seeded Home screen')
assert.equal(demoLanding.headers.get('location'), `${demo}/home`)
assert.match(demoLanding.headers.get('cache-control') ?? '', /no-store/)

for (const path of ['/avatars/alex.png', '/artwork/movy_goal_sanctuary.jpg']) {
  const asset = proxy(new NextRequest(`${demo}${path}`))
  assert.equal(asset.headers.get('x-middleware-request-x-movy-site-role'), 'demo',
    `${path} must load on Demo so its approved visuals render`)
}

for (const path of ['/onboarding', '/demo-store', '/merchant-demo', '/api/enrollment']) {
  const blocked = proxy(new NextRequest(`${demo}${path}`))
  assert.equal(blocked.status, 404, `${path} must not be available from the Demo origin`)
}

// Real servers may normalize the URL to their bound address; Host still owns the authority.
assert.equal(resolveRequestOrigin('https://internal.example/home', new URL(product).host), product)
assert.equal(resolveRequestOrigin(`${product}/home`, null), product)
for (const malformed of ['', 'user@app.movy.example', 'app.movy.example/path', 'app.movy.example?x=1', 'app.movy.example#x', 'app.movy.example,evil.example', 'app.movy.example\\evil']) {
  assert.equal(resolveRequestOrigin(`${product}/home`, malformed), null)
}
const forgedHost = proxy(new NextRequest(`${product}/home`, {
  headers: { host: 'unknown.movy.example', 'x-forwarded-host': new URL(product).host },
}))
assert.equal(forgedHost.status, 421, 'Configured normalized URL and forwarded host cannot hide an unknown Host')
assert.equal(guardProductApiRequest(new Request(`${product}/api/activity`, {
  headers: { host: 'unknown.movy.example', origin: product },
}))?.status, 421, 'The API guard independently rejects an unknown Host')
const demoAuthorityApi = guardProductApiRequest(new Request(`${product}/api/activity`, {
  headers: { host: new URL(demo).host },
}))
assert.equal(demoAuthorityApi?.status, 404, 'A normalized product URL cannot turn a Demo Host into a product API')
assert.equal(guardProductApiRequest(new Request('https://internal.example/api/activity', {
  headers: { host: new URL(product).host, origin: product },
})), null, 'Same-origin browser checks use the actual allowed Host, not an internal URL')
const demoAuthorityRoot = proxy(new NextRequest(product, { headers: { host: new URL(demo).host } }))
assert.equal(demoAuthorityRoot.headers.get('location'), `${demo}/home`, 'Demo redirects retain the effective Demo origin')

const unknownHost = proxy(new NextRequest('https://unknown.movy.example/home'))
assert.equal(unknownHost.status, 421, 'Unknown hosts must fail closed')

const demoFixture = proxy(new NextRequest(`${demo}/home?fixture=connected-active`))
assert.equal(demoFixture.headers.get('x-movy-browser-fixture'), null, 'Test fixtures cannot be enabled on Demo')

const demoApi = guardProductApiRequest(new Request(`${demo}/api/activity?wallet=0x${'1'.repeat(40)}`, {
  headers: { origin: demo },
}))
assert.equal(demoApi?.status, 404, 'The Demo origin cannot reach product API handlers')
const unknownApi = guardProductApiRequest(new Request(`https://unknown.movy.example/api/activity`))
assert.equal(unknownApi?.status, 421, 'Unknown API hosts must fail closed')
const crossOriginApi = guardProductApiRequest(new Request(`${product}/api/activity`, {
  headers: { origin: demo },
}))
assert.equal(crossOriginApi?.status, 403, 'Product APIs reject requests initiated by the Demo origin')
assert.equal(guardProductApiRequest(new Request(`${product}/api/activity`)), null,
  'Same-origin server requests without an Origin header remain supported')
assert.equal(guardProductApiRequest(new Request(`${product}/api/activity`, {
  headers: { origin: product },
})), null, 'Same-origin browser requests remain supported')
assert.equal(guardProductApiRequest(new Request(`${product}/api/activity`, {
  headers: { 'sec-fetch-site': 'same-origin' },
})), null, 'Same-origin browser fetches without Origin remain supported')
assert.equal(guardProductApiRequest(new Request(`${product}/api/activity`, {
  headers: { 'sec-fetch-site': 'same-site' },
} ))?.status, 403, 'Same-site sibling origins are cross-origin and must be rejected')
assert.equal(guardProductApiRequest(new Request(`${product}/api/activity`, {
  headers: { 'sec-fetch-site': 'cross-site' },
} ))?.status, 403, 'Cross-site browser API requests must be rejected')
assert.equal(guardProductApiRequest(new Request(`${product}/api/activity`, {
  headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
} ))?.status, 403, 'API navigations without Origin must be rejected')
assert.equal(guardProductApiRequest(new Request(`${product}/api/enrollment`), {
  requireBrowserRequest: true,
})?.status, 403, 'Side-effecting enrollment reads require same-origin browser provenance')

async function verifyRouteBoundaries() {
  const wallet = `0x${'1'.repeat(40)}`
  const enrollmentWithSameSiteDemo = await enrollmentGet(new Request(
    `${product}/api/enrollment?wallet=${wallet}&chainId=5042002`,
    { headers: { 'sec-fetch-site': 'same-site' } }
  ))
  assert.equal(enrollmentWithSameSiteDemo.status, 403,
    'A Demo sibling request without Origin is rejected before enrollment RPC or database synchronization')
  const enrollmentWithoutBrowserHeaders = await enrollmentGet(new Request(
    `${product}/api/enrollment?wallet=${wallet}&chainId=5042002`
  ))
  assert.equal(enrollmentWithoutBrowserHeaders.status, 403,
    'A no-header navigation cannot trigger enrollment synchronization')

  const financialApiFromSibling = await activityGet(new Request(
    `${product}/api/activity?wallet=${wallet}&chainId=5042002`,
    { headers: { 'sec-fetch-site': 'same-site' } }
  ))
  assert.equal(financialApiFromSibling.status, 403,
    'A Demo sibling request without Origin is rejected before a financial activity API reads the database')

  const previousCronSecret = process.env.CRON_SECRET
  const previousWorkerEnabled = process.env.MOVY_WORKER_ENABLED
  process.env.CRON_SECRET = 'local-test-only-cron-secret-0123456789'
  process.env.MOVY_WORKER_ENABLED = 'false'
  try {
    const authenticatedCron = await cronGet(new Request(`${product}/api/worker/cron`, {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }))
    assert.equal(authenticatedCron.status, 503,
      'Authenticated server-to-server cron requests without browser headers pass origin checks while the worker remains disabled')
  } finally {
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previousCronSecret
    if (previousWorkerEnabled === undefined) delete process.env.MOVY_WORKER_ENABLED
    else process.env.MOVY_WORKER_ENABLED = previousWorkerEnabled
  }

  const hostedFixtureConfig = proxy(new NextRequest(`${product}/home?fixture=connected-active`))
  assert.equal(hostedFixtureConfig.status, 503,
    'Browser fixture mode must fail closed for configured non-loopback product origins')

  const previousProductOrigins = process.env.MOVY_PRODUCT_ORIGINS
  process.env.MOVY_PRODUCT_ORIGINS = 'http://localhost:3000'
  const localFixture = proxy(new NextRequest('http://localhost:3000/home?fixture=connected-active'))
  assert.equal(localFixture.headers.get('x-middleware-request-x-movy-browser-fixture'), 'connected-active',
    'Browser fixtures remain available on loopback for the isolated local test runner')
  if (previousProductOrigins === undefined) delete process.env.MOVY_PRODUCT_ORIGINS
  else process.env.MOVY_PRODUCT_ORIGINS = previousProductOrigins

  console.log('PASS: exact origin allowlists, Demo route restrictions, API guards, and test fixture scope')
}

void verifyRouteBoundaries().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
