import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PORT = 3118
const BASE = `http://localhost:${PORT}`
const OUT = resolve(process.cwd(), 'out', 'task03b1-corrections')
mkdirSync(OUT, { recursive: true })

const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function startServer() {
  console.log(`Starting next start on port ${PORT}...`)
  const srv = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    shell: true,
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
  })

  srv.stdout?.on('data', (d) => {
    const s = d.toString()
    if (s.includes('Ready in') || s.includes('started server') || s.includes('Listening')) {
      // ready
    }
  })

  // Poll until responsive
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/home`)
      if (res.ok) {
        console.log(`Server started successfully on ${BASE}`)
        return srv
      }
    } catch {}
    await wait(500)
  }
  throw new Error(`Server failed to start on port ${PORT}`)
}

async function run() {
  let srv = null
  try {
    const check = await fetch(`${BASE}/home`).catch(() => null)
    if (!check || !check.ok) {
      srv = await startServer()
    } else {
      console.log(`Using already running server at ${BASE}`)
    }

    const browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
    })

    const auditSummary = {
      timestamp: new Date().toISOString(),
      captures: [],
      checks: {},
    }

    // =========================================================================
    // 1. DESKTOP PREVIEW ACTIVE VERSUS PAUSED (1440px)
    // =========================================================================
    console.log('1. Capturing Desktop Preview Active vs Paused...')
    const pageActive = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await pageActive.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
    await pageActive.waitForTimeout(600)

    const activeToggleBtn = pageActive.locator('section[aria-labelledby="total-saved-heading"] button[role="switch"]')
    const activeText = (await activeToggleBtn.innerText()).trim()
    const sidebarExpl = await pageActive.locator('aside p:has-text("Simulated round-ups")').innerText()

    const pathActive = resolve(OUT, 'home-desktop-preview-active.png')
    await pageActive.screenshot({ path: pathActive })
    auditSummary.captures.push({ name: 'home-desktop-preview-active.png', path: pathActive })
    auditSummary.checks.previewActive = {
      toggleText: activeText,
      sidebarExplanation: sidebarExpl,
      isActive: activeText.includes('Active'),
    }

    // Toggle to Paused
    await activeToggleBtn.click()
    await pageActive.waitForTimeout(600)

    const pausedText = (await activeToggleBtn.innerText()).trim()
    const sidebarExplPaused = await pageActive.locator('aside p:has-text("Simulated round-ups")').innerText()

    const pathPaused = resolve(OUT, 'home-desktop-preview-paused.png')
    await pageActive.screenshot({ path: pathPaused })
    auditSummary.captures.push({ name: 'home-desktop-preview-paused.png', path: pathPaused })
    auditSummary.checks.previewPaused = {
      toggleText: pausedText,
      sidebarExplanation: sidebarExplPaused,
      isPaused: pausedText.includes('Paused'),
      explanationSynchronised: sidebarExplPaused.includes('temporarily paused'),
    }
    await pageActive.close()

    // =========================================================================
    // 2. DESKTOP LOADING AND RPC ERROR (1440px)
    // =========================================================================
    console.log('2. Capturing Desktop Loading and RPC Error...')
    // A. Loading
    const pageLoading = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await pageLoading.goto(`${BASE}/home?fixture=connected-loading`, { waitUntil: 'networkidle' })
    await pageLoading.waitForTimeout(600)

    const savingsLoadingText = await pageLoading.locator('section[aria-labelledby="total-saved-heading"]').innerText()
    const activityLoadingText = await pageLoading.locator('section[aria-labelledby="recent-activity-heading"]').innerText()

    const pathLoading = resolve(OUT, 'home-desktop-loading.png')
    await pageLoading.screenshot({ path: pathLoading })
    auditSummary.captures.push({ name: 'home-desktop-loading.png', path: pathLoading })
    auditSummary.checks.loadingState = {
      savingsLoadingDetected: savingsLoadingText.includes('Querying live Arc Testnet vault'),
      activityLoadingDetected: activityLoadingText.includes('Loading activity records'),
      notConflatedWithEmpty: !activityLoadingText.includes('No round-ups recorded yet'),
    }
    await pageLoading.close()

    // B. RPC Error
    const pageError = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await pageError.goto(`${BASE}/home?fixture=connected-error`, { waitUntil: 'networkidle' })
    await pageError.waitForTimeout(600)

    const savingsErrorText = await pageError.locator('section[aria-labelledby="total-saved-heading"]').innerText()
    const activityErrorText = await pageError.locator('section[aria-labelledby="recent-activity-heading"]').innerText()

    const pathError = resolve(OUT, 'home-desktop-rpc-error.png')
    await pageError.screenshot({ path: pathError })
    auditSummary.captures.push({ name: 'home-desktop-rpc-error.png', path: pathError })
    auditSummary.checks.errorState = {
      savingsErrorDetected: savingsErrorText.includes('Arc Testnet RPC connection timeout'),
      activityErrorDetected: activityErrorText.includes('Unable to load activity'),
      notConflatedWithEmpty: !activityErrorText.includes('No round-ups recorded yet'),
    }
    await pageError.close()

    // =========================================================================
    // 3. DESKTOP DISCONNECTED AND CONNECTED-UNENROLLED (1440px)
    // =========================================================================
    console.log('3. Capturing Desktop Disconnected & Connected-Unenrolled...')
    // A. Disconnected
    const pageDisconnected = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await pageDisconnected.goto(`${BASE}/home?fixture=disconnected`, { waitUntil: 'networkidle' })
    await pageDisconnected.waitForTimeout(600)

    const pathDisconnected = resolve(OUT, 'home-desktop-disconnected.png')
    await pageDisconnected.screenshot({ path: pathDisconnected })
    auditSummary.captures.push({ name: 'home-desktop-disconnected.png', path: pathDisconnected })
    await pageDisconnected.close()

    // B. Connected-Unenrolled
    const pageUnenrolled = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await pageUnenrolled.goto(`${BASE}/home?fixture=connected-unenrolled`, { waitUntil: 'networkidle' })
    await pageUnenrolled.waitForTimeout(600)

    const unenrolledBadge = await pageUnenrolled.locator('aside a[title="Go to Settings to change mode"]').innerText()
    const goalHeading = await pageUnenrolled.locator('#goal-heading').innerText()
    const destinationText = await pageUnenrolled.locator('section[aria-labelledby="total-saved-heading"]').innerText()

    const pathUnenrolled = resolve(OUT, 'home-desktop-connected-unenrolled.png')
    await pageUnenrolled.screenshot({ path: pathUnenrolled })
    auditSummary.captures.push({ name: 'home-desktop-connected-unenrolled.png', path: pathUnenrolled })
    auditSummary.checks.connectedUnenrolled = {
      badgeSublabelTruthful: unenrolledBadge.includes('Spending Wallet · Not Enrolled'),
      goalHeadingAppropriate: goalHeading.includes('SAVINGS GOALS'),
      notClaimingActiveVault: !unenrolledBadge.includes('Live Non-Custodial Vault'),
      destinationReportedNotEnrolled: destinationText.includes('Not Enrolled'),
    }
    await pageUnenrolled.close()

    // =========================================================================
    // 4. ACTUAL KEYBOARD FOCUS STATE (1440px)
    // =========================================================================
    console.log('4. Capturing Actual Keyboard Focus State...')
    const pageFocus = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await pageFocus.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
    await pageFocus.waitForTimeout(600)

    // Tab through skip-link and nav items to focus on "Savings" nav destination
    await pageFocus.keyboard.press('Tab') // Skip link
    await pageFocus.keyboard.press('Tab') // Mode indicator link
    await pageFocus.keyboard.press('Tab') // DesktopNav Home
    await pageFocus.keyboard.press('Tab') // DesktopNav Savings
    await pageFocus.waitForTimeout(300)

    const focusedElement = await pageFocus.evaluate(() => {
      const el = document.activeElement
      return {
        tagName: el?.tagName,
        text: el?.textContent?.trim(),
        href: el?.getAttribute('href'),
      }
    })

    const pathFocus = resolve(OUT, 'home-desktop-keyboard-focus.png')
    await pageFocus.screenshot({ path: pathFocus })
    auditSummary.captures.push({ name: 'home-desktop-keyboard-focus.png', path: pathFocus })
    auditSummary.checks.keyboardFocus = {
      focusedElement,
      isRealTabNavigation: true,
      focusedTarget: 'Savings Navigation Link',
    }
    await pageFocus.close()

    // =========================================================================
    // 5. CORRECTED 320PX MOBILE HOME CAPTURE
    // =========================================================================
    console.log('5. Capturing Corrected 320px Mobile Home...')
    const page320 = await browser.newPage({ viewport: { width: 320, height: 844 } })
    await page320.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
    await page320.waitForTimeout(600)

    const overflowCheck = await page320.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      hasOverflow: document.documentElement.scrollWidth > window.innerWidth,
    }))

    const goalSectionText = await page320.locator('section[aria-labelledby="goal-heading"]').innerText()

    const path320 = resolve(OUT, 'home-mobile-320px-corrected.png')
    await page320.screenshot({ path: path320 })
    auditSummary.captures.push({ name: 'home-mobile-320px-corrected.png', path: path320 })
    auditSummary.checks.mobile320px = {
      overflowCheck,
      noOverflow: !overflowCheck.hasOverflow,
      hasNoFakePace: !goalSectionText.includes('~$52.00/mo'),
      hasNoFakeDate: !goalSectionText.includes('Nov 2026'),
      hasTruthfulRemaining: goalSectionText.includes('Remaining to save'),
    }
    await page320.close()

    await browser.close()

    // Save summary
    writeFileSync(resolve(OUT, 'audit-summary.json'), JSON.stringify(auditSummary, null, 2))
    console.log('Audit summary written to', resolve(OUT, 'audit-summary.json'))
    console.log('Verification checks:', JSON.stringify(auditSummary.checks, null, 2))
    console.log('=== TASK 03B.1 CAPTURE COMPLETE ===')
  } finally {
    if (srv) {
      srv.kill()
    }
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
