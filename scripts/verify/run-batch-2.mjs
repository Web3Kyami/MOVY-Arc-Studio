import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium } from './browser-runtime.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = resolve(process.env.EVIDENCE_OUT || 'artifacts/browser-verification')
const buildPath = join(repoRoot, '.next/BUILD_ID')
const requestedPort = Number(process.env.MOVY_BROWSER_PORT || 0)
const requestedDemoPort = Number(process.env.MOVY_DEMO_BROWSER_PORT || 0)
// Next normalizes loopback URLs to `localhost` inside proxy requests. Keep
// browser URLs and the exact origin allowlist on that same canonical origin.
const host = 'localhost'
const startupTimeoutMs = 90_000
const suiteTimeoutMs = 8 * 60_000
const definitions = [
  { name: 'premium-phase2', command: 'scripts/verify/premium-phase2.mjs' },
  { name: 'premium-settings', command: 'scripts/verify/premium-settings.mjs' },
  { name: 'premium-profile-isolation', command: 'scripts/verify/premium-profile-isolation.mjs' },
  { name: 'layout', command: 'scripts/verify/layout.mjs' },
  { name: 'phase3-onboarding', command: 'scripts/verify/phase3-onboarding.mjs' },
  { name: 'accessibility', command: 'scripts/verify/accessibility.mjs' },
  { name: 'journey-preview', command: 'scripts/verify/batch-2-journey.mjs' },
  { name: 'onboarding-wallet-retry-and-failure', command: 'scripts/verify/batch-2-onboarding-race.mjs' },
  { name: 'clipboard-fallback', command: 'scripts/verify/batch-2-clipboard-fallback.mjs' },
  { name: 'testnet-only', command: 'scripts/verify/testnet-only.mjs' },
  { name: 'dialog-focus', command: 'scripts/verify/batch-2-dialog-focus.mjs' },
  { name: 'settings-dialogs', command: 'scripts/verify/batch-2-settings-dialogs.mjs' },
  { name: 'activity-dialog', command: 'scripts/verify/batch-2-activity-dialog.mjs' },
  { name: 'withdrawal-sheet', command: 'scripts/verify/batch-2-withdraw-sheet.mjs' },
  { name: 'withdrawal-sheet-component', command: 'scripts/test-mobile-withdraw-sheet.mjs', runner: 'tsx' },
  { name: 'payment-and-component-states', command: 'scripts/test-batch-2-component-states.mjs', runner: 'tsx' },
  { name: 'product-truth-and-preview-isolation', command: 'scripts/verify/batch-2-product-truth.mjs' },
  { name: 'demo-origin-boundary', command: 'scripts/verify/demo-origin-boundary.mjs' },
  { name: 'savings-number-reveal', command: 'scripts/test-savings-number-reveal.mjs', runner: 'tsx' },
]

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commitSha: await gitHead(),
  productionBuildRequired: true,
  productionServer: { started: false, url: null },
  browser: {
    engine: 'Chromium',
    playwrightCoreVersion: JSON.parse(await readFile(join(repoRoot, 'node_modules/playwright-core/package.json'))).version,
    launched: false,
    version: null,
    launchError: null,
  },
  coverage: {
    routes: ['/', '/onboarding', '/home', '/savings', '/savings/new', '/activity', '/settings'],
    viewportWidths: [320, 390, 768, 900, 1440, 1920],
    routeViewportCases: 42,
    demoOriginCases: ['landing-explore-demo-entry', 'wallet-free-demo-seed', 'demo-profile-and-goals-persistence', 'example-only-receipt'],
    connectedWalletMockCases: ['start-saving-connected-onboarding-to-review', 'cancel-and-retry-onboarding-wallet', 'delayed-onboarding-rpc'],
    walletFailureCases: ['connection-canceled', 'wrong-network'],
    recoveryCases: ['withdrawal-receipt-retry'],
    usesLiveWallet: false,
    sendsLiveTransactions: false,
  },
  checks: [],
  artifacts: [],
  demoServer: { started: false, url: null },
  demoCoverage: {
    routes: ['/home', '/savings', '/savings/new', '/activity', '/settings', '/settings/profile'],
    viewportWidths: [320, 390, 768, 900, 1440, 1920],
    routeViewportCases: 36,
  },
  allPassed: false,
}

await mkdir(evidenceRoot, { recursive: true })
await writeReport()

if (!existsSync(buildPath)) {
  report.checks.push({
    name: 'production-build-present',
    passed: false,
    exitCode: 1,
    durationMs: 0,
    log: null,
    summary: 'Run npm run build before starting the production browser verification suite.',
  })
  await finish()
  process.exit(1)
}

