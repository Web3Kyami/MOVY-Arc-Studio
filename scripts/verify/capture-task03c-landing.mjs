import { chromium } from 'playwright-core'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const BASE = process.env.MOVY_CAPTURE_BASE || 'http://localhost:3000'
const OUT = resolve(process.cwd(), 'out', 'task03c-landing')
const VIDEO_TMP = resolve(OUT, '.video-temp')
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const FFMPEG_PATH = resolve(process.env.LOCALAPPDATA || '', 'ms-playwright', 'ffmpeg-1011', 'ffmpeg-win64.exe')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
mkdirSync(VIDEO_TMP, { recursive: true })

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})

const report = {
  baseUrl: BASE,
  capturedAt: new Date().toISOString(),
  screenshots: [],
  videos: [],
  audits: [],
  interactions: {},
  reducedMotion: {},
  consoleErrors: [],
}

async function ready(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1050)
}

async function audit(page, label) {
  const result = await page.evaluate(() => {
    const root = document.documentElement
    const offenders = [...document.querySelectorAll('body *')]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > root.clientWidth + 1 || rect.left < -1)
      .slice(0, 20)
      .map(({ element, rect }) => ({
        tag: element.tagName,
        className: typeof element.className === 'string' ? element.className.slice(0, 100) : '',
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      }))

    const targetViolations = [...document.querySelectorAll('button, a, input, [role="button"], [role="switch"]')]
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      })
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName,
          text: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 60),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      })
      .filter(({ width, height }) => width < 44 || height < 44)

    const leafText = [...document.querySelectorAll('body *')]
      .filter((element) => element.children.length === 0)
      .map((element) => element.textContent || '')
      .join(' ')

    return {
      href: location.href,
      title: document.title,
      viewport: { width: root.clientWidth, height: root.clientHeight },
      scrollWidth: root.scrollWidth,
      horizontalOverflow: root.scrollWidth > root.clientWidth,
      overflowOffenders: offenders,
      touchTargetViolations: targetViolations,
      emojiDetected: /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(leafText),
      h1Count: document.querySelectorAll('h1').length,
      mainCount: document.querySelectorAll('main').length,
    }
  })
  report.audits.push({ label, ...result })
  return result
}

async function captureViewport(name, viewport, scrollTop = 0, options = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: options.reducedMotion || 'no-preference' })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push({ name, message: message.text() })
  })
  await ready(page)
  if (scrollTop) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), scrollTop)
    await page.waitForTimeout(950)
  }
  const path = resolve(OUT, `${name}.png`)
  await page.screenshot({ path, fullPage: Boolean(options.fullPage) })
  report.screenshots.push({ name, path, viewport, scrollTop, reducedMotion: options.reducedMotion || 'no-preference' })
  await audit(page, name)
  await context.close()
}

await captureViewport('landing-320-start', { width: 320, height: 700 })
await captureViewport('landing-390-start', { width: 390, height: 844 })
await captureViewport('landing-900-start', { width: 900, height: 1000 })
await captureViewport('landing-1440-start', { width: 1440, height: 900 })
await captureViewport('landing-1920-start', { width: 1920, height: 1080 })

for (const [name, scrollTop] of [
  ['landing-1440-early', 520],
  ['landing-1440-payment', 1250],
  ['landing-1440-roundup-travel', 2350],
  ['landing-1440-goal-transition', 3400],
  ['landing-1440-post-hero', 5200],
]) {
  await captureViewport(name, { width: 1440, height: 900 }, scrollTop)
}

const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
const mobilePage = await mobileContext.newPage()
await ready(mobilePage)
const mobileStoryTop = await mobilePage.locator('.mh-mobile-story').evaluate((element) => element.offsetTop)
for (const [name, offset] of [
  ['landing-390-payment', 30],
  ['landing-390-roundup', 260],
  ['landing-390-goal', 590],
]) {
  await mobilePage.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), mobileStoryTop + offset)
  await mobilePage.waitForTimeout(650)
  const path = resolve(OUT, `${name}.png`)
  await mobilePage.screenshot({ path })
  report.screenshots.push({ name, path, viewport: { width: 390, height: 844 }, scrollTop: mobileStoryTop + offset })
}
await mobileContext.close()

const reducedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const reducedPage = await reducedContext.newPage()
await ready(reducedPage)
const reducedPath = resolve(OUT, 'landing-1440-reduced-motion.png')
await reducedPage.screenshot({ path: reducedPath })
const reducedFacts = await reducedPage.evaluate(() => ({
  mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
  pinSpacers: document.querySelectorAll('.pin-spacer').length,
  scrollHeight: document.documentElement.scrollHeight,
  factsPresent: ['eligible payment', '$3.40', 'merchant receives', '+$0.60 saved', 'emergency cushion']
    .every((fact) => document.body.innerText.toLowerCase().includes(fact)),
  heroHeight: Math.round(document.querySelector('.motion-hero')?.getBoundingClientRect().height || 0),
}))
report.reducedMotion = { path: reducedPath, ...reducedFacts }
report.screenshots.push({ name: 'landing-1440-reduced-motion', path: reducedPath, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
await audit(reducedPage, 'landing-1440-reduced-motion')
await reducedContext.close()

const interactionContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const interactionPage = await interactionContext.newPage()
await ready(interactionPage)
await interactionPage.locator('.lc-presets button', { hasText: '$62.75' }).click()
await interactionPage.waitForTimeout(300)
const resultsText = await interactionPage.locator('.lc-results').innerText()
report.interactions.roundupExample = {
  selected: '$62.75',
  rendered: resultsText,
  pass: resultsText.includes('$62.75') && resultsText.includes('$63.00') && resultsText.includes('+$0.25'),
}

await interactionPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
await interactionPage.keyboard.press('Tab')
const focused = await interactionPage.evaluate(() => {
  const element = document.activeElement
  const style = element ? getComputedStyle(element) : null
  return {
    tag: element?.tagName,
    text: (element?.textContent || '').trim().slice(0, 60),
    outlineWidth: style?.outlineWidth,
    outlineColor: style?.outlineColor,
    boxShadow: style?.boxShadow,
  }
})
report.interactions.keyboardFocus = { ...focused, pass: focused.outlineWidth !== '0px' }

const startPage = await interactionContext.newPage()
await ready(startPage)
await startPage.getByRole('button', { name: 'Start Saving', exact: true }).first().click()
await startPage.waitForTimeout(500)
const onboardingText = await startPage.locator('body').innerText()
report.interactions.startSaving = {
  url: startPage.url(),
  welcomeVisible: /welcome to movy/i.test(onboardingText),
  previewHomeVisible: onboardingText.includes('Total Saved Automatically'),
  pass: /welcome to movy/i.test(onboardingText) && !onboardingText.includes('Total Saved Automatically'),
}
await interactionContext.close()

async function recordScroll(name, viewport, destination, durationMs) {
  const context = await browser.newContext({ viewport, recordVideo: { dir: VIDEO_TMP, size: viewport } })
  const page = await context.newPage()
  await ready(page)
  const video = page.video()
  await page.waitForTimeout(600)
  await page.evaluate(
    ({ destination, durationMs }) => new Promise((resolveDone) => {
      const start = performance.now()
      const tick = (now) => {
        const progress = Math.min(1, (now - start) / durationMs)
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
        window.scrollTo(0, destination * eased)
        if (progress < 1) requestAnimationFrame(tick)
        else resolveDone()
      }
      requestAnimationFrame(tick)
    }),
    { destination, durationMs }
  )
  await page.waitForTimeout(1100)
  await page.close()
  const output = resolve(OUT, `${name}.webm`)
  await video.saveAs(output)
  await context.close()
  report.videos.push({ name, path: output, viewport, bytes: statSync(output).size })
}

await recordScroll('landing-desktop-1440-scroll', { width: 1440, height: 900 }, 5350, 10500)
await recordScroll('landing-mobile-390-scroll', { width: 390, height: 844 }, mobileStoryTop + 760, 6500)

await browser.close()

const videoChecks = report.videos.map((video) => {
  const probe = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', video.path, '-f', 'null', 'NUL'], { encoding: 'utf8' })
  const metadata = `${probe.stdout || ''}\n${probe.stderr || ''}`
  return {
    name: video.name,
    bytes: video.bytes,
    decodes: /Video:/.test(metadata),
    metadata: metadata.split('\n').filter((line) => /Duration:|Video:/.test(line)).join('\n'),
  }
})
report.videoChecks = videoChecks

writeFileSync(resolve(OUT, 'task03c-audit.json'), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(
  resolve(OUT, 'video-verification.txt'),
  videoChecks.map((check) => `${check.name}\nbytes=${check.bytes}\ndecodes=${check.decodes}\n${check.metadata}\n`).join('\n')
)

const failures = []
for (const item of report.audits) {
  if (item.href !== `${BASE}/`) failures.push(`${item.label}: wrong subject ${item.href}`)
  if (item.horizontalOverflow) failures.push(`${item.label}: horizontal overflow`)
  if (item.touchTargetViolations.length) failures.push(`${item.label}: ${item.touchTargetViolations.length} small targets`)
  if (item.emojiDetected) failures.push(`${item.label}: emoji detected`)
  if (item.h1Count !== 1 || item.mainCount !== 1) failures.push(`${item.label}: landmark/heading count`)
}
if (!report.reducedMotion.mediaMatches || report.reducedMotion.pinSpacers !== 0 || !report.reducedMotion.factsPresent) {
  failures.push('reduced motion static story failed')
}
for (const [name, result] of Object.entries(report.interactions)) {
  if (!result.pass) failures.push(`${name} interaction failed`)
}
if (videoChecks.some((video) => !video.decodes)) failures.push('video decode verification failed')
if (report.consoleErrors.length) failures.push(`${report.consoleErrors.length} console errors`)

writeFileSync(
  resolve(OUT, 'verification-summary.txt'),
  `${failures.length ? 'FAIL' : 'PASS'}\n${failures.length ? failures.join('\n') : 'All Task 03C automated evidence gates passed.'}\n`
)

console.log(JSON.stringify({ out: OUT, failures, videos: videoChecks }, null, 2))
process.exitCode = failures.length ? 1 : 0
