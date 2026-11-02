/**
 * Product-origin connected-wallet audit using real read-only Arc Testnet RPC.
 *
 * The injected EIP-1193 provider has no private key. Wallet prompts are rejected
 * locally, and browser JSON-RPC writes are blocked before reaching the network.
 * No Demo origin or fixture data is loaded by this test.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { decodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { isReadOnlyRpcMethod, READ_ONLY_RPC_METHODS } from './connected-rpc-policy.mjs'

const BASE = process.env.MOVY_CONNECTED_BASE || 'http://127.0.0.1:3000'
const RPC = process.env.ARC_READ_RPC_URL || 'https://rpc.testnet.arc.io'
const OUT = process.env.MOVY_CONNECTED_EVIDENCE || 'docs/audit/evidence/connected-readonly'
const AUTO_SAVER = '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d'
const KNOWN_UNSAFE_AUTO_SAVER = '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d'
const LEGACY_SAVINGS = '0xfc0a597c532173327350a3850d223e1f4ec5ff73'
const USDC = '0x3600000000000000000000000000000000000000'
assert.notEqual(process.env.MOVY_WORKER_ENABLED, 'true', 'connected certification requires the financial worker disabled')
assert.notEqual(process.env.MOVY_RELAYER_ENABLED, 'true', 'connected certification requires transaction broadcasting disabled')
// Both wallet identities are generated in memory, unfunded, and never used to
// sign. This avoids a known burn address or public development key affecting
// the Testnet call simulation.
const ACCOUNT = privateKeyToAccount(generatePrivateKey()).address
const ALT_ACCOUNT = privateKeyToAccount(generatePrivateKey()).address

const rpcUrl = new URL(RPC)
assert.equal(rpcUrl.protocol, 'https:', 'Testnet RPC must use HTTPS')
assert.equal(rpcUrl.username, '', 'RPC URL must not embed credentials')
assert.equal(rpcUrl.password, '', 'RPC URL must not embed credentials')
mkdirSync(OUT, { recursive: true })

let rpcId = 0
const RPC_MIN_SPACING_MS = 250
const rpcReadCache = new Map()
let rpcQueue = Promise.resolve()
let lastRpcStartedAt = 0
let rpcCacheHits = 0
const execFileAsync = promisify(execFile)
const { stdout: commitSha } = await execFileAsync('git', ['rev-parse', 'HEAD'])
async function readRpc(method, params = []) {
  assert(isReadOnlyRpcMethod(method), `refusing non-read-only RPC method ${method}`)
  const cacheable = method === 'eth_getLogs' || method === 'eth_getCode'
  const cacheKey = cacheable ? JSON.stringify({ method, params }) : null
  if (cacheKey && rpcReadCache.has(cacheKey)) {
    rpcCacheHits += 1
    return rpcReadCache.get(cacheKey)
  }
  const task = rpcQueue.then(async () => {
    const waitMs = RPC_MIN_SPACING_MS - (Date.now() - lastRpcStartedAt)
    if (lastRpcStartedAt && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    lastRpcStartedAt = Date.now()
    const payload = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
    // curl uses the workspace's configured outbound proxy. Keep read-only calls
    // serial and bounded to respect the public RPC's rate limits. Exact repeated
    // code/log reads are cached only after a successful live response.
    const { stdout } = await execFileAsync('curl', [
      '--silent', '--show-error', '--fail', '--max-time', '15',
      '--retry', '2', '--retry-all-errors', '--retry-delay', '1', '--retry-max-time', '8',
      '-H', 'content-type: application/json', '--data-binary', payload, RPC,
    ], { maxBuffer: 2 * 1024 * 1024 })
    const body = JSON.parse(stdout)
    assert(
      !body.error,
      `${method} RPC error: ${body.error?.message || 'unknown'}; detail=${JSON.stringify(body.error)}; params=${JSON.stringify(params)}`,
    )
    if (cacheKey) rpcReadCache.set(cacheKey, body.result)
    return body.result
  })
  rpcQueue = task.then(() => undefined, () => undefined)
  return task
}

const chainIdHex = await readRpc('eth_chainId')
assert.equal(BigInt(chainIdHex), 5_042_002n, 'configured RPC must be Arc Testnet')
const latestBlock = await readRpc('eth_getBlockByNumber', ['latest', false])
const blockNumberHex = latestBlock.number
const deploymentManifest = JSON.parse(readFileSync('contracts/deployed-testnet.json', 'utf8'))
assert.equal(deploymentManifest.network, 'testnet', 'deployment manifest must identify Testnet')
assert.equal(deploymentManifest.chainId, 5_042_002, 'deployment manifest must identify Arc Testnet')
assert.equal(deploymentManifest.contractAddress.toLowerCase(), AUTO_SAVER.toLowerCase(), 'runtime AutoSaver must match the deployment manifest')
assert.equal(deploymentManifest.usdcAddress.toLowerCase(), USDC.toLowerCase(), 'deployment manifest must use canonical Testnet USDC')
const autoSaverCode = await readRpc('eth_getCode', [AUTO_SAVER, 'latest'])
const legacySavingsCode = await readRpc('eth_getCode', [LEGACY_SAVINGS, 'latest'])
const usdcCode = await readRpc('eth_getCode', [USDC, 'latest'])
assert(autoSaverCode && autoSaverCode !== '0x', 'deployed AutoSaver code must exist')
assert(legacySavingsCode && legacySavingsCode !== '0x', 'deployed legacy savings contract code must exist')
assert(usdcCode && usdcCode !== '0x', 'canonical Testnet USDC code must exist')
const usdcReadAbi = parseAbi(['function decimals() view returns (uint8)'])
const usdcDecimalsData = encodeFunctionData({ abi: usdcReadAbi, functionName: 'decimals' })
const usdcDecimals = Number(decodeAbiParameters(
  [{ type: 'uint8' }],
  await readRpc('eth_call', [{ to: USDC, data: usdcDecimalsData }, blockNumberHex]),
)[0])
assert.equal(usdcDecimals, 6, 'canonical Testnet ERC-20 USDC interface must report six decimals')

const readAbi = parseAbi([
  'function owner() view returns (address)',
  'function relayer() view returns (address)',
  'function usdc() view returns (address)',
  'function paused() view returns (bool)',
])
async function readContract(signature) {
  const data = encodeFunctionData({ abi: readAbi, functionName: signature })
  return readRpc('eth_call', [{ to: AUTO_SAVER, data }, blockNumberHex])
}
const owner = decodeAbiParameters([{ type: 'address' }], await readContract('owner'))[0]
const relayer = decodeAbiParameters([{ type: 'address' }], await readContract('relayer'))[0]
const configuredUsdc = decodeAbiParameters([{ type: 'address' }], await readContract('usdc'))[0]
const paused = decodeAbiParameters([{ type: 'bool' }], await readContract('paused'))[0]
assert.equal(owner.toLowerCase(), deploymentManifest.deployer.toLowerCase(), 'deployed AutoSaver owner must match the recorded deployer')
assert.equal(relayer.toLowerCase(), deploymentManifest.relayer.toLowerCase(), 'deployed AutoSaver relayer must match the deployment manifest')
const auditWalletIsAdminOrRelayer = [owner, relayer].some((role) => role.toLowerCase() === ACCOUNT.toLowerCase())
const auditWalletNativeWei = BigInt(await readRpc('eth_getBalance', [ACCOUNT, blockNumberHex]))
const usdcAccountReadAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])
async function readUsdcAccount(functionName, args) {
  const data = encodeFunctionData({ abi: usdcAccountReadAbi, functionName, args })
  return BigInt(decodeAbiParameters([{ type: 'uint256' }], await readRpc('eth_call', [{ to: USDC, data }, blockNumberHex]))[0])
}
const auditWalletUsdc6 = await readUsdcAccount('balanceOf', [ACCOUNT])
const auditWalletAllowance6 = await readUsdcAccount('allowance', [ACCOUNT, AUTO_SAVER])
const userConfigReadAbi = parseAbi([
  'function getUserConfig(address wallet) view returns (address destination, uint64 maxRoundup6, uint64 dailyCap6, uint32 configEpoch, bool paused, bool enrolled)',
])
const userConfigData = encodeFunctionData({ abi: userConfigReadAbi, functionName: 'getUserConfig', args: [ACCOUNT] })
const [auditWalletDestination, auditWalletMaxRoundup6, auditWalletDailyCap6, auditWalletConfigEpoch, auditWalletPaused, auditWalletEnrolled] = decodeAbiParameters(
  [
    { type: 'address' },
    { type: 'uint64' },
    { type: 'uint64' },
    { type: 'uint32' },
    { type: 'bool' },
    { type: 'bool' },
  ],
  await readRpc('eth_call', [{ to: AUTO_SAVER, data: userConfigData }, blockNumberHex]),
)
assert.equal(auditWalletNativeWei, 0n, 'ephemeral audit wallet must be unfunded')
assert.equal(auditWalletUsdc6, 0n, 'ephemeral audit wallet must have no ERC-20 USDC')
assert.equal(auditWalletAllowance6, 0n, 'ephemeral audit wallet must have no AutoSaver allowance')
assert.equal(auditWalletEnrolled, false, 'ephemeral audit wallet must not be enrolled')
const legacyReadAbi = parseAbi([
  'function savingsOf(address account) view returns (uint256)',
  'function totalLiabilities() view returns (uint256)',
])
async function readLegacySavings(functionName, args = []) {
  const data = encodeFunctionData({ abi: legacyReadAbi, functionName, args })
  return readRpc('eth_call', [{ to: LEGACY_SAVINGS, data }, blockNumberHex])
}
const legacyBalanceWei = BigInt(await readRpc('eth_getBalance', [LEGACY_SAVINGS, blockNumberHex]))
const legacyLiabilitiesWei = BigInt(decodeAbiParameters([{ type: 'uint256' }], await readLegacySavings('totalLiabilities'))[0])
const testWalletLegacySavingsWei = BigInt(decodeAbiParameters(
  [{ type: 'uint256' }],
  await readLegacySavings('savingsOf', [ACCOUNT]),
)[0])
assert(legacyBalanceWei >= legacyLiabilitiesWei, 'legacy savings contract must cover recorded liabilities')
const onchain = {
  source: 'live read-only Arc Testnet RPC',
  chainId: Number(BigInt(chainIdHex)),
  blockNumber: Number(BigInt(blockNumberHex)),
  deployment: {
    manifestTransactionHash: deploymentManifest.deployTxHash,
    manifestDeployBlock: deploymentManifest.deployBlock,
    historicalReceiptProof: 'NOT_CHECKED_BY_CONNECTED_APP_REGRESSION; see separate Testnet provenance artifact',
    knownUnsafeFinancialTarget: AUTO_SAVER.toLowerCase() === KNOWN_UNSAFE_AUTO_SAVER.toLowerCase(),
    connectedProductFinancialWritesBlocked: AUTO_SAVER.toLowerCase() === KNOWN_UNSAFE_AUTO_SAVER.toLowerCase(),
    ownerMatchesRecordedDeployer: owner.toLowerCase() === deploymentManifest.deployer.toLowerCase(),
    relayerMatchesManifest: relayer.toLowerCase() === deploymentManifest.relayer.toLowerCase(),
  },
  autoSaver: { address: AUTO_SAVER, deployedCodeBytes: (autoSaverCode.length - 2) / 2 },
  auditWallet: {
    address: ACCOUNT,
    nativeBalanceWei: auditWalletNativeWei.toString(),
    usdcBalance6: auditWalletUsdc6.toString(),
    autoSaverAllowance6: auditWalletAllowance6.toString(),
    enrolled: auditWalletEnrolled,
    destination: auditWalletDestination,
    maxRoundup6: auditWalletMaxRoundup6.toString(),
    dailyCap6: auditWalletDailyCap6.toString(),
    configEpoch: auditWalletConfigEpoch,
    paused: auditWalletPaused,
  },
  legacySavings: {
    address: LEGACY_SAVINGS,
    deployedCodeBytes: (legacySavingsCode.length - 2) / 2,
    totalLiabilitiesWei: legacyLiabilitiesWei.toString(),
    contractBalanceWei: legacyBalanceWei.toString(),
    codeLevelSolvencyInvariant: legacyBalanceWei >= legacyLiabilitiesWei,
    auditWalletSavingsWei: testWalletLegacySavingsWei.toString(),
    adminOwnerOrRelayer: auditWalletIsAdminOrRelayer,
  },
  usdc: { address: USDC, deployedCodeBytes: (usdcCode.length - 2) / 2, decimals: usdcDecimals },
  owner,
  relayer,
  configuredUsdc,
  paused,
  readsOnly: true,
}
assert.equal(configuredUsdc.toLowerCase(), USDC.toLowerCase(), 'deployed AutoSaver must use canonical Testnet USDC')
assert.equal(auditWalletIsAdminOrRelayer, false, 'ephemeral browser wallet must not have an administrative or relayer role')
writeFileSync(`${OUT}/read-only-rpc.json`, `${JSON.stringify(onchain, null, 2)}\n`)

// The destination key is generated only in this process. Its private key is
// never used to sign, persisted, or printed; the destination is unfunded.
const destinationPrivateKey = generatePrivateKey()
const destinationAddress = privateKeyToAccount(destinationPrivateKey).address
assert.notEqual(destinationAddress.toLowerCase(), ACCOUNT.toLowerCase())

const problems = []
const checks = []
const browserRpcMethods = new Set()
const blockedBrowserRpc = []
const apiFailures = []
const apiResponses = []
const apiEnrollmentReads = []
const liveRpcReadResults = []
const consoleErrors = []
const pageErrors = []
const failedRequests = []
const blockedThirdPartyRequests = []
const blockedThirdPartyConsoleErrors = []
const apiHealth = []
const apiStatus = []
const rpcFailures = []
const check = (name, condition, detail = '') => {
  const row = { name, status: condition ? 'PASS' : 'FAIL', ...(detail ? { detail } : {}) }
  checks.push(row)
  if (!condition) problems.push(`${name}${detail ? `: ${detail}` : ''}`)
}
const waitForPath = (page, pathname) => page.waitForFunction(
  (expected) => window.location.pathname === expected,
  pathname,
  { timeout: 15_000 },
)
const waitForHydration = (page, selector) => page.waitForFunction(
  (target) => {
    const element = document.querySelector(target)
    return Boolean(element && Object.keys(element).some((key) => key.startsWith('__reactProps$')))
  },
  selector,
  { timeout: 15_000 },
)
const waitForVisibleText = (page, text) => page.waitForFunction(
  (expected) => Array.from(document.querySelectorAll('body *')).some((element) => {
    if (element.childElementCount || element.textContent?.trim() !== expected) return false
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }),
  text,
  { timeout: 10_000 },
)

const walletStub = ({ account, chainId, rpc, readOnlyMethods }) => {
  const stateKey = '__movy_readonly_wallet_audit_v1'
  let savedState = null
  try { savedState = JSON.parse(sessionStorage.getItem(stateKey) || 'null') } catch { /* fresh context */ }
  let selectedAccount = savedState?.account || account
  let selectedChain = savedState?.chainId || chainId
  let rejectNextConnect = savedState?.rejectNextConnect ?? true
  let connected = savedState?.connected ?? false
  const listeners = new Map()
  const signingAttempts = savedState?.signingAttempts || []
  const forwardedReads = savedState?.forwardedReads || []
  const switchRequests = savedState?.switchRequests || []
  const accountRequests = savedState?.accountRequests || []
  const persistState = () => sessionStorage.setItem(stateKey, JSON.stringify({
    account: selectedAccount,
    chainId: selectedChain,
    rejectNextConnect,
    connected,
    signingAttempts,
    forwardedReads,
    switchRequests,
    accountRequests,
  }))
  const callListeners = (event, value) => {
    for (const listener of listeners.get(event) || []) listener(value)
  }
  const provider = {
    isMetaMask: true,
    selectedAddress: selectedAccount,
    chainId: selectedChain,
    async request({ method, params = [] }) {
      if (method === 'eth_requestAccounts') {
        if (rejectNextConnect) {
          rejectNextConnect = false
          persistState()
          throw Object.assign(new Error('User rejected the wallet connection request'), { code: 4001 })
        }
        connected = true
        persistState()
        return [selectedAccount]
      }
      if (method === 'eth_accounts') {
        accountRequests.push({ connected, account: selectedAccount })
        persistState()
        return connected ? [selectedAccount] : []
      }
      if (method === 'eth_chainId') return selectedChain
      if (method === 'wallet_switchEthereumChain') {
        const requestedChainId = params?.[0]?.chainId
        switchRequests.push(requestedChainId ?? null)
        selectedChain = typeof requestedChainId === 'number'
          ? `0x${requestedChainId.toString(16)}`
          : requestedChainId || selectedChain
        provider.chainId = selectedChain
        persistState()
        callListeners('chainChanged', selectedChain)
        return null
      }
      if (method === 'eth_sendTransaction' || method === 'eth_sendRawTransaction' || method.startsWith('eth_sign') || method === 'personal_sign' || method.startsWith('wallet_send')) {
        signingAttempts.push(method)
        persistState()
        throw Object.assign(new Error('User denied transaction signature'), { code: 4001 })
      }
      if (!readOnlyMethods.includes(method)) {
        throw Object.assign(new Error(`Wallet method is disabled in read-only certification: ${method}`), { code: -32601 })
      }
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Read-only RPC HTTP ${response.status}`)
      const result = await response.json()
      if (result.error) throw new Error(`Read-only RPC rejected ${method}`)
      forwardedReads.push(method)
      persistState()
      return result.result
    },
    on(event, listener) {
      const set = listeners.get(event) || new Set()
      set.add(listener)
      listeners.set(event, set)
      return provider
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
      return provider
    },
    emitAccount(address) {
      connected = true
      selectedAccount = address
      provider.selectedAddress = address
      persistState()
      callListeners('accountsChanged', [address])
    },
    emitChain(id) {
      selectedChain = id
      provider.chainId = id
      persistState()
      callListeners('chainChanged', id)
    },
    stats() { return { signingAttempts: [...signingAttempts], forwardedReads: [...forwardedReads], switchRequests: [...switchRequests], accountRequests: [...accountRequests], chainId: selectedChain, account: selectedAccount, connected } },
  }
  window.ethereum = provider
  window.ethereum.providers = [provider]
  window.__movyReadOnlyWallet = provider
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(),
  headless: true,
})

const availableViewports = [
  { label: '390x844', width: 390, height: 844, mobile: true },
  { label: '1440x900', width: 1440, height: 900, mobile: false },
]
const requestedViewports = process.env.MOVY_CONNECTED_VIEWPORTS?.split(',').map((value) => value.trim()).filter(Boolean)
const viewports = requestedViewports
  ? availableViewports.filter((viewport) => requestedViewports.includes(viewport.label))
  : availableViewports
assert(viewports.length > 0, 'MOVY_CONNECTED_VIEWPORTS must select 390x844, 1440x900, or both')

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
    })
    await context.addInitScript(walletStub, {
      account: ACCOUNT,
      chainId: chainIdHex,
      rpc: RPC,
      readOnlyMethods: [...READ_ONLY_RPC_METHODS],
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(`${viewport.label}: ${String(error).split('\n')[0]}`))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const error = `${viewport.label}: ${message.text().split('\n')[0]}`
        if (
          message.text().includes('Analytics SDK: TypeError: Failed to fetch') ||
          message.text().includes('Failed to load resource: net::ERR_TUNNEL_CONNECTION_FAILED') &&
            blockedThirdPartyRequests.some((request) => request.viewport === viewport.label)
        ) blockedThirdPartyConsoleErrors.push(error)
        else consoleErrors.push(error)
      }
    })
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText || ''
      if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT\.Inspector/.test(failure)) return
      const url = new URL(request.url())
      if (url.origin === 'https://cca-lite.coinbase.com' && ['/amp', '/metrics'].includes(url.pathname)) {
        blockedThirdPartyRequests.push({ viewport: viewport.label, path: url.pathname, failure })
        return
      }
      if (url.origin === rpcUrl.origin) rpcFailures.push({ viewport: viewport.label, path: url.pathname, failure })
      else failedRequests.push(`${viewport.label}: ${url.origin}${url.pathname} ${failure}`)
    })
    page.on('response', async (response) => {
      if (response.status() >= 400) {
        const responseUrl = new URL(response.url())
        const pathname = responseUrl.pathname
        if (pathname.startsWith('/api/')) apiFailures.push({ viewport: viewport.label, path: pathname, status: response.status() })
        else if (responseUrl.origin === rpcUrl.origin) rpcFailures.push({ viewport: viewport.label, path: pathname, status: response.status() })
        else problems.push(`${viewport.label}: HTTP ${response.status()} ${pathname}`)
      }
      const responseUrl = new URL(response.url())
      if (responseUrl.origin === new URL(BASE).origin && responseUrl.pathname.startsWith('/api/')) {
        apiResponses.push({ viewport: viewport.label, path: responseUrl.pathname, status: response.status() })
        if (responseUrl.pathname === '/api/enrollment' && response.request().method() === 'GET') {
          try {
            const body = await response.json()
            apiEnrollmentReads.push({
              viewport: viewport.label,
              status: response.status(),
              chainId: body.chainId ?? null,
              enrolled: body.onchainConfig?.enrolled ?? null,
              paused: body.onchainConfig?.paused ?? null,
              dailyCap6: body.onchainConfig?.dailyCap6 ?? null,
              maxRoundup6: body.onchainConfig?.maxRoundup6 ?? null,
              enrollmentStatus: body.enrollment?.status ?? null,
            })
          } catch { /* Error responses are summarized by status only. */ }
        }
      }
    })
    await page.route('**/*', async (route) => {
      const request = route.request()
      if (new URL(request.url()).host === rpcUrl.host && request.method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': new URL(BASE).origin,
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
          },
          body: '',
        })
      }
      const body = request.postData()
      if (!body) return route.continue()
      let payload
      try { payload = JSON.parse(body) } catch { return route.continue() }
      const entries = Array.isArray(payload) ? payload : [payload]
      const rpcEntries = entries.filter((entry) => entry?.jsonrpc === '2.0' && typeof entry.method === 'string')
      if (!rpcEntries.length) return route.continue()
      const blocked = rpcEntries.find((entry) => !isReadOnlyRpcMethod(entry.method))
      if (blocked) {
        blockedBrowserRpc.push(blocked.method)
        return route.abort('blockedbyclient')
      }
      rpcEntries.forEach((entry) => browserRpcMethods.add(entry.method))
      try {
        const results = await Promise.all(rpcEntries.map(async (entry) => {
          const response = await readRpc(entry.method, entry.params || [])
          if (entry.method === 'eth_getCode') {
            liveRpcReadResults.push({
              method: entry.method,
              address: entry.params?.[0],
              codeBytes: typeof response === 'string' ? (response.length - 2) / 2 : null,
              noCode: response === '0x',
            })
          }
          if (entry.method === 'eth_estimateGas') {
            const tx = entry.params?.[0] || {}
            liveRpcReadResults.push({
              method: entry.method,
              to: tx.to,
              dataSelector: typeof tx.data === 'string' ? tx.data.slice(0, 10) : null,
              estimatedGasHex: response,
              simulationOnly: true,
            })
          }
          if (entry.method === 'eth_getLogs') {
            const filter = entry.params?.[0] || {}
            liveRpcReadResults.push({
              method: entry.method,
              address: filter.address ?? null,
              fromBlock: filter.fromBlock ?? null,
              toBlock: filter.toBlock ?? null,
              topicCount: Array.isArray(filter.topics) ? filter.topics.length : 0,
              returnedLogs: Array.isArray(response) ? response.length : null,
            })
          }
          return { jsonrpc: '2.0', id: entry.id, result: response }
        }))
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': new URL(BASE).origin },
          body: JSON.stringify(Array.isArray(payload) ? results : results[0]),
        })
      } catch (error) {
        rpcFailures.push({
          viewport: viewport.label,
          methods: rpcEntries.map((entry) => entry.method),
          // The request contains public contract calldata and addresses, but no
          // wallet secrets. Preserve it so live simulation failures can be
          // independently replayed without converting them into mock passes.
          params: rpcEntries.map((entry) => entry.params || []),
          error: error instanceof Error ? error.message : 'RPC read failed',
        })
        return route.fulfill({
          status: 502,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': new URL(BASE).origin },
          body: JSON.stringify({ jsonrpc: '2.0', id: rpcEntries[0]?.id ?? null, error: { code: -32000, message: 'Read-only Arc RPC unavailable' } }),
        })
      }
    })

    const prefix = `${OUT}/${viewport.label}`
    mkdirSync(prefix, { recursive: true })
    await page.goto(`${BASE}/onboarding`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.getByRole('heading', { name: /saving/i }).first().waitFor({ state: 'visible' })
    const health = await page.evaluate(async () => {
      const response = await fetch('/api/health', { cache: 'no-store' })
      return { status: response.status, body: await response.json() }
    })
    apiHealth.push({ viewport: viewport.label, ...health })
    const databaseExpectedReady = process.env.MOVY_EXPECT_DATABASE_READY === 'true'
    check(
      `${viewport.label}: product health reports ${databaseExpectedReady ? 'the isolated migrated database ready' : 'the deliberately absent database unavailable'}`,
      databaseExpectedReady
        ? health.status === 200 && health.body.status === 'ok' && health.body.database?.ready === true
        : health.status === 503 && health.body.status === 'not_ready' && health.body.database?.ready === false,
    )
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/status', { cache: 'no-store' })
      return { status: response.status, body: await response.json() }
    })
    apiStatus.push({ viewport: viewport.label, ...status })
    check(
      `${viewport.label}: live product status is pinned to Arc Testnet with financial gates off`,
      status.status === 200 && status.body.chainId === 5_042_002 && status.body.autoSaverAddress?.toLowerCase() === AUTO_SAVER.toLowerCase() && status.body.activeUsers === 0 && status.body.totalSaved6 === '0' && status.body.relayerConfigured === false,
      JSON.stringify(status),
    )
    await page.screenshot({ path: `${prefix}/onboarding-welcome.png` })
    await page.getByRole('button', { name: 'Get Started' }).click()

    const connectButtons = page.getByRole('button', { name: /MetaMask|Injected/i })
    await connectButtons.first().waitFor({ state: 'visible', timeout: 10_000 })
    await connectButtons.first().click()
    check(`${viewport.label}: rejected wallet connection is recoverable`, await page.getByRole('alert').getByText('Connection request was canceled.').count() === 1)
    await page.getByRole('button', { name: /MetaMask|Injected/i }).first().click()
    await page.getByText('Account connected', { exact: true }).waitFor({ timeout: 15_000 })
    let onboardingText = await page.locator('body').innerText()
    check(`${viewport.label}: connected account detected`, onboardingText.toLowerCase().includes(ACCOUNT.slice(-4).toLowerCase()))

    await page.evaluate((address) => window.__movyReadOnlyWallet.emitAccount(address), ALT_ACCOUNT)
    await page.getByText(new RegExp(ALT_ACCOUNT.slice(-4), 'i')).first().waitFor({ timeout: 10_000 })
    await page.evaluate((address) => window.__movyReadOnlyWallet.emitAccount(address), ACCOUNT)
    await page.getByText(new RegExp(ACCOUNT.slice(-4), 'i')).first().waitFor({ timeout: 10_000 })

    await page.evaluate(() => window.__movyReadOnlyWallet.emitChain('0x1'))
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.locator('#connected-destination').fill(ACCOUNT)
    await page.getByRole('button', { name: 'Continue' }).click()
    check(`${viewport.label}: rejects spending-wallet destination`, await page.getByRole('alert').getByText(/cannot match your connected spending wallet/i).count() === 1)

    await page.locator('#connected-destination').fill(destinationAddress)
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: /Continue|Verifying on Arc/i }).click()
    await page.getByText('Set your savings limits').waitFor({ timeout: 25_000 })
    check(`${viewport.label}: destination bytecode is verified by live Testnet RPC`, liveRpcReadResults.some((item) => item.address?.toLowerCase() === destinationAddress.toLowerCase() && item.noCode))
    await page.screenshot({ path: `${prefix}/onboarding-limits.png` })

    await page.getByRole('button', { name: 'Custom' }).click()
    await page.locator('#custom-daily-cap').fill('0.99')
    await page.getByRole('button', { name: 'Review & Activate' }).click()
    await page.getByRole('button', { name: 'Turn on automatic saving' }).click()
    check(`${viewport.label}: rejects below-minimum daily limit before wallet action`, await page.getByRole('alert').getByText(/daily limit from \$1 to \$500/i).count() === 1)
    await page.getByRole('button', { name: 'Back to savings limits' }).click()
    await page.locator('#custom-daily-cap').fill('2.50')
    await page.getByRole('button', { name: 'Review & Activate' }).click()
    const staleDailyLimitNotice = page.getByRole('alert').filter({ hasText: /Enter a daily limit from \$1 to \$500/ })
    check(
      `${viewport.label}: corrected daily limit clears the stale activation error`,
      await staleDailyLimitNotice.count() === 0,
      JSON.stringify(await page.getByRole('alert').allTextContents()),
    )
    await page.screenshot({ path: `${prefix}/onboarding-review.png` })

    await page.getByRole('button', { name: 'Turn on automatic saving' }).click()
    check(`${viewport.label}: activation blocked on wrong network`, await page.getByRole('alert').getByText(/Switch to Arc Testnet \(chain 5042002\) before enrolling/i).count() === 1)
    let stats = await page.evaluate(() => window.__movyReadOnlyWallet.stats())
    check(`${viewport.label}: wrong-network gate blocks wallet writes`, stats.signingAttempts.length === 0)

    await page.evaluate((id) => window.__movyReadOnlyWallet.emitChain(id), chainIdHex)
    const wrongNetworkNotice = page.getByRole('alert').getByText(/Switch to Arc Testnet \(chain 5042002\) before enrolling or setting an allowance/i)
    await wrongNetworkNotice.waitFor({ state: 'detached', timeout: 5_000 })
    check(`${viewport.label}: stale wrong-network error clears after switching to Arc Testnet`, await wrongNetworkNotice.count() === 0)
    const enrollData = encodeFunctionData({
      abi: parseAbi(['function enroll(address destination, uint64 maxRoundup6, uint64 dailyCap6)']),
      functionName: 'enroll',
      args: [destinationAddress, 1_000_000n, 2_500_000n],
    })
    const enrollSelector = enrollData.slice(0, 10)
    let enrollEstimateHex = null
    let enrollEstimateError = null
    try {
      enrollEstimateHex = await readRpc('eth_estimateGas', [{ from: ACCOUNT, to: AUTO_SAVER, data: enrollData }])
      liveRpcReadResults.push({
        method: 'eth_estimateGas',
        to: AUTO_SAVER,
        dataSelector: enrollSelector,
        estimatedGasHex: enrollEstimateHex,
        simulationOnly: true,
      })
    } catch (error) {
      enrollEstimateError = error instanceof Error ? error.message : 'live enrollment estimate failed'
      rpcFailures.push({ viewport: viewport.label, methods: ['eth_estimateGas'], params: [{ from: ACCOUNT, to: AUTO_SAVER, data: enrollData }], error: enrollEstimateError })
    }
    check(
      `${viewport.label}: valid enrollment gas estimate succeeded on live Testnet RPC without signing`,
      typeof enrollEstimateHex === 'string' && BigInt(enrollEstimateHex) > 0n,
      enrollEstimateError || enrollEstimateHex || '',
    )
    const blockedActivation = page.getByRole('button', { name: 'Automatic saving unavailable', exact: true })
    check(`${viewport.label}: unsafe Testnet activation is visibly disabled`, await blockedActivation.isDisabled())
    await page.locator('#activation-unavailable-notice')
      .getByText('Automatic saving is unavailable on Arc Testnet right now. No wallet approval prompt will open.')
      .waitFor({ timeout: 30_000 })
    stats = await page.evaluate(() => window.__movyReadOnlyWallet.stats())
    check(`${viewport.label}: unsafe Testnet enrollment is blocked before a wallet request`, stats.signingAttempts.length === 0)
    check(`${viewport.label}: no JSON-RPC write forwarded`, blockedBrowserRpc.length === 0)
    await page.screenshot({ path: `${prefix}/onboarding-unsafe-write-blocked.png` })

    // Continue through the connected product navigation so wallet hydration
    // settles before the account-scoped goal editor mounts.
    await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Home' }).waitFor({ state: 'visible' })
    const goalAccountSelector = viewport.mobile
      ? '.consumer-header .consumer-wallet-link'
      : '.consumer-sidebar .consumer-identity strong'
    await page.waitForFunction(({ selector, suffix }) =>
      Array.from(document.querySelectorAll(selector)).some((element) => {
        const rect = element.getBoundingClientRect()
        return element.textContent?.toLowerCase().includes(suffix) && rect.width > 0 && rect.height > 0
      }),
    { selector: goalAccountSelector, suffix: ACCOUNT.slice(-4).toLowerCase() },
    { timeout: 15_000 })
    await page.locator(`nav[aria-label="${viewport.mobile ? 'Main' : 'Desktop Main'}"] a[href="/savings"]`).click()
    await waitForPath(page, '/savings')
    await page.getByRole('link', { name: 'Create a new goal' }).first().click()
    await waitForPath(page, '/savings/new')
    await waitForHydration(page, '#goal-name')
    await page.getByLabel('Goal name').waitFor({ state: 'visible' })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.getByLabel('Goal name').fill('Audit travel plan')
    await page.getByLabel('Target amount (USDC)').fill('500.00')
    const goalFormAfterFill = await page.evaluate(() => Object.fromEntries(['goal-name', 'goal-target'].map((id) => {
      const input = document.getElementById(id)
      const propsKey = input && Object.keys(input).find((key) => key.startsWith('__reactProps$'))
      const props = propsKey ? input[propsKey] : null
      return [id, { value: input?.value, reactValue: props?.value, hasReactChange: typeof props?.onChange === 'function' }]
    })))
    await page.getByLabel('Travel', { exact: true }).check()
    await page.waitForTimeout(300)
    const goalFormBeforeSubmit = await page.evaluate(() => Object.fromEntries(['goal-name', 'goal-target'].map((id) => {
      const input = document.getElementById(id)
      const propsKey = input && Object.keys(input).find((key) => key.startsWith('__reactProps$'))
      const props = propsKey ? input[propsKey] : null
      return [id, { value: input?.value, reactValue: props?.value, hasReactChange: typeof props?.onChange === 'function' }]
    })))
    check(`${viewport.label}: goal form fields retain React-controlled values`, goalFormBeforeSubmit['goal-name']?.reactValue === 'Audit travel plan' && goalFormBeforeSubmit['goal-target']?.reactValue === '500.00', JSON.stringify({ afterFill: goalFormAfterFill, beforeSubmit: goalFormBeforeSubmit }))
    await page.getByRole('button', { name: 'Create goal' }).click()
    try {
      await waitForPath(page, '/savings')
    } catch (error) {
      await page.screenshot({ path: `${prefix}/goal-create-failure.png` })
      console.error('Connected goal creation did not navigate', {
        url: page.url(),
        goalFormAfterFill,
        goalFormBeforeSubmit,
        alerts: await page.getByRole('alert').allTextContents(),
        body: (await page.locator('body').innerText()).slice(0, 1200),
      })
      throw error
    }
    await page.getByText('Audit travel plan').waitFor({ timeout: 10_000 })
    check(`${viewport.label}: connected-wallet goal creation works`, (await page.locator('body').innerText()).includes('Manual target: $500.00'))
    // This local target has no legacy MovySavings address: the legacy vault must read as
    // not configured (unavailable), never as a confirmed zero balance.
    await page.getByText('Legacy vault not configured').first().waitFor({ timeout: 20_000 })
    const savingsReadsSettled = await page.waitForFunction(() => {
      const text = document.body.innerText
      return !text.includes('Loading…') && !text.includes('Loading confirmed history and current balances…')
    }, null, { timeout: 20_000 }).then(() => true).catch(() => false)
    await page.waitForFunction(({ selector, suffix }) =>
      Array.from(document.querySelectorAll(selector)).some((element) => {
        const rect = element.getBoundingClientRect()
        return element.textContent?.toLowerCase().includes(suffix) && rect.width > 0 && rect.height > 0
      }),
    { selector: goalAccountSelector, suffix: ACCOUNT.slice(-4).toLowerCase() },
    { timeout: 15_000 })
    const settledSavingsText = await page.locator('body').innerText()
    check(
      `${viewport.label}: Savings shows live connected-wallet state and resolved financial reads`,
      savingsReadsSettled && !settledSavingsText.includes('Connect wallet to view') && settledSavingsText.toLowerCase().includes(ACCOUNT.slice(-4).toLowerCase()) && settledSavingsText.includes('$0.00'),
      settledSavingsText.slice(0, 1_000),
    )
    await page.screenshot({ path: `${prefix}/savings-connected.png` })
    const legacyTransfer = page.getByRole('button', { name: 'Transfer legacy vault funds' })
    const recoverySection = page.locator('.savings-recovery')
    const legacyVaultValue = (await recoverySection.locator('dt', { hasText: 'Withdrawable legacy vault balance' }).locator('xpath=following-sibling::dd').first().innerText()).trim()
    const savingsWalletValue = (await recoverySection.locator('dt', { hasText: 'Current savings wallet balance' }).locator('xpath=following-sibling::dd').first().innerText()).trim()
    const recoveryText = await recoverySection.innerText()
    const pageTextOutsideRecovery = (await page.locator('body').innerText()).replace(recoveryText, '')
    check(
      `${viewport.label}: legacy vault is explicitly not configured, not a confirmed $0.00`,
      legacyVaultValue === 'Legacy vault not configured' && !legacyVaultValue.includes('$'),
      legacyVaultValue,
    )
    check(
      `${viewport.label}: no confirmed-zero legacy claim is shown while the legacy balance is unverified`,
      !recoveryText.includes('No withdrawable legacy vault funds') && await page.getByText('No withdrawable legacy vault funds').count() === 0,
    )
    check(
      `${viewport.label}: AutoSaver-confirmed history and the separate savings wallet stay distinct from the legacy vault`,
      pageTextOutsideRecovery.includes('Confirmed round-up transfers recorded by MOVY. Current balances are separate.') &&
        pageTextOutsideRecovery.includes('$0.00') &&
        savingsWalletValue !== legacyVaultValue &&
        savingsWalletValue !== 'Legacy vault not configured' &&
        recoveryText.includes('Your personal savings wallet. MOVY cannot withdraw these funds.'),
      JSON.stringify({ savingsWalletValue, legacyVaultValue }),
    )
    check(`${viewport.label}: legacy withdrawal is disabled because its balance is not verified`, await legacyTransfer.isDisabled())
    check(`${viewport.label}: an unverified legacy balance cannot open a transaction sheet`, await page.getByRole('dialog', { name: 'Withdraw Savings' }).count() === 0)
    const savingsWalletStats = await page.evaluate(() => window.__movyReadOnlyWallet.stats())
    check(
      `${viewport.label}: Savings reads send no wallet signing request and no JSON-RPC write`,
      savingsWalletStats.signingAttempts.length === 0 && blockedBrowserRpc.length === 0,
      JSON.stringify({ signingAttempts: savingsWalletStats.signingAttempts.length, blockedBrowserRpc: blockedBrowserRpc.length }),
    )
    if (viewport.mobile) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await page.waitForTimeout(100)
      const savingsScroll = await page.evaluate(() => ({
        scrollTop: window.scrollY,
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
      }))
      check(`${viewport.label}: Savings recovery controls are reachable by mobile scrolling`, savingsScroll.scrollTop > 0 && savingsScroll.scrollTop + savingsScroll.viewportHeight >= savingsScroll.documentHeight - 1, JSON.stringify(savingsScroll))
      await legacyTransfer.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${prefix}/savings-recovery-controls.png` })
      await page.evaluate(() => window.scrollTo(0, 0))
    }
    const savedGoal = await page.evaluate((key) => localStorage.getItem(key), `movy_goals_${ACCOUNT.toLowerCase()}`)
    check(`${viewport.label}: connected goal persists in wallet-scoped storage`, savedGoal?.includes('Audit travel plan') === true)
    const editLink = page.getByRole('link', { name: 'Edit Audit travel plan' })
    const editHref = await editLink.getAttribute('href')
    check(`${viewport.label}: connected goal exposes an edit action`, Boolean(editHref?.endsWith('/edit')))
    await editLink.click()
    await waitForPath(page, editHref)
    await page.getByRole('heading', { name: 'Edit goal' }).waitFor({ timeout: 10_000 })
    check(`${viewport.label}: connected goal edit form is prefilled`, await page.getByLabel('Goal name').inputValue() === 'Audit travel plan')
    await page.getByLabel('Goal name').fill('Updated travel plan')
    await page.getByLabel('Target amount (USDC)').fill('600.00')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await waitForPath(page, '/savings')
    await page.getByText('Updated travel plan').waitFor({ timeout: 10_000 })
    check(`${viewport.label}: connected goal edits persist with a manual target`, (await page.locator('body').innerText()).includes('Manual target: $600.00'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('Updated travel plan').waitFor({ timeout: 10_000 })
    const walletRestoredAfterReload = await page.waitForFunction(({ selector, suffix }) =>
      Array.from(document.querySelectorAll(selector)).some((element) => {
        const rect = element.getBoundingClientRect()
        return element.textContent?.toLowerCase().includes(suffix) && rect.width > 0 && rect.height > 0
      }),
    { selector: goalAccountSelector, suffix: ACCOUNT.slice(-4).toLowerCase() },
    { timeout: 15_000 }).then(() => true).catch(() => false)
    check(`${viewport.label}: connected wallet is restored after a full reload`, walletRestoredAfterReload)
    const savingsReloadSettled = walletRestoredAfterReload && await page.waitForFunction(({ suffix }) => {
      const text = document.body.innerText
      return text.toLowerCase().includes(suffix) && text.includes('$0.00') &&
        !text.includes('Loading…') && !text.includes('Loading confirmed history and current balances…')
    }, { suffix: ACCOUNT.slice(-4).toLowerCase() }, { timeout: 20_000 }).then(() => true).catch(() => false)
    const savingsAfterReloadText = await page.locator('body').innerText()
    check(
      `${viewport.label}: connected savings reads recover after a full reload`,
      savingsReloadSettled && savingsAfterReloadText.includes('$0.00') && savingsAfterReloadText.includes('Updated travel plan'),
      savingsAfterReloadText.slice(0, 1_000),
    )
    check(
      `${viewport.label}: the legacy vault is still not configured, not a confirmed zero, after a full reload`,
      savingsAfterReloadText.includes('Legacy vault not configured') && !savingsAfterReloadText.includes('No withdrawable legacy vault funds'),
    )
    await page.screenshot({ path: `${prefix}/savings-connected.png` })
    const editedGoal = await page.evaluate((key) => localStorage.getItem(key), `movy_goals_${ACCOUNT.toLowerCase()}`)
    check(`${viewport.label}: goal creation and edit survive a reload`, editedGoal?.includes('Updated travel plan') === true)
    await page.goBack({ waitUntil: 'domcontentloaded' })
    await waitForPath(page, editHref)
    await page.getByRole('heading', { name: 'Edit goal' }).waitFor({ state: 'visible' })
    check(`${viewport.label}: browser Back restores the edited goal route`, await page.getByLabel('Goal name').inputValue() === 'Updated travel plan')
    await page.goForward({ waitUntil: 'domcontentloaded' })
    await waitForPath(page, '/savings')
    check(`${viewport.label}: browser Forward restores Savings`, (await page.locator('body').innerText()).includes('Updated travel plan'))

    const homeNavigationLink = page.locator(`nav[aria-label="${viewport.mobile ? 'Main' : 'Desktop Main'}"] a[href="/home"]`)
    // The Next.js dev indicator overlaps the bottom-left mobile nav in headless dev runs.
    // Activate this route through the keyboard; the same mobile pointer navigation passed above.
    if (viewport.mobile) {
      await homeNavigationLink.focus()
      await homeNavigationLink.press('Enter')
    } else {
      await homeNavigationLink.click()
    }
    await waitForPath(page, '/home')
    await page.getByRole('heading', { name: 'Home' }).waitFor({ state: 'visible' })
    const accountLabelSelector = viewport.mobile
      ? '.consumer-header .consumer-wallet-link'
      : '.consumer-sidebar .consumer-identity strong'
    await page.waitForFunction(({ selector, suffix }) =>
      Array.from(document.querySelectorAll(selector)).some((element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return element.textContent?.toLowerCase().includes(suffix) && rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden'
      }),
    { selector: accountLabelSelector, suffix: ACCOUNT.slice(-4).toLowerCase() },
    { timeout: 15_000 })
    const homeReadsSettled = await page.waitForFunction(() => {
      const text = document.body.innerText
      return !/Loading activity|Loading confirmed round-up history/i.test(text)
    }, null, { timeout: 15_000 }).then(() => true).catch(() => false)
    const homeText = await page.locator('body').innerText()
    const homeConnection = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      labels: Array.from(document.querySelectorAll('a.consumer-wallet-link, .consumer-sidebar .consumer-identity strong')).map((element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          text: element.textContent?.trim() || '',
          display: style.display,
          visibility: style.visibility,
          width: rect.width,
          height: rect.height,
        }
      }),
      provider: window.__movyReadOnlyWallet.stats(),
      wagmiStore: localStorage.getItem('wagmi.store'),
    }))
    const visibleAccountLabel = homeConnection.labels.some((label) =>
      label.text.toLowerCase().includes(ACCOUNT.slice(-4).toLowerCase()) &&
      label.width > 0 && label.height > 0 && label.display !== 'none' && label.visibility !== 'hidden',
    )
    check(
      `${viewport.label}: Home retains the connected wallet after navigation`,
      visibleAccountLabel,
      JSON.stringify(homeConnection),
    )
    check(`${viewport.label}: Home connected savings and recent activity reads settle`, homeReadsSettled, homeText.slice(-1_000))
    check(`${viewport.label}: Home routine copy does not expose Testnet terminology`, !/\bArc Testnet\b/i.test(homeText))
    check(`${viewport.label}: Home does not show sample connected activity`, !/Arc Coffee Roasters|Example entry|Demo receipt/.test(homeText))
    const appLayout = await page.evaluate(() => {
      const sidebar = document.querySelector('.consumer-sidebar')
      const mobileNav = document.querySelector('nav[aria-label="Main"]')
      const rect = (element) => {
        if (!element) return null
        const box = element.getBoundingClientRect()
        return { width: box.width, height: box.height }
      }
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        sidebar: rect(sidebar),
        mobileNav: rect(mobileNav),
        mobileNavTargets: Array.from(mobileNav?.querySelectorAll('a') || []).map(rect),
      }
    })
    check(`${viewport.label}: connected app has no horizontal overflow`, appLayout.documentWidth <= appLayout.viewportWidth, JSON.stringify(appLayout))
    if (viewport.mobile) {
      check(`${viewport.label}: mobile navigation is visible with 44px targets`, Boolean(appLayout.mobileNav && appLayout.mobileNav.height > 0 && appLayout.mobileNavTargets.every((target) => target && target.width >= 44 && target.height >= 44)), JSON.stringify(appLayout))
    } else {
      check(`${viewport.label}: desktop sidebar is visible`, Boolean(appLayout.sidebar && appLayout.sidebar.width >= 180 && appLayout.sidebar.height >= viewport.height), JSON.stringify(appLayout.sidebar))
    }
    await page.screenshot({ path: `${prefix}/home-connected.png` })
    let body = homeText
    check(`${viewport.label}: Home renders connected manual goal`, body.includes('Updated travel plan'))
    check(`${viewport.label}: Home does not invent connected round-up balance`, !/\$355\.00/.test(body))

    await page.locator(`nav[aria-label="${viewport.mobile ? 'Main' : 'Desktop Main'}"] a[href="/activity"]`).click()
    await waitForPath(page, '/activity')
    await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor({ state: 'visible' })
    body = await page.locator('body').innerText()
    check(`${viewport.label}: Activity has real connected empty/error state, not sample receipts`, !/Arc Coffee Roasters|Example entry|Demo receipt/.test(body))
    check(`${viewport.label}: Activity filters render`, await page.getByRole('tab', { name: 'All' }).count() === 1 && await page.getByRole('tab', { name: 'Savings' }).count() === 1)
    await page.getByRole('tab', { name: 'Other' }).click()
    await page.screenshot({ path: `${prefix}/activity-connected.png` })

    await page.locator(`nav[aria-label="${viewport.mobile ? 'Main' : 'Desktop Main'}"] a[href="/settings"]`).click()
    await waitForPath(page, '/settings')
    await page.getByRole('heading', { name: 'Settings' }).waitFor({ state: 'visible' })
    await page.getByRole('link', { name: new RegExp(ACCOUNT.slice(-4), 'i') }).first().waitFor({ state: 'visible' })
    body = await page.locator('body').innerText()
    check(`${viewport.label}: Settings shows actual connected account`, body.toLowerCase().includes(ACCOUNT.slice(-4).toLowerCase()))
    check(`${viewport.label}: Settings routine copy does not expose Testnet terminology`, !/\bArc Testnet\b/i.test(body))
    await page.getByText('Not enrolled', { exact: true }).waitFor({ timeout: 20_000 })
    await page.getByText('$0.000000', { exact: true }).waitFor({ timeout: 20_000 })
    body = await page.locator('body').innerText()
    check(`${viewport.label}: Settings shows confirmed live enrollment and allowance read state`, body.includes('Not enrolled') && body.includes('$0.000000'))
    await page.screenshot({ path: `${prefix}/settings-connected.png` })
    const automationSwitch = page.getByRole('switch', { name: 'Toggle Automatic Saving' })
    check(`${viewport.label}: automation stays off and blocked before enrollment`, await automationSwitch.isDisabled())
    const revokeAllowanceButton = page.getByRole('button', { name: 'Revoke allowance' })
    check(`${viewport.label}: zero token allowance cannot be revoked as a wallet action`, await revokeAllowanceButton.isDisabled())
    const changeAllowanceButton = page.getByRole('button', { name: 'Change allowance' })
    await changeAllowanceButton.waitFor({ state: 'visible' })
    await changeAllowanceButton.click()
    const allowanceDialog = page.getByRole('dialog', { name: 'Set Total USDC Allowance' })
    await allowanceDialog.waitFor({ state: 'visible' })
    check(`${viewport.label}: allowance review displays the selected total, not an increment`, await page.getByLabel('Total USDC allowance target').inputValue() === '25.00')
    await page.getByLabel('Total USDC allowance target').fill('0.00')
    check(`${viewport.label}: zero allowance target is blocked before wallet action`, await page.getByRole('button', { name: 'Set Total Allowance' }).isDisabled())
    await page.getByLabel('Total USDC allowance target').fill('25.00')
    const signingAttemptsBeforeAllowance = (await page.evaluate(() => window.__movyReadOnlyWallet.stats())).signingAttempts.length
    await page.getByRole('button', { name: 'Set Total Allowance' }).click()
    await page.getByRole('status').filter({ hasText: /This automatic saving setup is unavailable right now\. No wallet approval prompt will open\./i }).waitFor({ timeout: 15_000 })
    const allowanceWalletStats = await page.evaluate(() => window.__movyReadOnlyWallet.stats())
    check(
      `${viewport.label}: positive allowance is blocked before a wallet request`,
      allowanceWalletStats.signingAttempts.length === signingAttemptsBeforeAllowance && allowanceWalletStats.connected && allowanceWalletStats.account.toLowerCase() === ACCOUNT.toLowerCase(),
      'known unsafe Testnet AutoSaver; no approval prompt or transaction reached the RPC',
    )
    await page.evaluate(() => window.__movyReadOnlyWallet.emitChain('0x1'))
    await page.getByRole('button', { name: /Switch to Arc Testnet/ }).last().click()
    const switched = await page.waitForFunction(
      (expected) => window.__movyReadOnlyWallet.chainId === expected,
      chainIdHex,
      { timeout: 5_000 },
    ).then(() => true).catch(() => false)
    const switchStats = await page.evaluate(() => window.__movyReadOnlyWallet.stats())
    check(
      `${viewport.label}: network switch control requests the configured Testnet`,
      switched,
      `mock provider observed ${JSON.stringify(switchStats.switchRequests)} and remained ${switchStats.chainId}`,
    )

    await page.getByRole('link', { name: /Edit profile/i }).last().click()
    await waitForPath(page, '/settings/profile')
    await page.getByRole('heading', { name: 'Edit profile' }).waitFor({ state: 'visible' })
    check(`${viewport.label}: profile editor route renders`, await page.getByRole('heading', { name: 'Edit profile' }).count() === 1)
    await waitForHydration(page, '#profile-name')
    await page.screenshot({ path: `${prefix}/profile-connected.png` })
    await page.getByLabel('Name').waitFor({ state: 'visible' })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.getByLabel('Name').fill('Audit Profile')
    await page.getByRole('button', { name: 'Choose an avatar' }).click()
    await page.getByRole('radio', { name: 'Sand avatar' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await waitForPath(page, '/settings')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHydration(page, 'a.consumer-wallet-link')
    await waitForVisibleText(page, 'Audit Profile')
    check(`${viewport.label}: profile name/avatar persist for connected wallet`, (await page.locator('body').innerText()).includes('Audit Profile'))

    const walletStats = await page.evaluate(() => window.__movyReadOnlyWallet.stats())
    check(`${viewport.label}: actual RPC reads include contract calls`, browserRpcMethods.has('eth_call'))
    check(`${viewport.label}: known unsafe Testnet AutoSaver was read-only in the connected product`, onchain.deployment.connectedProductFinancialWritesBlocked && walletStats.signingAttempts.length === 0)
    check(`${viewport.label}: no signing/broadcast method reached RPC`, blockedBrowserRpc.length === 0 && walletStats.signingAttempts.every((method) => method === 'eth_sendTransaction'))
    check(`${viewport.label}: no uncaught browser exceptions`, pageErrors.filter((message) => message.startsWith(`${viewport.label}:`)).length === 0, pageErrors.find((message) => message.startsWith(`${viewport.label}:`)) || '')

    await page.close()
    await context.close()
  }
} finally {
  await browser.close()
}

