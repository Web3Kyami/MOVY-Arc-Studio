/**
 * Renders the real Home, Savings and Settings pages in a browser against the local-only
 * verification fixtures and checks the personal switch versus the contract-wide service state.
 *
 * Local verification only: it needs a loopback server started with MOVY_BROWSER_TEST_FIXTURES=true
 * (never enable that for a hosted preview). The wallet is a stub that signs nothing, forwards
 * nothing, and records every write attempt, so nothing leaves the machine.
 *
 *   SHOT_BASE=http://localhost:3111 node scripts/verify/service-pause-states.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.SHOT_BASE || 'http://localhost:3111'
const OUT = process.env.EVIDENCE_OUT || '/tmp/movy-service-pause-states'
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  throw new Error('Browser fixtures are loopback-only; refusing to run against a non-loopback base URL')
}
mkdirSync(OUT, { recursive: true })

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const SECRET_PARTS = ['s3cr3t', 'apikey=', 'token=', 'rpc.example.invalid']

const SCENARIOS = [
  { fixture: 'connected-active', personalPaused: false, service: 'available' },
  { fixture: 'connected-paused', personalPaused: true, service: 'available' },
  { fixture: 'connected-service-paused', personalPaused: false, service: 'paused' },
  { fixture: 'connected-service-checking', personalPaused: false, service: 'checking' },
  { fixture: 'connected-service-unavailable', personalPaused: false, service: 'unavailable' },
  { fixture: 'connected-paused-service-paused', personalPaused: true, service: 'paused' },
]
const ROUTES = [
  { path: '/home', switchName: (paused) => (paused ? 'Resume automatic savings' : 'Pause automatic savings') },
  { path: '/savings', switchName: (paused) => (paused ? 'Resume automatic savings' : 'Pause automatic savings') },
  { path: '/settings', switchName: () => 'Toggle Automatic Saving' },
]
const NOTICE = {
  paused: /Automatic saving is paused service-wide\. Your own setting is unchanged, and you can still pause or revoke\./,
  checking: /Checking whether the saving service is running/,
  unavailable: /Saving status is unavailable\. Try again\./,
}

// A wallet stub: read methods answer locally, every signing or sending method is refused and recorded.
const STUB = ({ account }) => {
  window.__walletCalls = []
  const provider = {
    isMetaMask: true,
    async request({ method }) {
      window.__walletCalls.push(method)
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': return [account]
        case 'eth_chainId': return '0x4cef52'
        case 'net_version': return '5042002'
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
        case 'wallet_requestPermissions': return null
        case 'eth_blockNumber': return '0x1'
        case 'eth_getBalance': return '0x0'
        default:
          throw Object.assign(new Error(`Refused by the verification stub: ${method}`), { code: 4001 })
      }
    },
    on() { return provider },
    removeListener() { return provider },
  }
  window.ethereum = provider
}

const results = []
const problems = []
const check = (label, fn) => {
  try {
    fn()
    results.push(label)
  } catch (error) {
    problems.push(`${label}: ${error.message.split('\n')[0]}`)
  }
}

const browser = await launchChromium()
try {
  for (const [viewportLabel, viewport] of [['390', { width: 390, height: 844 }], ['1280', { width: 1280, height: 900 }]]) {
    for (const scenario of SCENARIOS) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
      await context.addInitScript(STUB, { account: ACCOUNT })
      await context.addInitScript((fixture) => localStorage.setItem('movy_test_fixture', fixture), scenario.fixture)
      const page = await context.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error).split('\n')[0]))

      // Connect the stub wallet once (the Settings switch is gated on a real wallet connection),
      // then reload each route so the persisted connection is restored.
      await page.goto(`${BASE}/settings`, { waitUntil: 'load', timeout: 90000 })
      const connect = page.getByRole('button', { name: 'Connect wallet', exact: true }).first()
      await connect.waitFor({ timeout: 60000 })
      await connect.click()
      const chooseWallet = page.getByRole('button', { name: 'Choose wallet', exact: true }).first()
      if (await chooseWallet.count()) {
        await chooseWallet.click()
        await page.getByRole('button', { name: /MetaMask|Injected/i }).first().click()
      } else {
        await page.getByRole('button', { name: /Connect Injected|Connect MetaMask/i }).first().click()
      }
      const connected = await page.getByRole('button', { name: /Disconnect wallet/i }).first().waitFor({ timeout: 60000 }).then(() => true, () => false)
      assert.equal(connected, true, 'harness could not connect the stub wallet')

      for (const route of ROUTES) {
        const tag = `${viewportLabel}px ${scenario.fixture} ${route.path}`
        await page.goto(`${BASE}${route.path}?fixture=${scenario.fixture}`, { waitUntil: 'load', timeout: 90000 })
        if (route.path === '/home' && viewport.width < 768) await page.getByText('Recent activity').first().waitFor({ timeout: 60000 })
        else await page.getByRole('switch').first().waitFor({ timeout: 60000 })
        if (route.path === '/settings') {
          // Settings gates the switch on the stub wallet being reconnected after the reload.
          const walletReady = await page.locator('#saving-blocked').waitFor({ state: 'detached', timeout: 30000 }).then(() => true, () => false)
          check(`${tag}: harness wallet reconnected`, () => assert.equal(walletReady, true))
        }
        await page.waitForTimeout(900)
        await page.evaluate(() => { window.__movyFixtureSetPaused = []; window.__movyFixtureServiceRetries = 0 })

        const expectedName = route.switchName(scenario.personalPaused)
        const sw = page.getByRole('switch', { name: expectedName, exact: true })
        // By design Home shows its own switch from 768px up; narrower, Settings and Savings hold it.
        const homeHasNoSwitch = route.path === '/home' && viewport.width < 768
        const switchCount = await sw.count()
        if (homeHasNoSwitch) {
          check(`${tag}: narrow Home has no switch by design`, () => assert.equal(switchCount, 0))
        } else {
          check(`${tag}: switch exposes the PERSONAL state ("${expectedName}")`, () => assert.equal(switchCount, 1))
          if (switchCount !== 1) continue
        }

        let switchText = ''
        if (!homeHasNoSwitch) {
        const ariaChecked = await sw.getAttribute('aria-checked')
        check(`${tag}: aria-checked is the personal state, not effective Active`, () =>
          assert.equal(ariaChecked, String(!scenario.personalPaused)))
        switchText = (await sw.innerText()).replace(/\s+/g, ' ').trim()
        check(`${tag}: switch text is On/Paused from the personal flag only`, () =>
          assert.equal(switchText, scenario.personalPaused ? 'Paused' : 'On'))
        const disabled = await sw.isDisabled()
        check(`${tag}: protective personal switch stays usable whatever the service state`, () => assert.equal(disabled, false))
        }

        const main = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
        if (scenario.service === 'available') {
          check(`${tag}: no service notice while the service is confirmed running`, () => {
            for (const pattern of Object.values(NOTICE)) assert.doesNotMatch(main, pattern)
          })
        } else {
          check(`${tag}: ${scenario.service} service notice is shown`, () => assert.match(main, NOTICE[scenario.service]))
          if (scenario.service === 'paused') {
            const notice = (await page.getByText(NOTICE.paused).first().innerText()).trim()
            check(`${tag}: the pause notice offers no Resume or restart action`, () => assert.doesNotMatch(notice, /resume|restart|unpause|turn on/i))
          }
          check(`${tag}: nothing claims saving is Active while the service is ${scenario.service}`, () => {
            assert.notEqual(switchText, 'Active')
            assert.doesNotMatch(main, /\bActive\b/)
          })
        }
        check(`${tag}: no provider or credential-shaped text`, () => {
          for (const part of SECRET_PARTS) assert.ok(!main.includes(part), `leaked ${part}`)
        })

        if (scenario.service === 'unavailable') {
          const retry = page.getByRole('button', { name: 'Retry', exact: true }).first()
          const retryCount = await retry.count()
          check(`${tag}: Retry control present`, () => assert.equal(retryCount > 0, true))
          if (retryCount) {
            await retry.click()
            const retries = await page.evaluate(() => window.__movyFixtureServiceRetries)
            const changed = await page.evaluate(() => window.__movyFixtureSetPaused)
            check(`${tag}: Retry only re-reads the service`, () => assert.equal(retries, 1))
            check(`${tag}: Retry does not change the personal setting`, () => assert.deepEqual(changed, []))
          }
        }

        // Toggling flips only the user's own pause flag, whatever the service state is.
        if (!homeHasNoSwitch) {
          await sw.click()
          await page.waitForTimeout(500)
          const intents = await page.evaluate(() => window.__movyFixtureSetPaused)
          check(`${tag}: toggle intent is the personal flip (${scenario.personalPaused ? 'resume' : 'pause'} yourself)`, () =>
            assert.deepEqual(intents, [!scenario.personalPaused]))
          const afterText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
          if (route.path === '/settings') {
            const expectedToast = scenario.personalPaused ? 'Automatic saving resumed' : 'Automatic saving paused'
            check(`${tag}: Settings confirmation matches the personal intent ("${expectedToast}")`, () =>
              assert.match(afterText, new RegExp(expectedToast)))
            const wrong = scenario.personalPaused ? 'Automatic saving paused' : 'Automatic saving resumed'
            check(`${tag}: Settings never shows the opposite confirmation`, () => assert.doesNotMatch(afterText, new RegExp(wrong)))
          }
        }
        const writes = await page.evaluate(() => window.__walletCalls.filter((m) => /send|sign/i.test(m)))
        check(`${tag}: no wallet signing or sending was attempted`, () => assert.deepEqual(writes, []))

        await page.screenshot({ path: `${OUT}/${viewportLabel}-${scenario.fixture}${route.path.replace('/', '-')}.png`, fullPage: true })
      }
      check(`${viewportLabel}px ${scenario.fixture}: no uncaught page errors`, () => assert.deepEqual(pageErrors, []))
      await context.close()
    }
  }
} finally {
  await browser.close()
}

console.log(`${results.length} checks passed`)
if (problems.length) {
  console.error(`${problems.length} checks FAILED:`)
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}
console.log(`PASS: Home, Savings and Settings render the personal switch separately from the service state (screenshots in ${OUT})`)
