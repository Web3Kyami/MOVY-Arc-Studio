import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const PRODUCT = process.env.SHOT_BASE || 'http://localhost:3111'
const DEMO = process.env.DEMO_SHOT_BASE || 'http://localhost:3112'
const EVIDENCE = process.env.EVIDENCE_OUT
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })

const browser = await launchChromium()
try {
  const startContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const startPage = await startContext.newPage()
  await startPage.goto(PRODUCT, { waitUntil: 'networkidle' })
  assert.equal(await startPage.getByRole('button', { name: 'Explore Demo' }).count(), 0)
  await startPage.getByRole('button', { name: 'Start Saving' }).first().click()
  await startPage.waitForURL('**/onboarding')
  await startPage.getByRole('button', { name: 'Get Started' }).click()
  assert.equal(await startPage.getByRole('button', { name: 'Continue in Demo' }).count(), 0,
    'Connected-wallet onboarding has no Demo shortcut')
  assert.equal(await startPage.getByRole('button', { name: 'Connect wallet' }).count(), 0,
    'Onboarding requests wallet authorization from its dedicated wallet step')
  await startPage.getByRole('button', { name: 'Close setup' }).click()
  await startPage.waitForURL(PRODUCT)
  assert.equal(await startPage.evaluate(() => localStorage.getItem('movy_onboarding_completed')), null,
    'Closing an incomplete setup does not mark onboarding complete')
  console.log('PASS: Start Saving enters connected-wallet onboarding and incomplete setup can close safely')
  await startContext.close()

  const demoContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await demoContext.addInitScript(() => {
    localStorage.setItem('movy_demo_mode_active', 'false')
    window.__walletCalls = []
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: { async request(args) { window.__walletCalls.push(args?.method); throw new Error('unexpected wallet request') } },
    })
  })
  const demoPage = await demoContext.newPage()
  const apiRequests = []
  demoPage.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
  })
  await demoPage.goto(DEMO, { waitUntil: 'networkidle' })
  await demoPage.waitForURL(`${DEMO}/home`)
  await demoPage.getByRole('heading', { name: 'Home', level: 1 }).waitFor()
  assert.equal(await demoPage.locator('.consumer-demo:visible').count(), 1)
  assert.equal(await demoPage.evaluate(() => localStorage.getItem('movy_demo_mode_active')), 'false',
    'Demo identity comes from the separate origin, not local storage')
  assert.deepEqual(await demoPage.evaluate(() => window.__walletCalls), [], 'Demo never prompts the injected wallet')
  assert.deepEqual(apiRequests, [], 'Demo does not call product APIs')
  if (EVIDENCE) await demoPage.screenshot({ path: `${EVIDENCE}/demo-home-no-wallet.png` })
  console.log('PASS: Separate Demo ignores mode storage and does not request wallet or API access')
  await demoContext.close()

  const disconnectedContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const disconnectedPage = await disconnectedContext.newPage()
  await disconnectedPage.goto(`${PRODUCT}/home`, { waitUntil: 'networkidle' })
  const controls = disconnectedPage.locator('button[role="switch"]')
  assert.ok(await controls.count() > 0)
  assert.ok(await controls.evaluateAll(items => items.every(item => item instanceof HTMLButtonElement && item.disabled)),
    'Disconnected savings controls cannot claim or change wallet state')
  await disconnectedPage.getByText('Connect a wallet to change automatic savings.').waitFor()
  if (EVIDENCE) await disconnectedPage.screenshot({ path: `${EVIDENCE}/product-home-disconnected.png` })
  assert.equal(await disconnectedPage.locator('.consumer-demo:visible').count(), 0)
  await disconnectedPage.getByRole('link', { name: 'Connect your wallet to view savings' }).click()
  await disconnectedPage.waitForURL(`${PRODUCT}/onboarding`)
  console.log('PASS: disconnected product keeps real-data boundaries and routes wallet setup to onboarding')
  await disconnectedContext.close()
} finally {
  await browser.close()
}