const databaseExpectedReady = process.env.MOVY_EXPECT_DATABASE_READY === 'true'
const unexpectedApiFailures = apiFailures.filter((failure) => databaseExpectedReady || failure.status !== 503)
if (unexpectedApiFailures.length) problems.push(`Unexpected API failures: ${JSON.stringify(unexpectedApiFailures.slice(0, 10))}`)
if (rpcFailures.length) problems.push(`Read-only RPC failures: ${JSON.stringify(rpcFailures.slice(0, 10))}`)
if (failedRequests.length) problems.push(`Browser network requests failed: ${JSON.stringify(failedRequests.slice(0, 10))}`)

const report = {
  source: 'local Next.js app; connected application only; live read-only Arc Testnet RPC; injected wallet mock; no Demo or landing page',
  commitSha: commitSha.trim(),
  testedAt: new Date().toISOString(),
  executionGates: { workerEnabled: process.env.MOVY_WORKER_ENABLED === 'true', relayerEnabled: process.env.MOVY_RELAYER_ENABLED === 'true' },
  onchain,
  checks,
  blockedBrowserRpc,
  apiFailures,
  apiResponses,
  apiEnrollmentReads,
  apiHealth,
  apiStatus,
  consoleErrors,
  pageErrors,
  failedRequests,
  blockedThirdPartyRequests,
  blockedThirdPartyConsoleErrors,
  rpcFailures,
  observedBrowserRpcMethods: [...browserRpcMethods].sort(),
  liveRpcReadResults,
  rpcReadCacheHits: rpcCacheHits,
  problems,
  allPassed: problems.length === 0 && checks.every((row) => row.status === 'PASS'),
  note: `The wallet accounts are fresh, unfunded addresses derived in memory; wallet prompts are controlled mocks. RPC contract, bytecode, balance and chain reads are live. Historical deployment receipt proof is evaluated separately and is never inferred from current code. The known unsafe Testnet AutoSaver is blocked before enrollment, positive allowance, configuration, or resume requests; pause, revoke, and allowance reset remain protective actions. No wallet signature or transaction broadcast occurred. Product API health is recorded separately; local runs without DATABASE_URL must report not_ready, while CI expects its isolated migrated PostgreSQL database to report ready. Coinbase SDK telemetry requests may be blocked by the local outbound proxy and are recorded separately.`,
}
writeFileSync(`${OUT}/browser-report.json`, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({
  summary: `${checks.filter((row) => row.status === 'PASS').length}/${checks.length} checks passed`,
  onchain,
  apiHealth,
  apiFailures,
  rpcFailures,
  consoleErrors,
  pageErrors,
  failedRequests,
  problems,
  evidence: OUT,
}, null, 2))
assert.equal(problems.length, 0, 'connected app read-only browser checks failed')
