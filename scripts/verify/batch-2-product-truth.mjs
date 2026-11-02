import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const PRODUCT = process.env.SHOT_BASE || 'http://localhost:3111'
const DEMO = process.env.DEMO_SHOT_BASE || 'http://localhost:3112'
const EVIDENCE = process.env.EVIDENCE_OUT
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })
const browser = await launchChromium()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()

try {
  await page.goto(PRODUCT, { waitUntil: 'networkidle' })
  const description = await page.locator('meta[name="description"]').getAttribute('content')
  assert.match(description ?? '', /Build a savings habit with MOVY/)
  assert.doesNotMatch(description ?? '', /Testnet|Preview|Simulated/)
  await page.evaluate(() => {
    localStorage.setItem('movy_demo_mode_active', 'true')
    localStorage.setItem('movy:profile:v1:demo', JSON.stringify({ name: 'Product-origin leak', avatar: 'sage', photo: null }))
    localStorage.setItem('movy_demo_v2_goals', JSON.stringify([{ id: 'product-only', title: 'Product-only goal' }]))
  })

  await page.goto(`${DEMO}/home`, { waitUntil: 'networkidle' })
  assert.equal(await page.locator('.consumer-demo:visible').count(), 1)
  assert.equal(await page.getByText('Product-origin leak', { exact: true }).count(), 0)
  assert.equal(await page.getByText('Product-only goal', { exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => localStorage.getItem('movy_demo_mode_active')), null,
    'The Demo origin has independent storage and does not inherit the product mode flag')

  await page.goto(`${DEMO}/activity`, { waitUntil: 'networkidle' })
  const activityText = await page.locator('#main').innerText()
  assert.doesNotMatch(activityText, /0x[0-9a-f]{8,}/i)
  const firstReceipt = page.getByRole('button', { name: /^View receipt for/ }).first()
  await firstReceipt.click()
  const receipt = page.getByRole('dialog', { name: 'Demo receipt' })
  await receipt.waitFor()
  const receiptText = await receipt.innerText()
  assert.match(receiptText, /Example only — no money moved\./)
  assert.doesNotMatch(receiptText, /\bCompleted\b|Saved to Savings|0x[0-9a-f]{8,}/i)
  assert.equal(await receipt.getByRole('link').count(), 0)
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/demo-receipt-example-only.png` })
  console.log('PASS: product claims stay concise, origins have separate browser storage, and example activity cannot read as a completed real transaction')
} finally {
  await context.close()
  await browser.close()
}
