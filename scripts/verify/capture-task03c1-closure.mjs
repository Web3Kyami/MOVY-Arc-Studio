import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const base = process.env.MOVY_CAPTURE_BASE || 'http://localhost:3111'
const out = resolve('out/task03c1-closure')
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' })
const report = { checks: {}, errors: [], screenshots: [] }
const failures = []
const selectors = ['.mh-payment', '.mh-split-copy', '.mh-goal-copy', '.mh-roundup-coin']
async function state(page) {
  return page.evaluate((selectors) => ({
    ready: document.querySelector('.motion-hero')?.hasAttribute('data-motion-ready'),
    layers: selectors.map((selector) => ({ selector, opacity: Number(getComputedStyle(document.querySelector(selector)).opacity) })),
    fallback: getComputedStyle(document.querySelector('.motion-hero > ol')).position,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }), selectors)
}
async function shot(page, name, options = {}) {
  await page.screenshot({ path: resolve(out, `${name}.png`), ...options })
  report.screenshots.push(`${name}.png`)
}
// Before hydration: CSS must protect the initial frame even when every script fails.
const blocked = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await blocked.route('**/*.js*', (route) => route.abort())
const blockedPage = await blocked.newPage()
await blockedPage.goto(base, { waitUntil: 'networkidle' })
report.checks.beforeHydration = await state(blockedPage)
await shot(blockedPage, 'desktop-before-hydration')
await blocked.close()

// Record from a new document, before goto/hydration, and sample every rendered frame.
const startup = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: resolve(out, 'raw'), size: { width: 1440, height: 900 } } })
await startup.addInitScript((selectors) => {
  window.__heroFrames = []
  const sample = () => {
    const hero = document.querySelector('.motion-hero')
    if (hero) window.__heroFrames.push({ time: performance.now(), ready: hero.hasAttribute('data-motion-ready'), layers: selectors.map((selector) => Number(getComputedStyle(document.querySelector(selector)).opacity)) })
    if (performance.now() < 4500) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
}, selectors)
const page = await startup.newPage()
page.on('pageerror', (error) => report.errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') report.errors.push(message.text()) })
await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForTimeout(1100)
report.checks.startup = { ...(await state(page)), frames: await page.evaluate(() => window.__heroFrames), pinSpacers: await page.locator('.pin-spacer').count() }
await page.evaluate(() => new Promise((done) => {
  const start = performance.now()
  const tick = (now) => { const t = Math.min((now - start) / 1500, 1); scrollTo(0, 1250 * t); if (t < 1) requestAnimationFrame(tick); else done() }
  requestAnimationFrame(tick)
}))
await page.waitForTimeout(900)
report.checks.paymentBegins = await state(page)
await page.close()
const videoPath = resolve(out, 'desktop-fresh-startup.webm')
await page.video().saveAs(videoPath)
await startup.close()

for (const width of [1440, 390]) {
  const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 } })
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1100)
  await page.locator('.landing-product').scrollIntoViewIfNeeded()
  await page.waitForTimeout(1000)
  await page.evaluate(() => document.activeElement?.blur())
  await shot(page, `landing-${width}-product-reveal`, { fullPage: false })
  // Element screenshots reframe fixed content; exclude the unrelated skip link overlay.
  await page.locator('.landing-product').screenshot({ path: resolve(out, `landing-${width}-product-section.png`), style: '.landing-skip { visibility: hidden !important; }' })
  report.screenshots.push(`landing-${width}-product-section.png`)
  report.checks[`product${width}`] = { text: await page.locator('.landing-product').innerText(), ...(await state(page)) }
  await page.evaluate(() => scrollTo(0, 0))
  await page.waitForTimeout(1100)
  await page.evaluate(() => document.activeElement?.blur())
  await shot(page, `landing-${width}-full-page`, { fullPage: true })
  await page.locator('.lc-presets button', { hasText: '$62.75' }).click()
  report.checks[`calculator${width}`] = await page.locator('.lc-results').innerText()
  await context.close()
}

