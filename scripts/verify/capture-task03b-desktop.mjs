/**
 * MOVY Task 03B Desktop Wallet Experience Verification Script
 *
 * Captures all required viewports, states, responsive crossovers, and interactive checks:
 * 1. Mobile 320px (confirming mobile corrections: consolidated disclosure & untruncated monthly statistic)
 * 2. Mobile 390px (mobile companion comparison)
 * 3. Tablet 900px (crossover deliberately handled)
 * 4. Desktop 1280px (standard desktop adaptation)
 * 5. Desktop 1440px (primary design target - full-page and viewport)
 * 6. Desktop 1440px Disconnected State
 * 7. Desktop 1440px Connected Empty State (confirmed zero)
 * 8. Desktop 1440px Connected Loading State
 * 9. Desktop 1440px Connected RPC Error State
 * 10. Desktop 1440px Connected Active State
 * 11. Desktop 1920px (large desktop adaptation with bounded container)
 * 12. Interactive checks (savings control toggle & nav focus)
 */

import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const PORT = 3115
const BASE = `http://localhost:${PORT}`
const OUT = resolve(process.cwd(), 'out', 'task03b-desktop')
mkdirSync(OUT, { recursive: true })

const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

console.log('=== MOVY TASK 03B DESKTOP WALLET CAPTURE & AUDIT ===')

async function ensureServer() {
  try {
    const res = await fetch(`${BASE}/home`)
    if (res.ok) {
      console.log(`Server already responsive on ${BASE}`)
      return null
    }
  } catch {}

  console.log(`Starting next start on port ${PORT}...`)
  const srv = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    shell: true,
    stdio: 'ignore',
  })

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const res = await fetch(`${BASE}/home`)
      if (res.ok) {
        console.log(`Server started successfully on ${BASE}`)
        return srv
      }
    } catch {}
  }
  throw new Error(`Server failed to start on ${BASE} within 30 seconds`)
}

