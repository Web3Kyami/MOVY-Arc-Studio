import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { chromium } from 'playwright-core'

const BASE = process.env.MOVY_CAPTURE_BASE || 'http://localhost:3118'
const OUT = resolve(process.env.MOVY_CAPTURE_OUT || 'out/task03c4')
const PUBLIC_ART = resolve('public/artwork')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const widths = [
  { width: 320, height: 568, mobile: true },
  { width: 390, height: 844, mobile: true },
  { width: 900, height: 900, mobile: false },
  { width: 1440, height: 900, mobile: false },
  { width: 1920, height: 1080, mobile: false },
]

for (const directory of ['screenshots', 'videos', 'audit', 'source']) {
  mkdirSync(resolve(OUT, directory), { recursive: true })
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const report = {
  base: BASE,
  sourceRoute: '/home',
  sourceMode: 'Preview Demo Mode, fresh isolated browser contexts with seeded defaults',
  captures: [],
  reducedMotion: null,
  noJavaScript: null,
  accessibility: null,
  keyboard: null,
  entryHandoff: null,
  video: null,
  errors: [],
}

function clearPreviewState(context) {
  context.addInitScript(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
}

async function observeErrors(page) {
  page.on('pageerror', (error) => report.errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push(message.text())
  })
}

async function openPreviewHome(width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: width < 600,
    hasTouch: width < 600,
  })
  clearPreviewState(context)
  const page = await context.newPage()
  await observeErrors(page)
  await page.goto(`${BASE}/home`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'ACTIVE GOAL' }).waitFor({ timeout: 15000 })
  const body = await page.locator('body').innerText()
  assert.match(body, /Preview/i)
  assert.match(body, /\$355\.00/)
  assert.match(body, /Emergency Cushion/)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(350)
  const png = resolve(OUT, 'source', `home-preview-${width}.png`)
  await page.screenshot({ path: png, animations: 'disabled' })
  const webp = resolve(PUBLIC_ART, `movy-home-preview-${width}.webp`)
  await sharp(png).webp({ quality: 88, effort: 6 }).toFile(webp)
  const image = await sharp(webp).metadata()
  await context.close()
  return { width, height, png, asset: webp, image: { width: image.width, height: image.height } }
}

const screenAssets = []
for (const [width, height] of [[320, 568], [390, 844]]) {
  screenAssets.push(await openPreviewHome(width, height))
}

if (process.env.MOVY_CAPTURE_ASSETS_ONLY === '1') {
  console.log(JSON.stringify({ screenAssets }, null, 2))
  await browser.close()
  process.exit(0)
}

for (const viewport of widths) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  })
  clearPreviewState(context)
  const page = await context.newPage()
  await observeErrors(page)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const section = page.locator('[data-section="04"]')
  await section.waitFor({ state: 'attached', timeout: 15000 })
  await page.evaluate(() => document.fonts.ready)
  const sectionTop = await section.evaluate((element) => element.getBoundingClientRect().top + scrollY)
  await page.evaluate((top) => scrollTo(0, top), sectionTop)
  await page.waitForTimeout(850)
  const initial = await section.evaluate((element) => {
    const image = element.querySelector('img')
    const imageRect = image?.getBoundingClientRect()
    const deviceRect = element.querySelector('figure')?.getBoundingClientRect()
    return {
      text: element.innerText,
      imageAlt: image?.alt || '',
      imageLoaded: Boolean(image?.complete && image.naturalWidth > 0),
      imageNaturalWidth: image?.naturalWidth || 0,
      imageBounds: imageRect && { x: imageRect.x, y: imageRect.y, width: imageRect.width, height: imageRect.height },
      deviceBounds: deviceRect && { x: deviceRect.x, y: deviceRect.y, width: deviceRect.width, height: deviceRect.height },
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
    }
  })
  assert(initial.imageLoaded, `Preview image did not load at ${viewport.width}px`)
  assert(initial.imageAlt.includes('Preview'))
  const overflow = initial.documentWidth > viewport.width
  const screenshot = resolve(OUT, 'screenshots', `section04-${viewport.width}.png`)
  await page.screenshot({ path: screenshot, animations: 'disabled' })

  await page.evaluate(() => {
    const image = document.querySelector('[data-section="04"] img')
    if (image) scrollTo(0, image.getBoundingClientRect().top + scrollY - 72)
  })
  await page.waitForTimeout(250)
  const productView = resolve(OUT, 'screenshots', `section04-product-${viewport.width}.png`)
  await page.screenshot({ path: productView, animations: 'disabled' })

  report.captures.push({ ...viewport, overflow, screenshot, productView, ...initial })
  assert.equal(overflow, false, `Horizontal overflow at ${viewport.width}px`)
  await context.close()
}

