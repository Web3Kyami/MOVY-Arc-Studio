import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchChromium } from './browser-runtime.mjs'

const PRODUCT = process.env.SHOT_BASE || 'http://localhost:3111'
const DEMO = process.env.DEMO_SHOT_BASE || 'http://localhost:3112'
const OUT = process.env.EVIDENCE_OUT || 'artifacts/premium-settings'
mkdirSync(OUT, { recursive: true })
const browser = await launchChromium()
const results = []
const widths = [320, 390, 768, 900, 1440, 1920]

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(document.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

try {
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`${DEMO}/settings`, { waitUntil: 'networkidle' })
    await settle(page)
    assert.equal(await page.locator('.consumer-demo:visible').count(), 1, 'Each Demo page has one discreet Demo indicator')
    const settingsCopy = await page.locator('#main').innerText()
    assert.doesNotMatch(settingsCopy, /Preview|Simulated|Testnet|Mainnet|RPC|blockchain|contract/i)
    assert.equal(await page.getByRole('button', { name: 'Connect wallet' }).count(), 0, 'Demo has no wallet entry point')
    assert.equal(await page.getByRole('button', { name: 'Revoke Automatic Enrollment' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /Daily savings limit/ }).count(), 0, 'Demo savings controls are examples only')
    assert.equal(await page.getByRole('switch').count(), 0, 'Demo settings cannot change a financial control')
    if (width >= 768) {
      assert.equal(await page.locator('.consumer-identity').innerText(), 'Alex')
      assert.equal(await page.locator('.consumer-identity').getAttribute('href'), '/settings/profile')
      assert.equal(await page.locator('.consumer-identity').innerText().then(text => /edit profile/i.test(text)), false,
        'Desktop profile identity shows only the name alongside the avatar')
    }
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
    assert.equal(geometry.viewport, width)
    assert.ok(geometry.document <= width + 1, `Settings overflows at ${width}px`)
    if (width === 1440) {
      const canvas = await page.locator('.consumer-canvas').boundingBox()
      assert.equal(canvas.width, 520)
      assert.equal(canvas.x, (width - canvas.width) / 2)
    }
    await page.screenshot({ path: `${OUT}/settings-${width}.png` })
    await page.getByRole('link', { name: 'Edit profile', exact: true }).click()
    await page.getByRole('heading', { name: 'Edit profile' }).waitFor()
    await settle(page)
    assert.equal(await page.locator('.consumer-demo:visible').count(), 1)
    await page.screenshot({ path: `${OUT}/settings-profile-${width}.png` })
    assert.deepEqual(errors, [])
    await context.close()
    results.push({ width, responsive: true, oneDemoIndicator: true, settingsReadOnly: true, profileAccessible: true })
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    window.__cameraRequests = 0
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { window.__cameraRequests++; throw new DOMException('Denied', 'NotAllowedError') },
    })
  })
  const page = await context.newPage()
  await page.goto(`${DEMO}/settings/profile`, { waitUntil: 'networkidle' })
  assert.equal(await page.evaluate(() => window.__cameraRequests), 0, 'Camera permission is not requested on page load')
  await page.getByRole('button', { name: 'Take photo', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Camera access is unavailable' }).waitFor()
  assert.equal(await page.evaluate(() => window.__cameraRequests), 1)
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Amina Okafor')
  await page.getByRole('button', { name: 'Choose an avatar', exact: true }).click()
  await page.getByRole('radio', { name: 'Sand avatar' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL('**/settings')
  await page.locator('.profile-summary strong').waitFor()
  assert.equal(await page.locator('.profile-summary strong').innerText(), 'Amina Okafor')
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.locator('.profile-summary strong').innerText(), 'Amina Okafor')
  await page.goto(`${DEMO}/settings/profile`, { waitUntil: 'networkidle' })
  assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Amina Okafor')
  await page.getByLabel('Upload photo').setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg />') })
  await page.getByRole('alert').filter({ hasText: 'Choose a JPEG' }).waitFor()
  await page.getByLabel('Upload photo').setInputFiles('public/avatars/alex.png')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL('**/settings')
  const storedPhoto = await page.evaluate(() => JSON.parse(localStorage.getItem('movy:profile:v1:demo')).photo)
  assert.match(storedPhoto, /^data:image\/jpeg;base64,/)
  assert.ok(storedPhoto.length < 500_000)
  await page.goto(`${DEMO}/home`, { waitUntil: 'networkidle' })
  assert.equal(await page.locator('.consumer-sidebar img.profile-avatar').count(), 1)
  assert.equal(await page.locator('.home-greeting strong').innerText(), 'Amina Okafor',
    'Name change is reflected in the Home greeting')
  assert.ok(await page.locator('img[src^="data:image/jpeg"]').count(), 'Uploaded avatar is reflected on Home')
  await page.goto(`${DEMO}/settings/profile`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Remove photo' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL('**/settings')
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('movy:profile:v1:demo')).photo), null)
  await context.close()
  results.push({ namePersistence: true, avatarSelection: true, photoUploadAndRemoval: true, cameraDenied: true })

  const cameraContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  await cameraContext.addInitScript(() => {
    window.__cameraStops = 0
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      canvas.getContext('2d').fillRect(0, 0, 64, 64)
      const stream = canvas.captureStream(10)
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track)
        track.stop = () => { window.__cameraStops++; stop() }
      }
      return stream
    }
  })
  const cameraPage = await cameraContext.newPage()
  await cameraPage.goto(`${DEMO}/settings/profile`, { waitUntil: 'networkidle' })
  await cameraPage.getByRole('button', { name: 'Take photo', exact: true }).click()
  await cameraPage.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
  await cameraPage.getByRole('button', { name: 'Capture photo', exact: true }).click()
  await cameraPage.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await cameraPage.evaluate(() => window.__cameraStops), 1, 'Capturing a photo stops its camera track')
  await cameraPage.getByRole('button', { name: 'Save', exact: true }).click()
  await cameraPage.waitForURL('**/settings')
  assert.match(await cameraPage.evaluate(() => JSON.parse(localStorage.getItem('movy:profile:v1:demo')).photo), /^data:image\/jpeg;base64,/)
  await cameraContext.close()
  results.push({ cameraCapture: true, cameraTrackStopped: true })

  const presetContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const presetPage = await presetContext.newPage()
  await presetPage.goto(`${PRODUCT}/settings?fixture=connected-active`, { waitUntil: 'networkidle' })
  const limitRow = presetPage.getByRole('button', { name: /Daily savings limit/ })
  await limitRow.click()
  const limitDialog = presetPage.getByRole('dialog', { name: 'Daily savings limit' })
  await limitDialog.waitFor()
  const tenDollarPreset = limitDialog.getByRole('button', { name: '$10.00', exact: true })
  await tenDollarPreset.click()
  await settle(presetPage)
  assert.equal(await presetPage.getByRole('textbox', { name: 'Daily savings limit' }).inputValue(), '10.00')
  assert.equal(await tenDollarPreset.getAttribute('aria-pressed'), 'true', 'The selected preset exposes its actual state')
  assert.equal(await limitDialog.getByRole('button', { name: '$5.00', exact: true }).getAttribute('aria-pressed'), 'false')
  await presetPage.screenshot({ path: `${OUT}/limit-preset-10.png` })
  await presetContext.close()
  results.push({ limitPresetStateMatchesAmount: true })

  const demoIsolation = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await demoIsolation.addInitScript(() => {
    localStorage.setItem('movy_demo_mode_active', 'false')
    localStorage.setItem('movy_test_fixture', 'connected-active')
  })
  const isolatedDemo = await demoIsolation.newPage()
  await isolatedDemo.goto(`${DEMO}/home?fixture=connected-active&mode=connected`, { waitUntil: 'networkidle' })
  assert.equal(await isolatedDemo.locator('.consumer-demo:visible').count(), 1, 'Demo cannot be switched off by storage or query parameters')
  assert.equal(await isolatedDemo.getByText('Verification Fixture', { exact: true }).count(), 0, 'Product test fixtures are unavailable on Demo')
  assert.doesNotMatch(await isolatedDemo.locator('#main').innerText(), /Connect wallet|0x[0-9a-f]{8}/i)
  await demoIsolation.close()
  const productIsolation = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await productIsolation.addInitScript(() => {
    localStorage.setItem('movy_demo_mode_active', 'true')
    localStorage.setItem('movy:profile:v1:demo', JSON.stringify({ name: 'Demo-only name', avatar: 'sage', photo: null }))
  })
  const productPage = await productIsolation.newPage()
  await productPage.goto(`${PRODUCT}/settings`, { waitUntil: 'networkidle' })
  assert.equal(await productPage.locator('.consumer-demo:visible').count(), 0, 'Local storage cannot enable Demo on the product origin')
  assert.doesNotMatch(await productPage.locator('#main').innerText(), /Demo-only name/)
  await productIsolation.close()

  writeFileSync(`${OUT}/results.json`, JSON.stringify({ browser: browser.version(), results, allPassed: true }, null, 2))
  console.log('PASS: isolated Demo settings/profile, fixed example data, profile persistence, and responsive savings-limit preset state')
} finally {
  await browser.close()
}