for (const width of [1440, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  report.checks[`reduced${width}`] = { ...(await state(page)), pinSpacers: await page.locator('.pin-spacer').count(), facts: await page.locator('.motion-hero').innerText() }
  await context.close()
}
const nojs = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false })
const nojsPage = await nojs.newPage()
await nojsPage.goto(base, { waitUntil: 'networkidle' })
report.checks.noJavaScript = { ...(await state(nojsPage)), facts: await nojsPage.locator('.motion-hero > ol').innerText() }
await nojs.close()

const failed = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await failed.addInitScript(() => {
  const original = window.matchMedia.bind(window)
  window.matchMedia = (query) => { if (query === '(min-width: 900px)') throw new Error('Task03C.1 deliberate animation setup failure'); return original(query) }
})
const failedPage = await failed.newPage()
await failedPage.goto(base, { waitUntil: 'networkidle' })
report.checks.setupFailure = { ...(await state(failedPage)), facts: await failedPage.locator('.motion-hero > ol').innerText() }
await failed.close()

const source = readFileSync('src/components/movy/landing/landing-story.tsx', 'utf8')
report.checks.productProvenance = { importsSavingsHero: source.includes("from '@/components/movy/savings-hero'"), importsGoalArtwork: source.includes("from '@/components/movy/goal-artwork'"), components: ['src/components/movy/savings-hero.tsx', 'src/components/movy/goal-artwork.tsx'], case: 'A: existing shared product reveal; unchanged' }
await browser.close()
const ffmpeg = resolve(process.env.LOCALAPPDATA, 'ms-playwright/ffmpeg-1011/ffmpeg-win64.exe')
const decodePath = resolve(out, 'decode-check.webm')
const decode = spawnSync(ffmpeg, ['-y', '-hide_banner', '-i', videoPath, '-c:v', 'libvpx', '-f', 'webm', decodePath], { encoding: 'utf8' })
report.video = { file: 'desktop-fresh-startup.webm', decodes: decode.status === 0, metadata: decode.stderr.split('\n').filter((line) => /Duration:|Video:/.test(line)) }
if (decode.status === 0) unlinkSync(decodePath)
spawnSync(ffmpeg, ['-y', '-ss', '0.12', '-i', videoPath, '-frames:v', '1', '-update', '1', resolve(out, 'startup-120ms.png')])
spawnSync(ffmpeg, ['-y', '-ss', '2', '-i', videoPath, '-frames:v', '1', '-update', '1', resolve(out, 'startup-mid.png')])
for (const key of ['beforeHydration', 'startup']) if (report.checks[key].layers.some((layer) => layer.opacity > 0)) failures.push(`${key}: future layer visible`)
if (!report.checks.startup.frames.length || report.checks.startup.frames.some((frame) => frame.layers.some((opacity) => opacity > 0))) failures.push('startup frame sampling detected future content')
if (!report.checks.startup.ready || report.checks.startup.pinSpacers !== 1) failures.push('animation initialization failed')
if (report.checks.paymentBegins.layers[0].opacity < 0.8) failures.push('payment choreography did not begin')
for (const width of [1440, 390]) {
  const reduced = report.checks[`reduced${width}`]
  if (reduced.pinSpacers || !reduced.facts.includes('+$0.60 saved') || !reduced.facts.includes('Emergency cushion')) failures.push(`reduced${width} incomplete`)
  if (report.checks[`product${width}`].overflow) failures.push(`product${width} overflow`)
  if (!report.checks[`calculator${width}`].includes('+$0.25')) failures.push(`calculator${width} failed`)
}
for (const key of ['noJavaScript', 'setupFailure']) if (report.checks[key].fallback !== 'relative' || !report.checks[key].facts.includes('$0.60')) failures.push(`${key}: fallback unavailable`)
if (report.errors.length || !report.video.decodes) failures.push('browser error or video decode failure')
report.failures = failures
writeFileSync(resolve(out, 'task03c1-audit.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ out, failures, video: report.video }, null, 2))
process.exitCode = failures.length ? 1 : 0
