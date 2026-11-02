import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { connectedReadFixture, connectViaSettings } from './connected-read-fixture.mjs'
import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.SHOT_BASE || 'http://localhost:3111'
const EVIDENCE = process.env.EVIDENCE_OUT
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })
const browser = await launchChromium()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
await connectedReadFixture(context)
const page = await context.newPage()

try {
  await connectViaSettings(page, BASE)
  await page.goto(`${BASE}/savings`, { waitUntil: 'networkidle' })
  const trigger = page.getByRole('button', { name: 'Transfer legacy vault funds' }).first()
  await trigger.waitFor()
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Transfer legacy vault funds'))?.disabled)
  await trigger.click()

  const dialog = page.getByRole('dialog', { name: 'Withdraw Savings' })
  await dialog.waitFor()
  const targets = await dialog.locator('button, input').evaluateAll((elements) => elements
    .filter((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
    })
    .map((element) => {
      const rect = element.getBoundingClientRect()
      return {
        name: element instanceof HTMLButtonElement ? element.innerText.trim() || element.getAttribute('aria-label') : element.getAttribute('placeholder'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    }))

  assert.ok(targets.length >= 6, `Expected close, three preset, amount input and transfer controls; found ${JSON.stringify(targets)}`)
  assert.ok(targets.every(({ width, height }) => width >= 44 && height >= 44), `All withdrawal controls must be at least 44×44px: ${JSON.stringify(targets)}`)
  assert.equal(await page.getByRole('button', { name: 'Close withdrawal dialog' }).evaluate((element) => element === document.activeElement), true, 'Opening the sheet should focus its close control')
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/savings-withdraw-sheet.png` })

  assert.match(await dialog.innerText(), /legacy vault|Legacy Vault/i, 'Connected withdrawal explains the truthful source')
  assert.deepEqual(await page.evaluate(() => window.__writes), [], 'Opening a connected withdrawal must not sign')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true, 'Closing the sheet should restore focus to its trigger')
  console.log(`PASS: mobile withdrawal dialog has a name, 44px controls, and correct focus behavior (${targets.length} controls)`)
} finally {
  await context.close()
  await browser.close()
}
