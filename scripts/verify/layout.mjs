import { launchChromium } from './browser-runtime.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.SHOT_BASE || 'http://localhost:3111'
const OUT = process.env.SHOT_OUT || './evidence/batch-2/screenshots'
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: '320', width: 320, height: 720 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '900', width: 900, height: 900 },
  { name: '1440', width: 1440, height: 1000 },
  { name: '1920', width: 1920, height: 1080 },
]

const ROUTES = [
  { path: '/', slug: 'landing', shell: false, header: 1, headerSelector: 'header.landing-nav', nav: 0 },
  { path: '/onboarding', slug: 'onboarding', shell: false, header: 1, nav: 0 },
  { path: '/home', slug: 'home', shell: true, header: 1, nav: 2 },
  { path: '/savings', slug: 'savings', shell: true, header: 1, nav: 2 },
  { path: '/savings/new', slug: 'create-goal', shell: true, header: 1, nav: 1 },
  { path: '/activity', slug: 'activity', shell: true, header: 1, nav: 2 },
  { path: '/settings', slug: 'settings', shell: true, header: 1, nav: 2 },
]

const problems = []
const rows = []
let abortedRequests = 0
const browser = await launchChromium()

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 })
  for (const route of ROUTES) {
    const page = await context.newPage()
    const errors = []
    page.on('requestfailed', (request) => {
      const error = request.failure()?.errorText || ''
      if (error.includes('ERR_ABORTED')) abortedRequests += 1
      else errors.push(`request failed: ${error} ${request.url()}`)
    })
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text().split('\n')[0]}`) })
    page.on('pageerror', (error) => errors.push(`page: ${String(error).split('\n')[0]}`))
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`) })

    await page.goto(BASE + route.path, { waitUntil: 'networkidle', timeout: 45000 })
    await page.waitForTimeout(250)
    const metrics = await page.evaluate((headerSelector) => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
      headerCount: document.querySelectorAll(headerSelector).length,
      shellNavCount: document.querySelectorAll('nav[aria-label="Main"], nav[aria-label="Desktop Main"]').length,
      landingNavCount: document.querySelectorAll('nav[aria-label="Primary navigation"]').length,
      h1: Array.from(document.querySelectorAll('h1')).map((heading) => heading.textContent.trim().replace(/\s+/g, ' ')),
      visibleControls: Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role="switch"],[role="radio"]'))
        .filter((element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }).length,
    }), route.headerSelector || 'header')
    if (metrics.scrollWidth > metrics.width + 1) problems.push(`HORIZONTAL OVERFLOW ${viewport.name}px ${route.path}: ${metrics.scrollWidth} > ${metrics.width}`)
    if (metrics.headerCount !== route.header) problems.push(`HEADER COUNT ${viewport.name}px ${route.path}: expected ${route.header}, got ${metrics.headerCount}`)
    const navCount = route.shell ? metrics.shellNavCount : route.path === '/' ? metrics.landingNavCount : 0
    if (navCount !== route.nav && route.path !== '/') problems.push(`NAV COUNT ${viewport.name}px ${route.path}: expected ${route.nav}, got ${navCount}`)
    if (route.path === '/' && metrics.landingNavCount !== 1) problems.push(`LANDING NAV ${viewport.name}px: expected primary navigation`)
    if (metrics.h1.length !== 1) problems.push(`H1 COUNT ${viewport.name}px ${route.path}: expected 1, got ${metrics.h1.length}`)
    if (errors.length) problems.push(`BROWSER ERROR ${viewport.name}px ${route.path}: ${errors[0]}`)

    const screenshot = `${route.slug}-${viewport.name}.png`
    await page.screenshot({ path: `${OUT}/${screenshot}` })
    rows.push({ route: route.path, viewport: `${viewport.width}x${viewport.height}`, screenshot, ...metrics, errors })
    await page.close()
  }
  await context.close()
}
await browser.close()

const report = { base: BASE, routes: ROUTES.map(({ path, slug }) => ({ path, slug })), viewports: VIEWPORTS, rows, problems, abortedRequests }
writeFileSync(`${OUT}/../layout-matrix.json`, JSON.stringify(report, null, 2))
console.log(`Checked ${ROUTES.length} routes x ${VIEWPORTS.length} viewports; ignored aborted prefetches: ${abortedRequests}`)
if (problems.length) {
  console.error('PROBLEMS:')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exitCode = 1
} else {
  console.log('PASS: no horizontal overflow, missing route heading, route chrome mismatch, or browser errors.')
}
console.log(`Screenshots: ${OUT}`)
