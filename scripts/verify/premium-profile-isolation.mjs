import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const PRODUCT = process.env.SHOT_BASE || 'http://localhost:3111'
const DEMO = process.env.DEMO_SHOT_BASE || 'http://localhost:3112'
const OUT = process.env.EVIDENCE_OUT || 'artifacts/profile-isolation'
mkdirSync(OUT, { recursive: true })
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const browser = await launchChromium()
const checks = []

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(({ A, B }) => {
    let accounts = [A]
    const listeners = new Map()
    window.__walletWrites = []
    const provider = {
      isMetaMask: true,
      async request({ method }) {
        if (/sendTransaction|sign|personal_sign/.test(method)) {
          window.__walletWrites.push(method)
          throw new Error('This profile test never authorizes a transaction')
        }
        if (method === 'eth_chainId') return '0x4cef52'
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return accounts
        if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }]
        return null
      },
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event).add(listener)
        return provider
      },
      removeListener(event, listener) { listeners.get(event)?.delete(listener); return provider },
    }
    window.__switchTestWallet = () => {
      accounts = [B]
      listeners.get('accountsChanged')?.forEach(listener => listener(accounts))
    }
    Object.defineProperty(window, 'ethereum', { configurable: true, value: provider })
  }, { A, B })
  await context.route('https://rpc.testnet.arc.io**', async route => {
    const payload = route.request().postDataJSON()
    const respond = request => ({
      jsonrpc: '2.0',
      id: request.id,
      result: request.method === 'eth_chainId' ? '0x4cef52' : request.method === 'eth_getCode' ? '0x' : '0x0',
    })
    await route.fulfill({ json: Array.isArray(payload) ? payload.map(respond) : respond(payload) })
  })
  await context.route('**/api/enrollment**', route => route.fulfill({ json: { enrollment: null, onchainConfig: null } }))
  await context.route('**/api/auto-saver/activity**', route => route.fulfill({ json: { items: [], total: 0 } }))
  const page = await context.newPage()
  await page.goto(`${PRODUCT}/settings`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  await page.getByRole('button', { name: /Connect Injected|Connect MetaMask/i }).click()
  await page.getByRole('link', { name: 'Edit profile', exact: true }).waitFor({ timeout: 15_000 })
  await page.getByRole('link', { name: 'Edit profile', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Wallet A identity')
  await page.getByLabel('Upload photo').setInputFiles('public/avatars/alex.png')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL('**/settings')

  await page.locator('.consumer-sidebar').getByRole('link', { name: 'Savings', exact: true }).click()
  await page.getByRole('link', { name: 'Create a new goal', exact: true }).first().click()
  await page.getByLabel('Goal name').fill('Wallet A goal')
  await page.getByLabel('Target amount (USDC)').fill('123.45')
  await page.getByRole('button', { name: 'Create goal', exact: true }).click()
  await page.waitForURL('**/savings')
  await page.getByRole('article', { name: 'Wallet A goal' }).waitFor()

  await page.evaluate(() => window.__switchTestWallet())
  await page.waitForFunction(() => document.querySelector('.consumer-identity strong')?.textContent !== 'Wallet A identity')
  await page.locator('.consumer-sidebar').getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('link', { name: 'Edit profile', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Wallet B identity')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL('**/settings')
  await page.locator('.profile-summary strong').getByText('Wallet B identity', { exact: true }).waitFor()
  assert.equal(await page.getByRole('article', { name: 'Wallet A goal' }).count(), 0,
    'Wallet B does not inherit wallet A goals')
  const productStorage = await page.evaluate(({ A, B }) => ({
    profileA: JSON.parse(localStorage.getItem(`movy:profile:v1:wallet:${A}`)),
    profileB: JSON.parse(localStorage.getItem(`movy:profile:v1:wallet:${B}`)),
    goalsA: JSON.parse(localStorage.getItem(`movy_goals_${A}`)),
    goalsB: JSON.parse(localStorage.getItem(`movy_goals_${B}`)),
  }), { A, B })
  assert.equal(productStorage.profileA.name, 'Wallet A identity')
  assert.match(productStorage.profileA.photo, /^data:image\/jpeg;base64,/)
  assert.equal(productStorage.profileB.name, 'Wallet B identity')
  assert.deepEqual(productStorage.goalsA.map(goal => goal.title), ['Wallet A goal'])
  assert.deepEqual(productStorage.goalsB ?? [], [])
  assert.deepEqual(await page.evaluate(() => window.__walletWrites), [], 'Profile editing never signs a transaction')
  await page.screenshot({ path: `${OUT}/product-wallet-b-profile.png` })
  await context.close()
  checks.push('product profile and goals remain scoped to each connected wallet; profile upload does not sign')

  const demoContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const demoPage = await demoContext.newPage()
  await demoPage.goto(`${DEMO}/settings/profile`, { waitUntil: 'networkidle' })
  assert.equal(await demoPage.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Alex',
    'The isolated Demo uses its own seeded profile')
  assert.equal(await demoPage.evaluate(() => localStorage.getItem('movy:profile:v1:wallet:0x1111111111111111111111111111111111111111')), null,
    'Product wallet profile keys are not present on the Demo origin')
  await demoPage.getByRole('textbox', { name: 'Name', exact: true }).fill('Demo identity')
  await demoPage.getByRole('button', { name: 'Save', exact: true }).click()
  await demoPage.waitForURL('**/settings')
  await demoPage.locator('.profile-summary strong').waitFor()
  assert.equal(await demoPage.locator('.profile-summary strong').innerText(), 'Demo identity',
    'Demo profile changes appear on Settings after leaving Edit Profile')
  assert.equal(await demoPage.evaluate(() => localStorage.getItem('movy:profile:v1:wallet:0x1111111111111111111111111111111111111111')), null)
  await demoContext.close()
  checks.push('Demo profile stays origin-isolated from connected wallet identities')

  writeFileSync(`${OUT}/isolation-results.json`, JSON.stringify({
    checks,
    allPassed: true,
    browser: browser.version(),
    usesLiveWallet: false,
    signsTransactions: false,
  }, null, 2))
  console.log(`PASS: ${checks.join('; ')}`)
} finally {
  await browser.close()
}
