import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.SHOT_BASE || 'http://localhost:3111'
const EVIDENCE = process.env.EVIDENCE_OUT
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })
const browser = await launchChromium()

async function verifyCopyFailure(route, clipboardMode, screenshot) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addInitScript((mode) => {
    const clipboard = mode === 'denied'
      ? { async writeText() { throw new Error('Clipboard permission denied') } }
      : undefined
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
  }, clipboardMode)
  const page = await context.newPage()

  try {
    await page.goto(`${BASE}${route}?fixture=connected-active`, { waitUntil: 'networkidle' })
    const triggerName = route === '/settings' ? 'Copy Account ID' : 'Copy Savings Address'
    await page.getByRole('button', { name: triggerName }).first().click()
    await page.getByRole('alert').filter({ hasText: 'Clipboard access failed' }).waitFor()
    const label = route === '/settings' ? 'Account ID to copy manually on mobile' : 'Savings address to copy manually'
    const manualCopy = page.getByRole('textbox', { name: label })
    assert.ok(await manualCopy.inputValue(), 'A visible address fallback must remain available when clipboard access fails')
    assert.doesNotMatch(await page.locator('body').innerText(), /Account ID Copied|Address Copied/)
    await manualCopy.focus()
    const selection = await manualCopy.evaluate((element) => ({ start: element.selectionStart, end: element.selectionEnd, length: element.value.length }))
    assert.deepEqual(selection, { start: 0, end: selection.length, length: selection.length }, 'Focusing the fallback field selects the full address')
    if (EVIDENCE && screenshot) await page.screenshot({ path: `${EVIDENCE}/${screenshot}` })
    console.log(`PASS: ${route} reports ${clipboardMode} clipboard failure and exposes a selectable address`)
  } finally {
    await context.close()
  }
}

try {
  await verifyCopyFailure('/settings', 'denied', 'settings-clipboard-failure.png')
  await verifyCopyFailure('/savings', 'unavailable', 'savings-clipboard-unavailable.png')
  await verifyCopyFailure('/savings', 'denied')
  await verifyCopyFailure('/settings', 'unavailable')
} finally {
  await browser.close()
}
