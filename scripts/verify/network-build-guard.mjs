import { assertProductionAutomation } from '../../src/lib/server/automation-policy.mjs'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const mainnetManifestPath = join(repoRoot, 'config/networks/arc-mainnet.json')
const SOURCE_LOCK_RELATIVE_PATH = 'config/networks/arc-mainnet.source-lock.json'
// Fixed, known paths. The lock cannot redirect the guard to another file.
const LOCKED_SOURCE_PATHS = {
  autoSaver: 'contracts/src/MovyAutoSaver.sol',
  savingsVault: 'contracts/src/MovySavings.sol',
}
const LOCKED_FOUNDRY_CONFIG_PATH = 'contracts/foundry.toml'
const CANONICAL_ARC_USDC = '0x3600000000000000000000000000000000000000'
const MAINNET_RUNTIME_IMPLEMENTED = true
// Arc's documented base fee floor (20 Gwei): https://docs.arc.io/arc/references/gas-and-fees
const MAINNET_MIN_BASE_FEE_FLOOR_WEI = 20_000_000_000n

export const TESTNET_RUNTIME_MARKERS = [
  'https://rpc.testnet.arc.io',
  'https://explorer.testnet.arc.io',
  '0xfc0a597c532173327350a3850d223e1f4ec5ff73',
  '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d',
]

const TESTNET_ENV_KEYS = [
  'ARC_TESTNET_RPC_URL',
  'NEXT_PUBLIC_MOVY_ADDRESS_TESTNET',
  'NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET',
  'NEXT_PUBLIC_DEMO_STORE_TESTNET',
  'NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_TESTNET',
  'NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL',
]

const REQUIRED_MAINNET_ENV = [
  'ARC_MAINNET_RPC_URL',
  'NEXT_PUBLIC_ARC_MAINNET_RPC_URL',
  'NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL',
  'NEXT_PUBLIC_MOVY_ADDRESS_MAINNET',
  'NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET',
  'NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET',
  'NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET',
  'MOVY_DATABASE_NETWORK',
  'MOVY_WORKER_ENABLED',
  'MOVY_RELAYER_ENABLED',
  'NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET',
  'NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET',
  'NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET',
  'NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET',
  'MOVY_RELAYER_MAX_FEE_PER_GAS_WEI',
  'MOVY_RELAYER_MAX_TX_FEE_WEI',
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value)
}

