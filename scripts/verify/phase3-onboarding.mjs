import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.SHOT_BASE || 'http://localhost:3111'
const OUT = process.env.EVIDENCE_OUT || 'artifacts/phase3-onboarding'
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
]
const WIDTH_CHECKS = [320, 390, 768, 900, 1440, 1920]
const ACCOUNT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const DESTINATION = '0x2222222222222222222222222222222222222222'
const WRITE_METHODS = [
  'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign',
  'eth_signTypedData', 'eth_signTypedData_v4', 'wallet_sendCalls', 'wallet_sendTransaction',
]

mkdirSync(OUT, { recursive: true })

const browser = await launchChromium()

async function assertLayout(page, label) {
  const metrics = await page.evaluate(() => {
    const card = document.querySelector('#onboarding-main section')
    const rect = card.getBoundingClientRect()
    const controls = Array.from(document.querySelectorAll('button,input,select,textarea'))
      .filter((element) => {
        const bounds = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      .map((element) => ({
        label: element.getAttribute('aria-label') || element.textContent.trim() || element.getAttribute('placeholder'),
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
      }))
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cardWidth: Math.round(rect.width),
      cardLeft: Math.round(rect.left),
      controls,
      headingCount: document.querySelectorAll('main h1').length,
      imageCount: document.querySelectorAll('#onboarding-main img').length,
    }
  })
  assert.ok(metrics.scrollWidth <= metrics.viewport + 1, `${label}: no horizontal overflow`)
  assert.equal(metrics.headingCount, 1, `${label}: one clear page heading`)
  assert.equal(metrics.imageCount, 0, `${label}: no illustrative artwork competing with the form`)
  for (const control of metrics.controls) {
    assert.ok(control.width >= 44 && control.height >= 44, `${label}: ${control.label} has a 44px target`)
  }
  if (metrics.viewport >= 768) {
    assert.ok(metrics.cardWidth <= 672, `${label}: desktop form stays compact`)
    assert.ok(Math.abs(metrics.cardLeft - (metrics.viewport - metrics.cardWidth) / 2) <= 2, `${label}: form is centered`)
  }
  return metrics
}

async function installReadOnlyWallet(context) {
  await context.addInitScript((account) => {
    let accounts = []
    const calls = []
    const listeners = new Map()
    const provider = {
      isMetaMask: true,
      async request({ method }) {
        calls.push(method)
        if (method === 'eth_chainId') return '0x4cef52'
        if (method === 'eth_accounts') return accounts
        if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }]
        if (method === 'eth_requestAccounts') {
          accounts = [account]
          return accounts
        }
        if (method.startsWith('eth_send') || method.startsWith('eth_sign') || method === 'personal_sign' || method.startsWith('wallet_send')) {
          throw new Error(`Blocked mock wallet write: ${method}`)
        }
        return null
      },
      on(event, listener) { listeners.set(event, listener); return provider },
      removeListener(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); return provider },
    }
    Object.defineProperty(window, 'ethereum', { configurable: true, value: provider })
    Object.defineProperty(window, '__movyWalletCalls', { configurable: true, value: calls })
    localStorage.removeItem('movy_onboarding_completed')
  }, ACCOUNT)
}

