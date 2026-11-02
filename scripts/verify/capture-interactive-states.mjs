import { chromium } from 'playwright-core'
import { resolve } from 'node:path'

const BASE = 'http://localhost:3111'
const OUT = resolve(process.cwd(), '..', 'out', 'visual-pilot-01')

const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
})

try {
  // 1. Landing Interactive State: Select "Weekly Groceries" ($38.20 -> $39.00 -> +$0.80)
  const landingContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })
  const landingPage = await landingContext.newPage()
  await landingPage.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await landingPage.waitForTimeout(600)
  // Click "Weekly Groceries"
  await landingPage.getByRole('button', { name: /Weekly Groceries/i }).click()
  await landingPage.waitForTimeout(400)
  await landingPage.screenshot({ path: `${OUT}/landing-desktop-1440px-simulator-groceries.png` })
  console.log('Saved: landing-desktop-1440px-simulator-groceries.png')
  await landingContext.close()

  // 2. Home in Connected Mode: Open Settings, switch to connected mode, return to Home
  const homeContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })
  const homePage = await homeContext.newPage()
  await homePage.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await homePage.waitForTimeout(600)
  const switchBtn = homePage.getByRole('button', { name: /Switch to Connected Mode/i })
  if (await switchBtn.count() > 0) {
    await switchBtn.click()
    await homePage.waitForTimeout(500)
  }
  await homePage.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await homePage.waitForTimeout(800)
  await homePage.screenshot({ path: `${OUT}/home-desktop-1440px-connected-mode.png` })
  console.log('Saved: home-desktop-1440px-connected-mode.png')
  await homeContext.close()
} finally {
  await browser.close()
}
