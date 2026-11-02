import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { launchChromium } from './browser-runtime.mjs'

const PRODUCT = process.env.SHOT_BASE || 'http://localhost:3111'
const DEMO = process.env.DEMO_SHOT_BASE || 'http://localhost:3112'
const OUT = process.env.EVIDENCE_OUT || 'artifacts/demo-origin-boundary'
mkdirSync(OUT, { recursive: true })
const browser = await launchChromium()
const cases = []
const requestWithHost = (url, host, forwardedHost) => new Promise((resolve, reject) => {
  const request = httpRequest(url, { headers: { host, 'x-forwarded-host': forwardedHost } }, response => {
    response.resume()
    response.on('end', () => resolve(response.statusCode))
  })
  request.on('error', reject)
  request.end()
})

try {
  // Exercise the compiled HTTP server too: Next may normalize request URLs to
  // its bound host, so the actual Host authority must remain the trust boundary.
  const forwardedHost = new URL(PRODUCT).host
  assert.equal(await requestWithHost(`${PRODUCT}/home`, 'unknown.movy.example', forwardedHost), 421,
    'Unknown HTTP Host cannot borrow a configured forwarded host')
  assert.equal(await requestWithHost(`${PRODUCT}/api/activity`, 'unknown.movy.example', forwardedHost), 421,
    'Product APIs reject unknown HTTP Host authorities')

  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
    await context.addInitScript(() => {
      localStorage.setItem('movy_demo_mode_active', 'true')
      window.__walletCalls = []
      Object.defineProperty(window, 'ethereum', {
        configurable: true,
        value: {
          async request(args) { window.__walletCalls.push(args?.method); throw new Error('Demo must not call an injected wallet') },
          on() {},
          removeListener() {},
        },
      })
    })
    const page = await context.newPage()
    const apiRequests = []
    const chainRequests = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) apiRequests.push(request.url())
      if (/rpc\.testnet\.arc\.io/i.test(url.hostname)) chainRequests.push(request.url())
    })

    await page.goto(`${PRODUCT}/`, { waitUntil: 'networkidle' })
    await page.evaluate(() => localStorage.setItem(
      'movy_demo_v2_profile',
      JSON.stringify({ name: 'Product-storage leak', totalSaved: 999999 }),
    ))
    assert.equal(await page.getByRole('button', { name: 'Explore Demo' }).count(), 0,
      'The product landing does not offer a sample-account entry point')
    assert.ok(await page.getByRole('button', { name: 'Start Saving' }).count() >= 1,
      'The landing keeps a Start Saving path to connected onboarding')
    if (viewport.width === 390) await page.screenshot({ path: `${OUT}/landing-mobile.png` })
    if (viewport.width === 1440) await page.screenshot({ path: `${OUT}/landing-desktop.png` })
    await page.goto(`${DEMO}/`, { waitUntil: 'networkidle' })
    await page.waitForURL(`${DEMO}/home`)
    await page.getByRole('heading', { name: 'Home', level: 1 }).waitFor()
    assert.equal(await page.locator('.consumer-demo:visible').count(), 1)
    assert.doesNotMatch(await page.locator('#main').innerText(), /Product-storage leak|0x[0-9a-f]{8}/i)
    assert.equal(await page.evaluate(() => localStorage.getItem('movy_demo_v2_profile')), null,
      'Product-origin fixture data is unavailable from Demo storage')
    if (viewport.width === 1440) {
      await page.waitForFunction(() => {
        const avatar = document.querySelector('.consumer-identity img')
        return avatar instanceof HTMLImageElement && avatar.complete && avatar.naturalWidth > 0
      })
    }
    await page.evaluate(() => localStorage.setItem('demo-origin-marker', 'demo-only'))
    assert.equal(await page.evaluate(() => window.__walletCalls.length), 0, 'Demo screens do not call the injected wallet')
    if (viewport.width === 390) await page.screenshot({ path: `${OUT}/home-mobile.png` })
    if (viewport.width === 1440) await page.screenshot({ path: `${OUT}/home-desktop.png` })

    const blockedApi = await page.request.get(`${DEMO}/api/enrollment?wallet=0x${'1'.repeat(40)}`)
    assert.equal(blockedApi.status(), 404, 'Demo cannot reach enrollment or other product API routes')
    for (const path of ['/onboarding', '/demo-store', '/merchant-demo']) {
      const response = await page.goto(`${DEMO}${path}`, { waitUntil: 'domcontentloaded' })
      assert.equal(response?.status(), 404, `${path} stays on the product origin`)
    }
    const deniedProductApi = await page.request.get(`${PRODUCT}/api/activity?wallet=0x${'1'.repeat(40)}`, {
      headers: { origin: DEMO },
    })
    assert.equal(deniedProductApi.status(), 403, 'Product APIs reject requests initiated from the Demo origin')

    await page.goto(`${DEMO}/activity`, { waitUntil: 'networkidle' })
    const firstActivity = page.getByRole('button', { name: /^View receipt for/ }).first()
    await firstActivity.click()
    const receipt = page.getByRole('dialog', { name: 'Demo receipt' })
    await receipt.waitFor()
    assert.match(await receipt.innerText(), /Example only — no money moved\./)
    assert.doesNotMatch(await receipt.innerText(), /Completed|0x[0-9a-f]{8,}/i)
    assert.equal(await receipt.getByRole('link').count(), 0, 'Example receipts never link to a real explorer')
    if (viewport.width === 390) await page.screenshot({ path: `${OUT}/activity-receipt-mobile.png` })
    await page.keyboard.press('Escape')

    await page.goto(`${DEMO}/savings/new`, { waitUntil: 'networkidle' })
    await page.getByLabel('Goal name').fill(`Origin goal ${viewport.width}`)
    await page.getByLabel('Target amount (USDC)').fill('275.00')
    await page.getByRole('button', { name: 'Create goal', exact: true }).click()
    await page.waitForURL(`${DEMO}/savings`)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('article', { name: `Origin goal ${viewport.width}` }).waitFor()
    assert.equal(await page.evaluate(() => window.__walletCalls.length), 0)
    assert.deepEqual(apiRequests, [], 'The Demo application performs no product API requests')
    assert.deepEqual(chainRequests, [], 'The Demo application performs no chain reads')
    await context.close()
    cases.push({ viewport: viewport.width, isolatedDemoDirectAccess: true, goalPersistence: true, noWalletCalls: true, noApiCalls: true, noChainReads: true, apiBoundary: true, safeReceipt: true })
  }

  const productContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await productContext.addInitScript(() => {
    localStorage.setItem('movy_demo_mode_active', 'true')
    localStorage.setItem('demo-origin-marker', 'product-only')
  })
  const productPage = await productContext.newPage()
  await productPage.goto(`${PRODUCT}/settings`, { waitUntil: 'networkidle' })
  assert.equal(await productPage.locator('.consumer-demo:visible').count(), 0, 'Product mode is fixed by its origin')
  assert.equal(await productPage.evaluate(() => localStorage.getItem('demo-origin-marker')), 'product-only')
  assert.equal(await productPage.evaluate(() => localStorage.getItem('movy_demo_v2_profile')), null,
    'Demo origin storage does not cross into the product')
  await productPage.goto(`${PRODUCT}/`, { waitUntil: 'networkidle' })
  await productPage.locator('#landing-main')
    .getByRole('button', { name: 'Start Saving', exact: true }).first().click()
  await productPage.waitForURL(`${PRODUCT}/onboarding`)
  await productPage.getByRole('button', { name: 'Get Started' }).click()
  await productPage.getByRole('heading', { name: 'Connect the account you spend from' }).waitFor()
  assert.equal(await productPage.getByRole('button', { name: 'Continue in Demo' }).count(), 0)
  await productContext.close()
  cases.push({ productDemoStorageSpoofIgnored: true, crossOriginStorageIsolated: true, startSavingConnectedOnboarding: true })

  console.log(`PASS: isolated Demo origin, wallet-free read-only example data, and connected onboarding (${cases.length} cases)`)
} finally {
  await browser.close()
}
