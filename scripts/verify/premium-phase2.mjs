import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.DEMO_SHOT_BASE || 'http://localhost:3112'
const OUT = process.env.EVIDENCE_OUT || 'artifacts/premium-phase2'
mkdirSync(OUT, { recursive: true })
const browser = await launchChromium()
const checks = []
const routes = ['home', 'savings', 'savings/new', 'activity']

async function ready(page) {
  await page.locator('.consumer-demo:visible').waitFor()
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function geometry(page) {
  const problems = await page.evaluate(() => {
    const main = document.querySelector('#main').getBoundingClientRect()
    const errors = []
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('horizontal overflow')
    for (const element of document.querySelectorAll('#main button,#main input,#main a[href],#main [role=progressbar]')) {
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      if (rect.left < main.left - 1 || rect.right > main.right + 1) errors.push(`${element.textContent} outside canvas`)
      if ((element.tagName === 'BUTTON' || element.tagName === 'INPUT') && (rect.width < 44 || rect.height < 44))
        errors.push(`${element.textContent} small target`)
    }
    return errors
  })
  assert.deepEqual(problems, [])
}

try {
  for (const width of [320, 390, 768, 900, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    for (const route of routes) {
      await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' })
      await ready(page)
      assert.equal(await page.evaluate(() => innerWidth), width)
      await geometry(page)
      assert.equal(await page.locator('.consumer-demo:visible').count(), 1)
      const copy = await page.locator('#main').innerText()
      assert.doesNotMatch(copy, /Preview|Simulated|Testnet|Mainnet|blockchain|RPC|contract/i)
      assert.doesNotMatch(copy, /0x[0-9a-f]{8}/i)
      if (width >= 768) {
        assert.equal(await page.locator('.consumer-identity').innerText(), 'Alex')
        assert.equal(await page.locator('.consumer-identity').getAttribute('href'), '/settings/profile')
      }
      if (route === 'savings') {
        const goalNames = await page.locator('.goal-summary h3').allTextContents()
        assert.equal(goalNames.filter(name => name.trim() === 'Emergency Cushion').length, 1,
          'A featured goal must not be repeated in the supporting-goal list')
        assert.ok(goalNames.includes('Japan Adventure'))
      }
      if (route === 'home') await page.getByText('$355.00', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUT}/${route.replace('savings/new', 'create-goal')}-${width}.png` })
      await page.screenshot({ path: `${OUT}/${route.replace('savings/new', 'create-goal')}-full-${width}.png`, fullPage: true })
      if (route === 'activity') {
        await page.getByRole('button', { name: /^View receipt for/ }).first().click()
        const receipt = page.getByRole('dialog', { name: 'Demo receipt' })
        await receipt.waitFor()
        assert.match(await receipt.innerText(), /Example only — no money moved\./)
        assert.equal(await receipt.getByRole('link').count(), 0)
        await geometry(page)
        await page.screenshot({ path: `${OUT}/receipt-${width}.png` })
        await page.keyboard.press('Escape')
      }
    }
    assert.deepEqual(errors, [])
    await context.close()
    checks.push({ width, responsive: true, targets: true, singleDemo: true, exampleReceipt: true })
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(`${BASE}/savings/new`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Create goal', exact: true }).click()
  await page.getByText('Enter a goal name of 1 to 60 characters.').waitFor()
  assert.equal(await page.getByLabel('Goal name').evaluate(element => element === document.activeElement), true)
  await page.getByLabel('Goal name').fill('A very long savings goal for a family trip and a new camera')
  for (const value of ['-50', '0', '10000.01', '12.345', '1e3']) {
    await page.getByLabel('Target amount (USDC)').fill(value)
    await page.getByRole('button', { name: 'Create goal', exact: true }).click()
    await page.getByText('Enter a positive USDC target', { exact: false }).waitFor()
    assert.ok(page.url().endsWith('/savings/new'))
  }
  await page.getByLabel('Target amount (USDC)').fill('1234.56')
  const travel = page.getByRole('radio', { name: 'Travel', exact: true })
  await travel.check()
  await travel.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.getByRole('radio', { name: 'Tech', exact: true }).isChecked(), true)
  await page.getByRole('button', { name: 'Create goal', exact: true }).click()
  await page.waitForURL('**/savings')
  await page.reload({ waitUntil: 'networkidle' })
  const goal = page.getByRole('article', { name: 'A very long savings goal for a family trip and a new camera' })
  await goal.waitFor()
  assert.match(await goal.innerText(), /\$0\.00 \/ \$1,234\.56/)
  assert.equal(await goal.getByRole('progressbar').getAttribute('aria-valuenow'), '0')
  await page.setViewportSize({ width: 320, height: 844 })
  await geometry(page)
  assert.equal(await goal.locator('.goal-thumbnail').getAttribute('data-cover'), 'tech')
  assert.equal(await goal.locator('h3').evaluate(element => element.scrollWidth <= element.clientWidth), true)
  await page.screenshot({ path: `${OUT}/long-goal-320.png`, fullPage: true })
  await context.close()

  writeFileSync(`${OUT}/results.json`, JSON.stringify({ browser: browser.version(), checks, longGoal: true, allPassed: true }, null, 2))
  console.log(`PASS: Demo Home, Savings, Create Goal, and Activity across six widths (${checks.length} viewport cases)`)
} finally {
  await browser.close()
}