function assertHttpsUrl(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`)
  }
  assert(url.protocol === 'https:', `${label} must use HTTPS`)
  assert(!url.username && !url.password && !url.search && !url.hash, `${label} must not contain credentials, query, or fragment data`)
  assert(!/testnet/i.test(url.hostname), `${label} must not point to Testnet`)
}

function assertDeployment(deployment, label) {
  assert(deployment && typeof deployment === 'object', `${label} deployment record is missing`)
  assert(isAddress(deployment.address), `${label} address is missing or invalid`)
  assert(Number.isSafeInteger(deployment.deployBlock) && deployment.deployBlock > 0, `${label} deployBlock is missing or invalid`)
  assert(typeof deployment.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(deployment.transactionHash), `${label} transactionHash is missing or invalid`)
  assert(typeof deployment.runtimeCodeHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(deployment.runtimeCodeHash), `${label} runtimeCodeHash is missing or invalid`)
}

/**
 * The release source lock records the SHA-256 of the reviewed Solidity files and
 * foundry.toml, and the runtime code hash they compile to (with the canonical USDC
 * immutable substituted). It is public source fact, not deployment approval.
 */
export function assertSourceLock(lock) {
  assert(lock && typeof lock === 'object', 'Mainnet source lock is missing or invalid')
  assert(lock.schemaVersion === 1, 'Mainnet source lock schemaVersion must be 1')
  assert(lock.chainId === 5042, 'Mainnet source lock chainId must be 5042')
  assert(lock.usdcAddress === CANONICAL_ARC_USDC, 'Mainnet source lock USDC address must be the canonical Arc USDC')
  assert(typeof lock.foundryConfigSha256 === 'string' && /^[0-9a-f]{64}$/.test(lock.foundryConfigSha256), 'Mainnet source lock foundryConfigSha256 is invalid')
  for (const [name, sourcePath] of Object.entries(LOCKED_SOURCE_PATHS)) {
    const entry = lock.contracts?.[name]
    assert(entry && typeof entry === 'object', `Mainnet source lock is missing ${name}`)
    assert(entry.sourcePath === sourcePath, `Mainnet source lock ${name} sourcePath must be ${sourcePath}`)
    assert(typeof entry.sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sourceSha256), `Mainnet source lock ${name} sourceSha256 is invalid`)
    assert(typeof entry.runtimeCodeHash === 'string' && /^0x[0-9a-f]{64}$/.test(entry.runtimeCodeHash), `Mainnet source lock ${name} runtimeCodeHash is invalid`)
    assert(Number.isSafeInteger(entry.runtimeBytes) && entry.runtimeBytes > 0, `Mainnet source lock ${name} runtimeBytes is invalid`)
  }
  return lock
}

export function readSourceLock(root = repoRoot) {
  const lockPath = join(root, SOURCE_LOCK_RELATIVE_PATH)
  assert(existsSync(lockPath), `Mainnet-targeted build refused: ${SOURCE_LOCK_RELATIVE_PATH} is missing`)
  let lock
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    throw new Error(`Mainnet-targeted build refused: ${SOURCE_LOCK_RELATIVE_PATH} is invalid JSON`)
  }
  return assertSourceLock(lock)
}

function sha256File(root, relativePath) {
  const filePath = join(root, relativePath)
  assert(existsSync(filePath), `Mainnet-targeted build refused: locked source file ${relativePath} is missing`)
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** Confirms the actual local Solidity files and foundry.toml are the ones the lock describes. */
export function verifyLocalSourceFiles(lock, root = repoRoot) {
  assertSourceLock(lock)
  for (const [name, sourcePath] of Object.entries(LOCKED_SOURCE_PATHS)) {
    assert(sha256File(root, sourcePath) === lock.contracts[name].sourceSha256, `Mainnet-targeted build refused: ${sourcePath} does not match the release source lock`)
  }
  assert(sha256File(root, LOCKED_FOUNDRY_CONFIG_PATH) === lock.foundryConfigSha256, `Mainnet-targeted build refused: ${LOCKED_FOUNDRY_CONFIG_PATH} does not match the release source lock`)
  return true
}

export function validateMainnetManifest(manifest, sourceLock = readSourceLock()) {
  assert(manifest && typeof manifest === 'object', 'Mainnet manifest must be a JSON object')
  assert(manifest.schemaVersion === 2, 'Mainnet manifest schemaVersion must be 2')
  assert(manifest.network === 'arc-mainnet', 'Mainnet manifest network must be arc-mainnet')
  assert(manifest.status === 'owner-verified', 'Mainnet manifest must be owner-verified')
  assert(manifest.chainId === 5042, 'Mainnet manifest chainId must be 5042')
  assertHttpsUrl(manifest.rpcUrl, 'Mainnet RPC URL')
  assertHttpsUrl(manifest.explorerUrl, 'Mainnet explorer URL')
  assert(manifest.usdcAddress === '0x3600000000000000000000000000000000000000', 'Mainnet USDC address does not match the reviewed Arc USDC interface')
  const feePolicy = manifest.feePolicy
  const validFee = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) < 2n ** 256n
  assert(validFee(feePolicy?.minBaseFeePerGasWei), 'Mainnet fee policy minimum base fee is missing or invalid')
  assert(validFee(feePolicy?.maxFeePerGasWei), 'Mainnet fee policy maximum fee is missing or invalid')
  assert(validFee(feePolicy?.priorityFeePerGasWei), 'Mainnet fee policy priority fee is missing or invalid')
  assert(validFee(feePolicy?.maxTransactionFeeWei), 'Mainnet fee policy transaction ceiling is missing or invalid')
  assert(BigInt(feePolicy.minBaseFeePerGasWei) >= MAINNET_MIN_BASE_FEE_FLOOR_WEI, 'Mainnet fee policy minimum base fee is below the 20 Gwei Arc floor')
  assert(BigInt(feePolicy.maxFeePerGasWei) >= BigInt(feePolicy.minBaseFeePerGasWei), 'Mainnet fee policy maximum fee is below its minimum base fee')
  assert(BigInt(feePolicy.priorityFeePerGasWei) <= BigInt(feePolicy.maxFeePerGasWei), 'Mainnet fee policy priority exceeds its maximum fee')

  const contracts = manifest.contracts
  assertDeployment(contracts?.autoSaver, 'AutoSaver')
  assertDeployment(contracts?.savingsVault, 'Savings vault')
  // The manifest cannot select bytecode other than what the reviewed source compiles to,
  // regardless of any approval flag below.
  assertSourceLock(sourceLock)
  assert(contracts.autoSaver.runtimeCodeHash.toLowerCase() === sourceLock.contracts.autoSaver.runtimeCodeHash, 'AutoSaver runtimeCodeHash does not match the release source lock')
  assert(contracts.savingsVault.runtimeCodeHash.toLowerCase() === sourceLock.contracts.savingsVault.runtimeCodeHash, 'Savings vault runtimeCodeHash does not match the release source lock')
  const roles = contracts.autoSaver.roles
  assert(roles && roles.verified === true, 'AutoSaver owner and relayer roles must be independently verified')
  assert(isAddress(roles.owner) && isAddress(roles.relayer), 'AutoSaver owner and relayer addresses are required')
  assert(roles.owner.toLowerCase() !== roles.relayer.toLowerCase(), 'AutoSaver owner and relayer must be separately controlled')
  const developmentAddresses = new Set([
    '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
    '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  ])
  assert(!developmentAddresses.has(roles.owner.toLowerCase()) && !developmentAddresses.has(roles.relayer.toLowerCase()), 'Mainnet roles cannot use known development keys')

  const verification = manifest.verification
  assert(verification?.ownerApproved === true, 'Mainnet manifest needs explicit owner approval')
  assert(typeof verification.approvedBy === 'string' && verification.approvedBy.trim(), 'Mainnet manifest needs an approver')
  assert(typeof verification.approvedAt === 'string' && !Number.isNaN(Date.parse(verification.approvedAt)), 'Mainnet manifest needs an approval timestamp')
  assert(Array.isArray(verification.evidenceUrls) && verification.evidenceUrls.length >= 2, 'Mainnet manifest needs official-source and read-only RPC evidence URLs')
  for (const [index, evidenceUrl] of verification.evidenceUrls.entries()) assertHttpsUrl(evidenceUrl, `Mainnet evidence URL ${index + 1}`)
  assert(verification.observedRpcChainId === 5042, 'Mainnet manifest needs a read-only RPC check for chain 5042')
  assert(validFee(verification.observedGasPriceWei), 'Mainnet manifest needs a read-only observed gas price')
  assert(BigInt(verification.observedGasPriceWei) <= BigInt(feePolicy.maxFeePerGasWei), 'Mainnet observed gas price exceeds the approved fee ceiling')
  assert(typeof verification.observedBlock === 'string' && /^\d+$/.test(verification.observedBlock), 'Mainnet manifest needs the observed Mainnet block number')
  assert(typeof verification.observedAt === 'string' && !Number.isNaN(Date.parse(verification.observedAt)), 'Mainnet manifest needs the RPC observation timestamp')

  return manifest
}

function resolveTargetNetwork(env) {
  const target = env.MOVY_TARGET_NETWORK ?? env.NEXT_PUBLIC_MOVY_TARGET_NETWORK ?? 'testnet'
  assert(target === 'testnet' || target === 'mainnet', 'MOVY_TARGET_NETWORK must be testnet or mainnet')
  if (env.MOVY_TARGET_NETWORK && env.NEXT_PUBLIC_MOVY_TARGET_NETWORK) {
    assert(env.MOVY_TARGET_NETWORK === env.NEXT_PUBLIC_MOVY_TARGET_NETWORK, 'Server and browser network targets do not match')
  }
  return target
}

export function assertBuildNetworkPreflight({
  env = process.env,
  manifest,
  runtimeImplemented = MAINNET_RUNTIME_IMPLEMENTED,
  sourceRoot = repoRoot,
} = {}) {
  assert(env.MOVY_LOCAL_ARC_CERTIFICATION !== 'true', 'Production build refused: local Arc certification mode is enabled')
  const target = resolveTargetNetwork(env)
  const configuredChainId = env.NEXT_PUBLIC_MOVY_CHAIN_ID
  if (env.MOVY_NETWORK) assert(env.MOVY_NETWORK === target, 'MOVY_NETWORK does not match the build target')

  if (target === 'testnet') {
    assert(!configuredChainId || configuredChainId === '5042002', 'Testnet build has a conflicting public chain ID')
    return { target }
  }

  assert(manifest, `Mainnet-targeted build refused: ${mainnetManifestPath.slice(repoRoot.length + 1)} is missing or has not been provided`)
  // Testnet builds returned above and never read the lock. Mainnet fails closed on a missing or invalid lock.
  const sourceLock = readSourceLock(sourceRoot)
  validateMainnetManifest(manifest, sourceLock)
  verifyLocalSourceFiles(sourceLock, sourceRoot)

  assert(env.MOVY_TARGET_NETWORK === 'mainnet', 'Mainnet-targeted build refused: MOVY_TARGET_NETWORK must be explicitly mainnet')
  assert(env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet', 'Mainnet-targeted build refused: NEXT_PUBLIC_MOVY_TARGET_NETWORK must be explicitly mainnet')
  assert(env.NEXT_PUBLIC_MOVY_CHAIN_ID === '5042', 'Mainnet-targeted build refused: NEXT_PUBLIC_MOVY_CHAIN_ID must be explicitly 5042')
  assert(env.MOVY_DATABASE_NETWORK === 'mainnet', 'Mainnet-targeted build refused: MOVY_DATABASE_NETWORK must be explicitly mainnet')
  assertProductionAutomation(env, target, manifest.contracts.autoSaver)
  assert(env.MOVY_DEMO_MERCHANT_PAYMENT_ENABLED !== 'true', 'Mainnet-targeted build refused: merchant checkout must remain disabled pending a separate reviewed activation')

  for (const key of TESTNET_ENV_KEYS) {
    assert(!env[key], `Mainnet-targeted build refused: Testnet configuration ${key} is still set`)
  }
  for (const [key, value] of Object.entries(env)) {
    if (/(?:^|_)TESTNET(?:_|$)/i.test(key) && value) {
      assert(false, `Mainnet-targeted build refused: Testnet configuration ${key} is still set`)
    }
  }
  const expectedValues = {
    ARC_MAINNET_RPC_URL: manifest.rpcUrl,
    NEXT_PUBLIC_ARC_MAINNET_RPC_URL: manifest.rpcUrl,
    NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL: manifest.explorerUrl,
    NEXT_PUBLIC_MOVY_ADDRESS_MAINNET: manifest.contracts.savingsVault.address,
    NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET: manifest.contracts.autoSaver.address,
    NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET: String(manifest.contracts.savingsVault.deployBlock),
    NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET: String(manifest.contracts.autoSaver.deployBlock),
    NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.minBaseFeePerGasWei,
    NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.maxFeePerGasWei,
    NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.priorityFeePerGasWei,
    NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: manifest.feePolicy.maxTransactionFeeWei,
    MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: manifest.feePolicy.maxFeePerGasWei,
    MOVY_RELAYER_MAX_TX_FEE_WEI: manifest.feePolicy.maxTransactionFeeWei,
  }
  for (const key of REQUIRED_MAINNET_ENV) {
    assert(env[key], `Mainnet-targeted build refused: verified configuration is missing ${key}`)
  }
  for (const [key, value] of Object.entries(expectedValues)) {
    assert(env[key] === value, `Mainnet-targeted build refused: ${key} does not match the verified manifest`)
  }

  assert(runtimeImplemented, 'Mainnet-targeted build refused: the wallet, API, worker, and runtime code is still Testnet-only')
  return { target, manifest }
}

function collectFiles(directory, result = []) {
  if (!existsSync(directory)) return result
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name)
    if (entry.isDirectory()) collectFiles(filePath, result)
    else if (entry.isFile()) result.push(filePath)
  }
  return result
}

// Manifest fields that hold accounts (EOAs) or shared network-neutral addresses, not Testnet contracts.
// EOAs are not network-specific: a compromised development key stays rejected by the compromised-key
// logic on every network, so it must not be treated as Testnet configuration in a Mainnet bundle.
const NON_CONTRACT_MANIFEST_KEYS = new Set(['usdcaddress', 'owner', 'deployer', 'relayer', 'signer', 'admin'])

export function collectTestnetContractAddresses(manifestValue) {
  const addresses = []
  const visit = (value, parentKey = '') => {
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) visit(nested, key)
    } else if (
      typeof value === 'string' &&
      !NON_CONTRACT_MANIFEST_KEYS.has(parentKey.toLowerCase()) &&
      /^0x[0-9a-fA-F]{40}$/.test(value)
    ) {
      addresses.push(value.toLowerCase())
    }
  }
  visit(manifestValue)
  return addresses
}

function collectTestnetDeploymentAddresses(root) {
  return collectFiles(join(root, 'contracts'))
    .filter((filePath) => /testnet.*\.json$/i.test(filePath))
    .flatMap((filePath) => {
      let deployment
      try {
        deployment = JSON.parse(readFileSync(filePath, 'utf8'))
      } catch {
        return []
      }
      return collectTestnetContractAddresses(deployment)
    })
}

/**
 * Source maps describe original source text, not executable runtime, so they are not scanned.
 * Public assets are always scanned, even when a file uses a .map extension.
 */
export function isRuntimeScanFile(filePath) {
  return !/\.map$/i.test(filePath) || /(?:^|[\\/])public[\\/]/i.test(filePath)
}

export function assertNoTestnetRuntime(root = repoRoot) {
  const runtimeDirectories = [
    join(root, '.next/server'),
    join(root, '.next/static'),
    join(root, 'public'),
  ]
  const markers = [...TESTNET_RUNTIME_MARKERS, ...collectTestnetDeploymentAddresses(root)]
  const hits = []
  for (const filePath of runtimeDirectories.flatMap((directory) => collectFiles(directory)).filter(isRuntimeScanFile)) {
    const contents = readFileSync(filePath).toString('utf8').toLowerCase()
    for (const marker of markers) {
      if (contents.includes(marker.toLowerCase())) hits.push({ filePath, marker })
    }
  }

  assert(hits.length === 0, `Mainnet runtime contains Testnet configuration: ${hits.map((hit) => `${hit.marker} in ${hit.filePath}`).join('; ')}`)
  return true
}

function readManifest() {
  if (!existsSync(mainnetManifestPath)) return null
  try {
    return JSON.parse(readFileSync(mainnetManifestPath, 'utf8'))
  } catch {
    throw new Error('Mainnet-targeted build refused: the committed Mainnet manifest is invalid JSON')
  }
}

function run(mode) {
  if (mode !== 'prebuild' && mode !== 'postbuild') throw new Error('Use prebuild or postbuild')
  const result = assertBuildNetworkPreflight({ env: process.env, manifest: readManifest() })
  if (mode === 'postbuild' && result.target === 'mainnet') assertNoTestnetRuntime(repoRoot)
  console.log(`Network build ${mode} check passed for ${result.target}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv[2] ?? 'prebuild')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Network build check failed')
    process.exitCode = 1
  }
}