const port = requestedPort > 0 ? requestedPort : await reservePort()
let demoPort = requestedDemoPort > 0 ? requestedDemoPort : await reservePort()
if (demoPort === port && requestedDemoPort > 0) throw new Error('MOVY_BROWSER_PORT and MOVY_DEMO_BROWSER_PORT must be different')
while (demoPort === port) demoPort = await reservePort()
report.productionServer.url = `http://${host}:${port}`
report.demoServer.url = `http://${host}:${demoPort}`
const productOrigin = report.productionServer.url
const demoOrigin = report.demoServer.url
const serverEnv = {
  ...process.env,
  MOVY_PRODUCT_ORIGINS: productOrigin,
  MOVY_DEMO_ORIGINS: demoOrigin,
  MOVY_DEMO_ENTRY_ORIGIN: demoOrigin,
  MOVY_BROWSER_TEST_FIXTURES: 'true',
}
const serverLogPath = join(evidenceRoot, 'production-server.log')
const demoServerLogPath = join(evidenceRoot, 'demo-server.log')
const serverLog = createWriteStream(serverLogPath)
const demoServerLog = createWriteStream(demoServerLogPath)
function startServer(serverPort, output) {
  const child = spawn(process.execPath, [
    join(repoRoot, 'node_modules/next/dist/bin/next'),
    'start',
    '--hostname', host,
    '--port', String(serverPort),
  ], { cwd: repoRoot, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(output)
  child.stderr.pipe(output)
  return child
}
const server = startServer(port, serverLog)
const demoServer = startServer(demoPort, demoServerLog)

const serverStarted = await waitForServer(server, report.productionServer.url, startupTimeoutMs)
report.productionServer.started = serverStarted
const demoServerStarted = await waitForServer(demoServer, report.demoServer.url, startupTimeoutMs)
report.demoServer.started = demoServerStarted
if (!serverStarted) {
  report.checks.push({
    name: 'production-server-start',
    passed: false,
    exitCode: 1,
    durationMs: startupTimeoutMs,
    log: relative(evidenceRoot, serverLogPath),
    summary: 'Next.js production server failed to become ready; see production-server.log.',
  })
  await stopServer(server)
  await stopServer(demoServer)
  serverLog.end()
  demoServerLog.end()
  await finish()
  process.exit(1)
}
if (!demoServerStarted) {
  report.checks.push({
    name: 'demo-server-start',
    passed: false,
    exitCode: 1,
    durationMs: startupTimeoutMs,
    log: relative(evidenceRoot, demoServerLogPath),
    summary: 'The isolated Demo origin failed to start; see demo-server.log.',
  })
  await stopServer(server)
  await stopServer(demoServer)
  serverLog.end()
  demoServerLog.end()
  await finish()
  process.exit(1)
}

try {
  const browser = await launchChromium()
  report.browser.launched = true
  report.browser.version = browser.version()
  await browser.close()
} catch (error) {
  report.browser.launchError = String(error)
}

for (const definition of definitions) {
  const checkRoot = join(evidenceRoot, definition.name)
  await mkdir(checkRoot, { recursive: true })
  const logPath = join(checkRoot, 'check.log')
  const args = definition.runner === 'tsx'
    ? ['--import', 'tsx', definition.command]
    : [definition.command]
  const env = {
    ...process.env,
    SHOT_BASE: report.productionServer.url,
    DEMO_SHOT_BASE: report.demoServer.url,
    EVIDENCE_OUT: checkRoot,
  }
  if (definition.name === 'layout') env.SHOT_OUT = join(checkRoot, 'screenshots')
  const startedAt = Date.now()
  const outcome = await runProcess(process.execPath, args, {
    cwd: repoRoot,
    env,
    logPath,
    timeoutMs: suiteTimeoutMs,
  })
  report.checks.push({
    name: definition.name,
    passed: outcome.exitCode === 0 && !outcome.signal,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    durationMs: Date.now() - startedAt,
    log: relative(evidenceRoot, logPath),
    summary: outcome.summary,
  })
  await writeReport()
}

await stopServer(server)
await stopServer(demoServer)
serverLog.end()
demoServerLog.end()
await finish()

async function gitHead() {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write(require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())"], {
    cwd: repoRoot,
    env: process.env,
  })
  return result.stdout?.trim() || null
}

async function reservePort() {
  return new Promise((resolvePort, reject) => {
    const listener = createServer()
    listener.once('error', reject)
    listener.listen(0, host, () => {
      const address = listener.address()
      listener.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function waitForServer(child, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return true
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  return false
}

async function runProcess(command, args, options) {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = []
    let timedOut = false
    let killTimer
    const log = options.logPath ? createWriteStream(options.logPath) : null
    const collect = (stream, label) => stream.on('data', (chunk) => {
      const content = chunk.toString()
      output.push(`${label}${content}`)
      if (log) log.write(`${label}${content}`)
    })
    if (child.stdout) collect(child.stdout, '')
    if (child.stderr) collect(child.stderr, '[stderr] ')
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      }, options.timeoutMs)
      : null
    child.once('error', (error) => output.push(`\n[runner error] ${String(error)}`))
    child.once('close', (exitCode, signal) => {
      if (timeout) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      log?.end()
      const combined = output.join('')
      resolveProcess({
        exitCode,
        signal,
        timedOut,
        stdout: combined,
        summary: combined.trim().split('\n').filter(Boolean).slice(-4).join('\n').slice(-900),
      })
    })
  })
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveStop) => child.once('close', resolveStop)),
    new Promise((resolveStop) => setTimeout(resolveStop, 5_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function writeReport() {
  report.generatedAt = new Date().toISOString()
  report.allPassed = report.checks.length === definitions.length
    && report.checks.every((check) => check.passed)
    && report.productionServer.started
    && report.demoServer.started
    && report.browser.launched
  report.artifacts = await listArtifacts(evidenceRoot)
  await writeFile(join(evidenceRoot, 'browser-results.json'), `${JSON.stringify(report, null, 2)}\n`)
}

async function listArtifacts(directory) {
  const files = []
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name !== 'browser-results.json') files.push(relative(evidenceRoot, path))
    }
  }
  await visit(directory)
  return files.sort()
}

async function finish() {
  await writeReport()
  console.log(`Browser verification report: ${join(evidenceRoot, 'browser-results.json')}`)
  console.log(`Checks passed: ${report.checks.filter((check) => check.passed).length}/${report.checks.length}`)
  console.log(`Evidence files: ${report.artifacts.length}`)
  if (!report.allPassed) process.exitCode = 1
}