{
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  })
  clearPreviewState(context)
  const page = await context.newPage()
  await observeErrors(page)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const section = page.locator('[data-section="04"]')
  await section.waitFor({ state: 'attached' })
  const top = await section.evaluate((element) => element.getBoundingClientRect().top + scrollY)
  await page.evaluate((position) => scrollTo(0, position), top)
  await page.waitForTimeout(250)
  report.reducedMotion = await section.evaluate((element) => ({
    preference: matchMedia('(prefers-reduced-motion: reduce)').matches,
    textPresent: /Your savings, in clear view\./.test(element.innerText),
    imageVisible: getComputedStyle(element.querySelector('img')).visibility !== 'hidden',
    transform: getComputedStyle(element.querySelector('figure')).transform,
  }))
  assert(report.reducedMotion.preference && report.reducedMotion.textPresent && report.reducedMotion.imageVisible)
  await page.screenshot({ path: resolve(OUT, 'screenshots', 'section04-reduced-motion.png'), animations: 'disabled' })
  await context.close()
}

{
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    javaScriptEnabled: false,
  })
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const section = page.locator('[data-section="04"]')
  await section.waitFor({ state: 'attached' })
  report.noJavaScript = await section.evaluate((element) => ({
    textPresent: /Your savings, in clear view\./.test(element.innerText),
    imageAlt: element.querySelector('img')?.alt || '',
    imageVisible: getComputedStyle(element.querySelector('img')).visibility !== 'hidden',
  }))
  assert(report.noJavaScript.textPresent && report.noJavaScript.imageAlt.includes('Preview') && report.noJavaScript.imageVisible)
  await context.close()
}

{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  clearPreviewState(context)
  const page = await context.newPage()
  await observeErrors(page)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const section = page.locator('[data-section="04"]')
  await section.waitFor({ state: 'attached' })
  await page.addScriptTag({ path: resolve('node_modules/axe-core/axe.min.js') })
  const axe = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector('[data-section="04"]'), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    })
    return {
      violations: result.violations.map((item) => ({ id: item.id, impact: item.impact, description: item.description, nodes: item.nodes.length })),
      incomplete: result.incomplete.map((item) => ({ id: item.id, nodes: item.nodes.length })),
    }
  })
  report.accessibility = axe
  assert.equal(axe.violations.length, 0, `Axe issues: ${JSON.stringify(axe.violations)}`)
  const cta = section.getByRole('button', { name: 'Explore Demo' })
  await cta.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  report.keyboard = await cta.evaluate((element) => ({
    focused: document.activeElement === element,
    focusVisible: element.matches(':focus-visible'),
    outline: getComputedStyle(element).outline,
  }))
  assert(report.keyboard.focused && report.keyboard.focusVisible)
  await context.close()
}

{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  clearPreviewState(context)
  const page = await context.newPage()
  await observeErrors(page)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const cta = page.locator('[data-section="04"]').getByRole('button', { name: 'Explore Demo' })
  await Promise.all([page.waitForURL('**/home'), cta.click()])
  const body = await page.locator('body').innerText()
  report.entryHandoff = {
    path: new URL(page.url()).pathname,
    previewLabelPresent: /Preview Demo Mode|Preview · Simulated/.test(body),
    seededHomePresent: /\$355\.00/.test(body) && /Emergency Cushion/.test(body),
  }
  assert.equal(report.entryHandoff.path, '/home')
  assert(report.entryHandoff.previewLabelPresent && report.entryHandoff.seededHomePresent)
  await context.close()
}

{
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: resolve(OUT, 'videos'), size: { width: 1440, height: 900 } },
  })
  clearPreviewState(context)
  const page = await context.newPage()
  await observeErrors(page)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const section = page.locator('[data-section="04"]')
  await section.waitFor({ state: 'attached' })
  const top = await section.evaluate((element) => element.getBoundingClientRect().top + scrollY)
  await page.evaluate((position) => scrollTo(0, position - 850), top)
  await page.waitForTimeout(250)
  for (let step = 0; step < 18; step += 1) {
    await page.mouse.wheel(0, 50)
    await page.waitForTimeout(65)
  }
  await page.waitForTimeout(750)
  const video = page.video()
  await context.close()
  const path = resolve(OUT, 'videos', 'section04-desktop-reveal.webm')
  await video.saveAs(path)
  report.video = {
    path,
    viewport: { width: 1440, height: 900 },
    scroll: { initialOffsetPx: -850, wheelSteps: 18, deltaPx: 50, intervalMs: 65, settleMs: 750 },
  }
}

writeFileSync(resolve(OUT, 'audit', 'browser-report.json'), JSON.stringify({ ...report, screenAssets }, null, 2))
assert.equal(report.errors.length, 0, `Browser errors: ${report.errors.join(' | ')}`)
console.log(JSON.stringify({
  screenAssets,
  viewports: report.captures.map(({ width, overflow, screenshot, productView }) => ({ width, overflow, screenshot, productView })),
  reducedMotion: report.reducedMotion,
  noJavaScript: report.noJavaScript,
  axeViolations: report.accessibility?.violations.length,
  keyboard: report.keyboard,
  entryHandoff: report.entryHandoff,
  video: report.video,
  errors: report.errors,
}, null, 2))
await browser.close()