async function runConnected(viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: 'reduce',
  })
  await installReadOnlyWallet(context)
  const readOnlyRpcMethods = []
  await context.route('https://rpc.testnet.arc.io**', async (route) => {
    const request = route.request().postDataJSON()
    readOnlyRpcMethods.push(request.method)
    const result = request.method === 'eth_chainId' ? '0x4cef52' : request.method === 'eth_getCode' ? '0x' : null
    await route.fulfill({ contentType: 'application/json', json: { jsonrpc: '2.0', id: request.id, result } })
  })
  await context.route('**/api/enrollment**', (route) => route.fulfill({
    contentType: 'application/json',
    json: { enrollment: null, onchainConfig: null },
  }))

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Small round-ups. Your own savings wallet.' }).waitFor()
  assert.doesNotMatch(await page.locator('main').innerText(), /Arc Testnet/i, 'Welcome leaves network explanation for wallet setup')
  await assertLayout(page, `${viewport.name} welcome`)
  await page.screenshot({ path: `${OUT}/welcome-${viewport.name}.png` })

  await page.getByRole('button', { name: 'Get Started' }).click()
  await page.getByRole('heading', { name: 'Connect the account you spend from' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Continue in Demo' }).count(), 0, 'Start Saving cannot switch into Demo')
  assert.equal(await page.getByText('No wallet connection needed', { exact: true }).count(), 0, 'Connected setup does not present Demo as a fallback')
  assert.equal(await page.getByRole('button', { name: 'Close setup' }).count(), 1, 'A small accessible close control remains available')
  assert.match(await page.locator('main').innerText(), /Arc Testnet wallet.*shares your public address; it does not move funds/i)
  await assertLayout(page, `${viewport.name} wallet`)
  await page.screenshot({ path: `${OUT}/wallet-${viewport.name}.png` })

  await page.getByRole('button', { name: /Injected|MetaMask/i }).click()
  await page.getByText('Account connected').waitFor()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Where should your savings go?' }).waitFor()
  await page.getByPlaceholder('0x... (must be different from your spending wallet)').fill(DESTINATION)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('alert').filter({ hasText: 'Please confirm that you hold the private keys' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Where should your savings go?' }).count(), 1, 'Key ownership confirmation is required before setup advances')
  await page.getByRole('checkbox').check()
  assert.match(await page.getByRole('status').innerText(), /does not prove you own the private keys/i)
  await page.screenshot({ path: `${OUT}/destination-${viewport.name}.png` })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Set your savings limits' }).waitFor()

  await page.getByRole('button', { name: '$10.00', exact: true }).click()
  assert.doesNotMatch(await page.locator('main').innerText(), /Demo|Preview|Simulated/i, 'Limits omit Demo-mode explanations')
  assert.equal(await page.getByText('Demo daily limit', { exact: true }).count(), 0, 'Limits use connected account copy')
  assert.equal(await page.getByText('Total USDC Allowance Target', { exact: true }).count(), 1, 'Connected setup retains the bounded allowance choice')
  await assertLayout(page, `${viewport.name} limits`)
  await page.screenshot({ path: `${OUT}/limits-${viewport.name}.png` })

  await page.getByRole('button', { name: 'Review & Activate' }).click()
  await page.getByRole('heading', { name: 'Review & activate' }).waitFor()
  const review = await page.locator('main').innerText()
  assert.match(review, /enrollment and a bounded USDC allowance on Arc Testnet/i)
  assert.match(review, /Network fees may apply/i)
  assert.match(review, /Automatic saving begins only after both wallet requests are confirmed/i)
  assert.doesNotMatch(review, /Example data only|No wallet transaction will be submitted/i)
  await assertLayout(page, `${viewport.name} review`)
  await page.screenshot({ path: `${OUT}/review-${viewport.name}.png` })

  const walletCalls = await page.evaluate(() => window.__movyWalletCalls)
  assert.ok(readOnlyRpcMethods.includes('eth_getCode'), `${viewport.name}: destination bytecode check uses read-only eth_getCode`)
  assert.ok(walletCalls.includes('eth_requestAccounts'), `${viewport.name}: connect request is exercised`)
  assert.ok(walletCalls.includes('wallet_requestPermissions'), `${viewport.name}: account permission boundary is exercised`)
  assert.ok(walletCalls.every((method) => !WRITE_METHODS.includes(method)), `${viewport.name}: no wallet signing or transaction request is sent`)
  assert.equal(await page.evaluate(() => localStorage.getItem('movy_onboarding_completed')), null, 'Review does not mark unapproved setup complete')
  assert.deepEqual(errors, [], `${viewport.name}: no browser errors`)
  await context.close()
}

try {
  for (const width of WIDTH_CHECKS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
    const metrics = await assertLayout(page, `${width}px welcome`)
    assert.equal(metrics.viewport, width)
    await context.close()
  }
  for (const viewport of VIEWPORTS) await runConnected(viewport)
  console.log(`PASS: connected onboarding reaches the signing boundary at 390x844 and 1440x900; responsive checks ${WIDTH_CHECKS.join(', ')}px; no wallet write methods are invoked`)
} finally {
  await browser.close()
}
