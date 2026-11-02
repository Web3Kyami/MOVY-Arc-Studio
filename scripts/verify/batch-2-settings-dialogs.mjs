import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.SHOT_BASE || 'http://localhost:3111'
const EVIDENCE = process.env.EVIDENCE_OUT
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })
const browser = await launchChromium()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()

try {
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  const connectTrigger = page.getByRole('button', { name: 'Connect wallet', exact: true })
  await connectTrigger.click()
  const dialog = page.getByRole('dialog', { name: 'Connect wallet' })
  await dialog.waitFor()
  assert.equal(await dialog.getByText(/Arc Testnet/).count(), 1)
  assert.match(await dialog.innerText(), /Connecting shares your public wallet address/)
  assert.match(await dialog.innerText(), /Wallet requests require your approval/)
  assert.match(await dialog.innerText(), /connecting alone does not move funds/)
  assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).evaluate(el => el === document.activeElement), true,
    'Opening wallet authorization focuses the safe cancel action')
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/settings-wallet-authorization-disclosure.png` })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await connectTrigger.evaluate(el => el === document.activeElement), true,
    'Escape returns focus to the control that opened the wallet dialog')
  assert.equal(await page.getByRole('button', { name: 'Change allowance', exact: true }).isDisabled(), true,
    'Allowance changes remain unavailable before wallet authorization')
  console.log('PASS: wallet connection discloses the supported network and permissions before authorization, with accessible cancel and focus return')
} finally {
  await context.close()
  await browser.close()
}
