import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.DEMO_SHOT_BASE || 'http://localhost:3112'
const EVIDENCE = process.env.EVIDENCE_OUT
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })
const browser = await launchChromium()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()

try {
  await page.goto(`${BASE}/savings`, { waitUntil: 'networkidle' })
  await page.getByRole('link', { name: 'Create a new goal', exact: true }).first().click()
  await page.getByRole('heading', { name: 'Create a goal', exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/savings/new', 'Goal creation uses a dedicated accessible route')
  assert.equal(await page.getByRole('dialog').count(), 0, 'A full-screen form must not masquerade as a modal')
  await page.getByRole('textbox', { name: 'Goal name', exact: true }).focus()
  assert.equal(await page.getByRole('textbox', { name: 'Goal name', exact: true }).evaluate(element => element === document.activeElement), true)
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/create-goal-page.png` })
  await page.getByRole('link', { name: 'Back to Savings' }).click()
  await page.waitForURL('**/savings')
  await page.goBack()
  await page.getByRole('heading', { name: 'Create a goal', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Cancel', exact: true }).click()
  await page.waitForURL('**/savings')
  console.log('PASS: full-screen Create Goal is keyboard reachable and supports route back, browser back and cancel')

} finally {
  await context.close()
  await browser.close()
}