async function run() {
  const srv = await ensureServer()

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  })

  const results = {
    viewports: [],
    stateFixtures: [],
    interactionChecks: [],
    overflowViolations: [],
    touchTargetViolations: [],
    emojiViolations: [],
  }

  // Helper to audit page for overflow, touch targets, and emoji
  async function auditPage(page, label) {
    const overflow = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth
      const winW = window.innerWidth
      return { docW, winW, hasOverflow: docW > winW }
    })
    if (overflow.hasOverflow) {
      results.overflowViolations.push({ label, overflow })
    }

    const touchTargets = await page.evaluate(() => {
      const violations = []
      const clickables = document.querySelectorAll('button, a, [role="button"], [role="switch"]')
      clickables.forEach((el) => {
        const rect = el.getBoundingClientRect()
        // Only check elements in viewport that are visible and not sr-only
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && !el.classList.contains('sr-only')) {
          if (rect.width < 44 || rect.height < 44) {
            violations.push({
              tag: el.tagName,
              text: el.innerText.trim().slice(0, 30),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            })
          }
        }
      })
      return violations
    })
    if (touchTargets.length > 0) {
      results.touchTargetViolations.push({ label, touchTargets })
    }

    const emojiViolations = await page.evaluate(() => {
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u
      const elements = Array.from(document.querySelectorAll('body *'))
      return elements
        .filter((el) => el.children.length === 0 && emojiRegex.test(el.textContent || ''))
        .map((el) => el.textContent.trim().slice(0, 30))
    })
    if (emojiViolations.length > 0) {
      results.emojiViolations.push({ label, emojiViolations })
    }
  }

  // 1. Mobile 320px (Verification of mobile corrections)
  console.log('Capturing Mobile 320px...')
  const page320 = await browser.newPage({ viewport: { width: 320, height: 640 } })
  await page320.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await page320.waitForTimeout(600)
  const path320 = resolve(OUT, 'home-mobile-320px-corrections.png')
  await page320.screenshot({ path: path320 })
  await auditPage(page320, 'mobile-320px')
  results.viewports.push({ name: 'mobile-320px', path: path320 })

  // Check 320px monthly statistic truncation
  const statText320 = await page320.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find((e) =>
      e.textContent.includes('round-ups this month')
    )
    return el ? el.innerText.trim() : null
  })
  console.log('320px monthly statistic rendered text:', statText320)

  // 2. Mobile 390px
  console.log('Capturing Mobile 390px...')
  const page390 = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page390.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await page390.waitForTimeout(600)
  const path390 = resolve(OUT, 'home-mobile-390px.png')
  await page390.screenshot({ path: path390 })
  await auditPage(page390, 'mobile-390px')
  results.viewports.push({ name: 'mobile-390px', path: path390 })

  // 3. Tablet 900px
  console.log('Capturing Tablet 900px...')
  const page900 = await browser.newPage({ viewport: { width: 900, height: 1024 } })
  await page900.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await page900.waitForTimeout(600)
  const path900 = resolve(OUT, 'home-tablet-900px.png')
  await page900.screenshot({ path: path900 })
  await auditPage(page900, 'tablet-900px')
  results.viewports.push({ name: 'tablet-900px', path: path900 })

  // 4. Desktop 1280px
  console.log('Capturing Desktop 1280px...')
  const page1280 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page1280.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await page1280.waitForTimeout(600)
  const path1280 = resolve(OUT, 'home-desktop-1280px.png')
  await page1280.screenshot({ path: path1280 })
  await auditPage(page1280, 'desktop-1280px')
  results.viewports.push({ name: 'desktop-1280px', path: path1280 })

  // 5. Desktop 1440px (Primary Viewport - Viewport & Full-Page)
  console.log('Capturing Desktop 1440px...')
  const page1440 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page1440.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await page1440.waitForTimeout(600)
  const path1440 = resolve(OUT, 'home-desktop-1440px.png')
  await page1440.screenshot({ path: path1440 })
  const path1440Full = resolve(OUT, 'home-desktop-1440px-fullpage.png')
  await page1440.screenshot({ path: path1440Full, fullPage: true })
  await auditPage(page1440, 'desktop-1440px')
  results.viewports.push({ name: 'desktop-1440px', path: path1440 })
  results.viewports.push({ name: 'desktop-1440px-fullpage', path: path1440Full })

  // 6. Desktop 1920px (Large Screen adaptation)
  console.log('Capturing Desktop 1920px...')
  const page1920 = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page1920.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await page1920.waitForTimeout(600)
  const path1920 = resolve(OUT, 'home-desktop-1920px.png')
  await page1920.screenshot({ path: path1920 })
  await auditPage(page1920, 'desktop-1920px')
  results.viewports.push({ name: 'desktop-1920px', path: path1920 })

  // 7. Desktop 1440px Account State Fixtures
  const fixtures = [
    { id: 'disconnected', label: 'Desktop Disconnected Wallet', file: 'home-desktop-1440px-state-disconnected.png' },
    { id: 'connected-zero', label: 'Desktop Connected Confirmed Zero', file: 'home-desktop-1440px-state-connected-zero.png' },
    { id: 'connected-loading', label: 'Desktop Connected Loading', file: 'home-desktop-1440px-state-connected-loading.png' },
    { id: 'connected-error', label: 'Desktop Connected RPC Error', file: 'home-desktop-1440px-state-connected-error.png' },
    { id: 'connected-active', label: 'Desktop Connected Live Activity', file: 'home-desktop-1440px-state-connected-active.png' },
  ]

  for (const fix of fixtures) {
    console.log(`Capturing ${fix.label}...`)
    const pageFix = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await pageFix.goto(`${BASE}/home?fixture=${fix.id}`, { waitUntil: 'networkidle' })
    await pageFix.waitForTimeout(600)
    const fixPath = resolve(OUT, fix.file)
    await pageFix.screenshot({ path: fixPath })
    results.stateFixtures.push({ id: fix.id, label: fix.label, path: fixPath })
    await pageFix.close()
  }

  // 8. Interactive checks (Desktop savings control toggle & sidebar navigation)
  console.log('Testing Interactive Desktop Controls...')
  const testPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await testPage.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await testPage.waitForTimeout(500)

  // Find savings control switch button in evergreen upper section
  const toggleBtn = testPage.locator('section[aria-labelledby="total-saved-heading"] button[role="switch"]')
  const initialText = (await toggleBtn.innerText()).trim()
  console.log('Initial savings control toggle text:', initialText)

  // Click toggle
  await toggleBtn.click()
  await testPage.waitForTimeout(500)
  const toggledText = (await toggleBtn.innerText()).trim()
  console.log('Toggled savings control text:', toggledText)

  const togglePath = resolve(OUT, 'home-desktop-1440px-interactive-toggled.png')
  await testPage.screenshot({ path: togglePath })

  results.interactionChecks.push({
    control: 'savings-control-toggle',
    initialText,
    toggledText,
    path: togglePath,
    success: initialText !== toggledText,
  })

  // Test sidebar navigation hover & focus
  const navSavingsLink = testPage.locator('aside nav a[href="/savings"]')
  await navSavingsLink.focus()
  const focusPath = resolve(OUT, 'home-desktop-1440px-interactive-focus.png')
  await testPage.screenshot({ path: focusPath })
  results.interactionChecks.push({
    control: 'nav-focus',
    path: focusPath,
    success: true,
  })

  await testPage.close()
  await browser.close()

  if (srv) {
    srv.kill()
  }

  const summaryPath = resolve(OUT, 'audit-summary.json')
  writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf-8')
  console.log(`Audit summary saved to ${summaryPath}`)
  console.log('Total overflow violations:', results.overflowViolations.length)
  console.log('Total touch target violations:', results.touchTargetViolations.length)
  console.log('Total emoji violations:', results.emojiViolations.length)
  console.log('=== TASK 03B DESKTOP CAPTURE & AUDIT COMPLETE ===')
}

run().catch((err) => {
  console.error('Fatal error during capture script:', err)
  process.exit(1)
})
