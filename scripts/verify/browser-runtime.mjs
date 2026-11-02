import { chromium } from 'playwright-core'

export async function launchChromium(options = {}) {
  try {
    return await chromium.launch({ ...options, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ['--no-sandbox', ...(options.args ?? [])] })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Playwright-managed Chromium could not launch. Run "npx playwright-core install chromium" first. ${message}`, { cause })
  }
}
