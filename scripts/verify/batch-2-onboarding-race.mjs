import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.SHOT_BASE || 'http://localhost:3111'
const EVIDENCE = process.env.EVIDENCE_OUT
if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true })
const ACCOUNT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const DESTINATION = '0x2222222222222222222222222222222222222222'
const browser = await launchChromium()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
await context.addInitScript((account) => {
  let accounts = []
  const listeners = new Map()
  const provider = {
    isMetaMask: true,
    async request({ method }) {
      if (method === 'eth_chainId') return '0x4cef52'
      if (method === 'eth_accounts') return accounts
      if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }]
      if (method === 'eth_requestAccounts') {
        accounts = [account]
        return accounts
      }
      return null
    },
    on(event, listener) { listeners.set(event, listener); return provider },
    removeListener(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); return provider },
  }
  Object.defineProperty(window, 'ethereum', { configurable: true, value: provider })
}, ACCOUNT)

let delayedBytecodeCalls = 0
await context.route('https://rpc.testnet.arc.io**', async (route) => {
  const request = route.request().postDataJSON()
  if (request.method === 'eth_getCode' && request.params?.[0]?.toLowerCase() === DESTINATION.toLowerCase()) {
    delayedBytecodeCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await route.fulfill({ contentType: 'application/json', json: { jsonrpc: '2.0', id: request.id, result: '0x' } })
    return
  }
  const result = request.method === 'eth_chainId' ? '0x4cef52' : request.method === 'eth_getCode' ? '0x' : null
  await route.fulfill({ contentType: 'application/json', json: { jsonrpc: '2.0', id: request.id, result } })
})

const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

try {
  await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Get Started' }).click()
  await page.getByRole('button', { name: /Injected|MetaMask/i }).click()
  await page.getByText('Account connected').waitFor()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Where should your savings go?' }).waitFor()
  await page.getByPlaceholder('0x... (must be different from your spending wallet)').fill(DESTINATION)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.getByText('Verifying on Arc...').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Back to payment account' }).isEnabled(), true, 'Back must remain available while the read-only bytecode check is pending')
  await page.getByRole('button', { name: 'Back to payment account' }).click()
  await page.getByRole('heading', { name: 'Connect the account you spend from' }).waitFor()
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/onboarding-back-during-verification.png` })
  await page.waitForTimeout(1_800)
  assert.ok(delayedBytecodeCalls > 0, 'The regression must exercise the delayed Arc bytecode response')
  assert.equal(await page.getByRole('heading', { name: 'Connect the account you spend from' }).count(), 1, 'A stale successful bytecode response must not undo Back navigation')
  assert.equal(await page.getByRole('heading', { name: 'Where should your savings go?' }).count(), 0)
  assert.deepEqual(pageErrors, [], 'Back during verification must not cause browser errors')
  console.log('PASS: delayed Arc bytecode verification cannot advance onboarding after Back')
} finally {
  await context.close()
  await browser.close()
}
