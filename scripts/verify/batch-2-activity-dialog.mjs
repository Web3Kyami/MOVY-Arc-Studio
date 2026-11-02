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
  await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle' })
  const roundupFilter = page.getByRole('tab', { name: 'Savings' })
  await roundupFilter.click()
  assert.equal(await roundupFilter.getAttribute('aria-selected'), 'true', 'Activity filter selection should update')

  const allFilter = page.getByRole('tab', { name: 'All', exact: true })
  await allFilter.click()
  assert.equal(await allFilter.getAttribute('aria-selected'), 'true')

  const firstReceipt = page.getByRole('button', { name: /^View receipt for/ }).first()
  await firstReceipt.click()
  const dialog = page.getByRole('dialog', { name: 'Demo receipt' })
  await dialog.waitFor()
  assert.match(await dialog.innerText(), /Example only — no money moved\./)
  assert.doesNotMatch(await dialog.innerText(), /\bCompleted\b|Saved to Savings/)
  assert.equal(await page.getByRole('button', { name: 'Close transaction details' }).evaluate((button) => button === document.activeElement), true)
  assert.equal(await dialog.getByRole('link').count(), 0, 'Example details must not expose fake explorer links')
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/activity-receipt-dialog.png` })

  for (let index = 0; index < 8; index += 1) await page.keyboard.press('Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true, 'Tab navigation should remain inside the receipt dialog')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await firstReceipt.evaluate((button) => button === document.activeElement), true, 'Closing the receipt should restore focus to its trigger')
  console.log('PASS: Activity filters update, Demo receipts cannot appear as real transactions, and Escape/tab focus behavior is accessible')
} finally {
  await context.close()
  await browser.close()
}
