import { launchChromium } from './browser-runtime.mjs'

const BASE = process.env.SHOT_BASE || 'http://localhost:3111'
const ROUTES = ['/', '/onboarding', '/home', '/savings', '/savings/new', '/activity', '/settings']
const VIEWPORTS = [
  { name: '320', width: 320, height: 720 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '900', width: 900, height: 900 },
  { name: '1440', width: 1440, height: 1000 },
  { name: '1920', width: 1920, height: 1080 },
]
const problems = []
const browser = await launchChromium()

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
  for (const route of ROUTES) {
    const page = await context.newPage()
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 45000 })
    const controls = await page.evaluate(() => Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role="switch"],[role="radio"]'))
      .filter((element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' })
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const name = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.getAttribute('placeholder') || element.textContent || ''
        const style = getComputedStyle(element)
        return { tag: element.tagName, name: name.trim().replace(/\s+/g, ' ').slice(0, 70), width: Math.round(rect.width), height: Math.round(rect.height), disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true', outline: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow }
      }))
    for (const control of controls) {
      if (!control.name) problems.push(`UNNAMED ${viewport.name}px ${route}: <${control.tag}>`)
      const isPrimaryTapTarget = control.tag === 'BUTTON' || control.tag === 'INPUT' || control.tag === 'SELECT' || control.tag === 'TEXTAREA'
      if (isPrimaryTapTarget && (control.width < 44 || control.height < 44)) problems.push(`SMALL TARGET ${viewport.name}px ${route}: <${control.tag}> ${JSON.stringify(control.name)} ${control.width}x${control.height}`)
    }

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await page.keyboard.press('Tab')
    const firstFocus = await page.evaluate(() => ({
      text: (document.activeElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
      href: document.activeElement instanceof HTMLAnchorElement ? document.activeElement.getAttribute('href') : null,
      visible: document.activeElement instanceof HTMLElement && document.activeElement.matches(':focus-visible'),
    }))
    if (!/skip/i.test(firstFocus.text)) problems.push(`SKIP LINK ${viewport.name}px ${route}: first Tab focused ${JSON.stringify(firstFocus.text)}`)

    const skipTargetId = firstFocus.href?.slice(1)
    await page.keyboard.press('Enter')
    if (skipTargetId) {
      await page.waitForFunction((targetId) => document.activeElement?.id === targetId, skipTargetId, { timeout: 3_000 }).catch(() => {})
      const focusedTarget = await page.evaluate(() => ({
        id: document.activeElement instanceof HTMLElement ? document.activeElement.id : null,
        tag: document.activeElement instanceof HTMLElement ? document.activeElement.tagName : null,
      }))
      if (focusedTarget.id !== skipTargetId) problems.push(`SKIP TARGET FOCUS ${viewport.name}px ${route}: expected #${skipTargetId}, got ${JSON.stringify(focusedTarget)}`)
    } else {
      problems.push(`SKIP TARGET ${viewport.name}px ${route}: focused skip link has no target`)
    }

    let focusStops = 0
    for (let index = 0; index < 14; index += 1) {
      await page.keyboard.press('Tab')
      const state = await page.evaluate(() => {
        const active = document.activeElement
        if (!(active instanceof HTMLElement) || active === document.body) return null
        const style = getComputedStyle(active)
        const visible = active.matches(':focus-visible')
        const indicator = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none'
        return { visible, indicator, text: (active.getAttribute('aria-label') || active.textContent || '').trim().slice(0, 30) }
      })
      if (state) {
        focusStops += 1
        if (!state.visible || !state.indicator) problems.push(`FOCUS INDICATOR ${viewport.name}px ${route}: ${JSON.stringify(state.text)}`)
      }
    }
    if (controls.length > 0 && focusStops < 4) problems.push(`KEYBOARD REACH ${viewport.name}px ${route}: only ${focusStops} focusable controls sampled`)

    const unnamedLandmarks = await page.evaluate(() => Array.from(document.querySelectorAll('nav,main,header,[role="dialog"]'))
      .filter((element) => !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby') && !element.textContent.trim())
      .map((element) => element.tagName))
    if (unnamedLandmarks.length) problems.push(`UNNAMED LANDMARK ${viewport.name}px ${route}: ${unnamedLandmarks.join(',')}`)
    await page.close()
  }
  await context.close()
}
await browser.close()
if (problems.length) {
  console.error(`Found ${problems.length} accessibility problems:`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exitCode = 1
} else {
  console.log(`PASS: ${ROUTES.length} routes x ${VIEWPORTS.length} viewports have named visible controls, 44px control targets, skip navigation, and keyboard focus indicators.`)
}
