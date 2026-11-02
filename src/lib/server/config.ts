import { defineChain, isAddress } from 'viem'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { assertProductionAutomation } from './automation-policy.mjs'
import { ARC_MAINNET_RPC_URL, type ArcNetwork } from '../chain'
// Statically bundled so the deployed runtime needs no Solidity source files. The lock is public
// source fact (reviewed source hashes and the runtime code hashes they compile to), not approval.
import mainnetSourceLock from '../../../config/networks/arc-mainnet.source-lock.json'

export const CHAIN_TESTNET_ID = 5042002
export const CHAIN_MAINNET_ID = 5042
export const CANONICAL_ARC_USDC = '0x3600000000000000000000000000000000000000' as const
export const SYSTEM_USDC_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE' as const

export const CHAIN_TESTNET = defineChain({
  id: CHAIN_TESTNET_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_TESTNET_RPC_URL || ''] } },
  blockExplorers: {
    default: { name: 'Arc Testnet Explorer', url: process.env.NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL || '' },
  },
})

export const CHAIN_MAINNET = defineChain({
  id: CHAIN_MAINNET_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_MAINNET_RPC_URL || ARC_MAINNET_RPC_URL] } },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL || 'https://explorer.arc.io' },
  },
})

/** Arc's documented base fee floor (20 Gwei). Mainnet fee policy may not set a lower minimum. */
const MAINNET_MIN_BASE_FEE_FLOOR_WEI = 20_000_000_000n
/**
 * Compile-time target. `process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK` is inlined by the bundler, so
 * every `=== 'mainnet'` condition below is a constant in a production Mainnet build and the
 * Testnet-only validation and denylist code behind it is removed. Each site repeats the direct
 * expression on purpose: a shared variable would hide the constant from the minifier.
 *
 * Removing that code never weakens validation: a Mainnet-compiled build refuses any Testnet
 * runtime selection outright (see getConfiguredNetwork and the TESTNET_UNAVAILABLE failures).
 */
const MAINNET_BUILD_REFUSES_TESTNET = 'This build is compiled for Arc Mainnet and refuses any Testnet runtime selection'

const MAINNET_MANIFEST_PATH = join(process.cwd(), 'config', 'networks', 'arc-mainnet.json')
const ZERO_ADDRESS = /^0x0{40}$/i

export type MainnetManifest = {
  schemaVersion: number
  network: string
  status: string
  chainId: number
  rpcUrl: string
  explorerUrl: string
  usdcAddress: string
  feePolicy: {
    minBaseFeePerGasWei: string
    maxFeePerGasWei: string
    priorityFeePerGasWei: string
    maxTransactionFeeWei: string
  }
  contracts: {
    autoSaver: {
      address: string
      deployBlock: number
      transactionHash: string
      runtimeCodeHash: string
      roles: { owner: string; relayer: string; verified: boolean }
    }
    savingsVault: { address: string; deployBlock: number; transactionHash: string; runtimeCodeHash: string }
  }
  verification: {
    ownerApproved: boolean
    approvedBy: string
    approvedAt: string
    evidenceUrls: string[]
    observedRpcChainId: number
    observedBlock: string
    observedGasPriceWei: string
    observedAt: string
  }
}

type MainnetSourceLockEntry = { runtimeCodeHash: string }

/** Release runtime code hashes from the bundled source lock; fails closed if the lock is malformed. */
function readMainnetSourceLockHashes(): { autoSaver: string; savingsVault: string } {
  const lock = mainnetSourceLock as {
    schemaVersion?: number
    chainId?: number
    usdcAddress?: string
    contracts?: { autoSaver?: MainnetSourceLockEntry; savingsVault?: MainnetSourceLockEntry }
  }
  const hashPattern = /^0x[0-9a-f]{64}$/
  const autoSaver = lock.contracts?.autoSaver?.runtimeCodeHash
  const savingsVault = lock.contracts?.savingsVault?.runtimeCodeHash
  if (
    lock.schemaVersion !== 1 ||
    lock.chainId !== CHAIN_MAINNET_ID ||
    lock.usdcAddress?.toLowerCase() !== CANONICAL_ARC_USDC.toLowerCase() ||
    typeof autoSaver !== 'string' || !hashPattern.test(autoSaver) ||
    typeof savingsVault !== 'string' || !hashPattern.test(savingsVault)
  ) {
    throw new Error('Arc Mainnet source lock is missing or invalid')
  }
  return { autoSaver, savingsVault }
}

export function readOwnerVerifiedMainnetManifest(): MainnetManifest {
  if (!existsSync(MAINNET_MANIFEST_PATH)) {
    throw new Error('Owner-verified Arc Mainnet deployment manifest is missing')
  }
  let manifest: MainnetManifest
  try {
    manifest = JSON.parse(readFileSync(MAINNET_MANIFEST_PATH, 'utf8')) as MainnetManifest
  } catch {
    throw new Error('Arc Mainnet deployment manifest is invalid JSON')
  }
  const autoSaver = manifest.contracts?.autoSaver
  const vault = manifest.contracts?.savingsVault
  const feePolicy = manifest.feePolicy
  const verification = manifest.verification
  const addressPattern = /^0x[0-9a-fA-F]{40}$/
  const codeHashPattern = /^0x[0-9a-fA-F]{64}$/
  const validFee = (value: unknown): value is string =>
    typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) < 2n ** 256n
  const rpc = new URL(manifest.rpcUrl)
  const explorer = new URL(manifest.explorerUrl)
  if (
    manifest.schemaVersion !== 2 ||
    manifest.network !== 'arc-mainnet' ||
    manifest.status !== 'owner-verified' ||
    manifest.chainId !== CHAIN_MAINNET_ID ||
    rpc.protocol !== 'https:' || /testnet/i.test(rpc.hostname) || rpc.username || rpc.password || rpc.search || rpc.hash ||
    explorer.protocol !== 'https:' || /testnet/i.test(explorer.hostname) || explorer.username || explorer.password || explorer.search || explorer.hash ||
    manifest.usdcAddress?.toLowerCase() !== CANONICAL_ARC_USDC.toLowerCase() ||
    !feePolicy ||
    !validFee(feePolicy.minBaseFeePerGasWei) ||
    !validFee(feePolicy.maxFeePerGasWei) ||
    !validFee(feePolicy.priorityFeePerGasWei) ||
    !validFee(feePolicy.maxTransactionFeeWei) ||
    BigInt(feePolicy.minBaseFeePerGasWei) < MAINNET_MIN_BASE_FEE_FLOOR_WEI ||
    BigInt(feePolicy.maxFeePerGasWei) < BigInt(feePolicy.minBaseFeePerGasWei) ||
    BigInt(feePolicy.priorityFeePerGasWei) > BigInt(feePolicy.maxFeePerGasWei) ||
    !verification || verification.ownerApproved !== true || !verification.approvedBy?.trim() ||
    !Number.isFinite(Date.parse(verification.approvedAt)) ||
    !Array.isArray(verification.evidenceUrls) || verification.evidenceUrls.length < 2 ||
    verification.evidenceUrls.some((evidence) => {
      try {
        const evidenceUrl = new URL(evidence)
        return evidenceUrl.protocol !== 'https:' || /testnet/i.test(evidenceUrl.hostname) || evidenceUrl.username !== '' || evidenceUrl.password !== '' || evidenceUrl.search !== '' || evidenceUrl.hash !== ''
      } catch { return true }
    }) ||
    verification.observedRpcChainId !== CHAIN_MAINNET_ID ||
    !/^\d+$/.test(verification.observedBlock) || BigInt(verification.observedBlock) < 1n ||
    !Number.isFinite(Date.parse(verification.observedAt)) ||
    !validFee(verification.observedGasPriceWei) ||
    BigInt(verification.observedGasPriceWei) > BigInt(feePolicy.maxFeePerGasWei) ||
    !autoSaver || !vault ||
    !addressPattern.test(autoSaver.address) || ZERO_ADDRESS.test(autoSaver.address) ||
    !addressPattern.test(vault.address) || ZERO_ADDRESS.test(vault.address) ||
    !Number.isSafeInteger(autoSaver.deployBlock) || autoSaver.deployBlock < 1 ||
    !Number.isSafeInteger(vault.deployBlock) || vault.deployBlock < 1 ||
    !/^0x[0-9a-fA-F]{64}$/.test(autoSaver.transactionHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(vault.transactionHash) ||
    !codeHashPattern.test(autoSaver.runtimeCodeHash) || !codeHashPattern.test(vault.runtimeCodeHash) ||
    autoSaver.roles?.verified !== true ||
    !addressPattern.test(autoSaver.roles.owner) || ZERO_ADDRESS.test(autoSaver.roles.owner) ||
    !addressPattern.test(autoSaver.roles.relayer) || ZERO_ADDRESS.test(autoSaver.roles.relayer) ||
    autoSaver.roles.owner.toLowerCase() === autoSaver.roles.relayer.toLowerCase()
  ) {
    throw new Error('Arc Mainnet manifest has incomplete deployments or unverified AutoSaver roles')
  }
  const lockedHashes = readMainnetSourceLockHashes()
  if (
    autoSaver.runtimeCodeHash.toLowerCase() !== lockedHashes.autoSaver ||
    vault.runtimeCodeHash.toLowerCase() !== lockedHashes.savingsVault
  ) {
    throw new Error('Arc Mainnet manifest runtime code hash does not match the release source lock')
  }
  const knownDevelopmentAddresses = new Set([
    '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
    '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  ])
  if (knownDevelopmentAddresses.has(autoSaver.roles.owner.toLowerCase()) || knownDevelopmentAddresses.has(autoSaver.roles.relayer.toLowerCase())) {
    throw new Error('Arc Mainnet manifest cannot use a known development signer')
  }
  return manifest
}

export function getConfiguredNetwork(env: NodeJS.ProcessEnv = process.env): ArcNetwork {
  const serverTarget = env.MOVY_TARGET_NETWORK
  const browserTarget = env.NEXT_PUBLIC_MOVY_TARGET_NETWORK
  const isProduction = env.NODE_ENV === 'production'
  if (serverTarget !== undefined && serverTarget !== 'mainnet' && serverTarget !== 'testnet') {
    throw new Error('MOVY_TARGET_NETWORK must be mainnet or testnet')
  }
  if (browserTarget !== undefined && browserTarget !== 'mainnet' && browserTarget !== 'testnet') {
    throw new Error('NEXT_PUBLIC_MOVY_TARGET_NETWORK must be mainnet or testnet')
  }
  if (isProduction && (!serverTarget || !browserTarget || !env.NEXT_PUBLIC_MOVY_CHAIN_ID)) {
    throw new Error('Production requires explicit server/browser network targets and NEXT_PUBLIC_MOVY_CHAIN_ID')
  }
  const network = (serverTarget ?? browserTarget ?? 'testnet') as ArcNetwork
  if (serverTarget !== undefined && browserTarget !== undefined && serverTarget !== browserTarget) {
    throw new Error('Server and browser network targets do not match')
  }
  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet' && network !== 'mainnet') {
    throw new Error(MAINNET_BUILD_REFUSES_TESTNET)
  }
  const chainId = getChainIdForNetwork(network)
  if (env.NEXT_PUBLIC_MOVY_CHAIN_ID !== undefined && env.NEXT_PUBLIC_MOVY_CHAIN_ID !== String(chainId)) {
    throw new Error(`NEXT_PUBLIC_MOVY_CHAIN_ID must be ${chainId} for ${network}`)
  }
  const databaseNetwork = env.MOVY_DATABASE_NETWORK
  if (databaseNetwork !== undefined && databaseNetwork !== 'mainnet' && databaseNetwork !== 'testnet') {
    throw new Error('MOVY_DATABASE_NETWORK must be mainnet or testnet')
  }
  if (isProduction && databaseNetwork !== network) {
    throw new Error('Production MOVY_DATABASE_NETWORK must match the selected network')
  }
  if (databaseNetwork !== undefined && databaseNetwork !== network) {
    throw new Error('MOVY_DATABASE_NETWORK must match the selected network')
  }
  if (isProduction && network !== 'mainnet') assertProductionAutomation(env, network)
  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK !== 'mainnet' && isProduction && network === 'testnet') {
    const deployment = readTestnetDeployment()
    if (
      !env.ARC_TESTNET_RPC_URL || !env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ||
      env.NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL !== 'https://explorer.testnet.arc.io' ||
      env.ARC_TESTNET_RPC_URL !== env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ||
      !deployment || deployment.network !== 'testnet' || deployment.chainId !== CHAIN_TESTNET_ID ||
      env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET?.toLowerCase() !== deployment.contractAddress?.toLowerCase() ||
      env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK !== String(deployment.deployBlock)
    ) {
      throw new Error('Production Testnet configuration does not match its isolated deployment manifest')
    }
  }
  if (isProduction && network === 'mainnet') {
    // Testnet isolation is checked first so it fails specifically, before the owner-verified
    // Mainnet manifest is loaded. Every Mainnet guard below still runs.
    const testnetKeys = [
      'ARC_TESTNET_RPC_URL',
      'NEXT_PUBLIC_ARC_TESTNET_RPC_URL',
      'NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL',
      'NEXT_PUBLIC_MOVY_ADDRESS_TESTNET',
      'NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET',
      'NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_TESTNET',
      'MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK',
      'NEXT_PUBLIC_DEMO_STORE_TESTNET',
    ]
    for (const key of testnetKeys) {
      if (env[key]) throw new Error(`Production Mainnet runtime refuses Testnet configuration ${key}`)
    }
    for (const [key, value] of Object.entries(env)) {
      if (/(?:^|_)TESTNET(?:_|$)/i.test(key) && value) {
        throw new Error(`Production Mainnet runtime refuses Testnet configuration ${key}`)
      }
    }
    const manifest = readOwnerVerifiedMainnetManifest()
    assertProductionAutomation(env, network, manifest.contracts.autoSaver)
    const expected = {
      ARC_MAINNET_RPC_URL: manifest.rpcUrl,
      NEXT_PUBLIC_ARC_MAINNET_RPC_URL: manifest.rpcUrl,
      NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL: manifest.explorerUrl,
      NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET: manifest.contracts.autoSaver.address,
      NEXT_PUBLIC_MOVY_ADDRESS_MAINNET: manifest.contracts.savingsVault.address,
      NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET: String(manifest.contracts.autoSaver.deployBlock),
      NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET: String(manifest.contracts.savingsVault.deployBlock),
      NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.minBaseFeePerGasWei,
      NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.maxFeePerGasWei,
      NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.priorityFeePerGasWei,
      NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: manifest.feePolicy.maxTransactionFeeWei,
      MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: manifest.feePolicy.maxFeePerGasWei,
      MOVY_RELAYER_MAX_TX_FEE_WEI: manifest.feePolicy.maxTransactionFeeWei,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (env[key] !== value) throw new Error(`Production ${key} does not match the owner-verified Arc Mainnet manifest`)
    }
  }
  return network
}

export function getChainIdForNetwork(network: ArcNetwork): number {
  return network === 'mainnet' ? CHAIN_MAINNET_ID : CHAIN_TESTNET_ID
}

export function getActiveChainId(env: NodeJS.ProcessEnv = process.env): number {
  return getChainIdForNetwork(getConfiguredNetwork(env))
}

export function getNetworkForChainId(chainId: number): ArcNetwork {
  if (chainId === CHAIN_MAINNET_ID) return 'mainnet'
  if (chainId === CHAIN_TESTNET_ID) return 'testnet'
  throw new Error(`Unsupported Arc chain ID: ${chainId}`)
}

export function assertConfiguredChainId(chainId: number): void {
  const activeChainId = getActiveChainId()
  if (chainId !== activeChainId) {
    throw new Error(`Requested chain ${chainId} does not match this MOVY deployment (chain ${activeChainId})`)
  }
}

function validateRpcUrl(network: ArcNetwork, value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Arc ${network} RPC URL is invalid`)
  }
  const localCertification = process.env.MOVY_LOCAL_ARC_CERTIFICATION === 'true'
  if (localCertification && process.env.NODE_ENV === 'production') {
    throw new Error('Local Arc certification mode is disabled in production')
  }
  const loopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const localDevelopmentRpc = process.env.NODE_ENV !== 'production' && loopbackHost && url.protocol === 'http:'
  if (url.protocol !== 'https:' && !localDevelopmentRpc) {
    throw new Error(`Arc ${network} RPC URL must use HTTPS`)
  }
  if (network === 'mainnet' && /testnet/i.test(url.hostname)) {
    throw new Error('Arc Mainnet RPC URL must not point to Testnet')
  }
  if (network === 'testnet' && /mainnet/i.test(url.hostname)) {
    throw new Error('Arc Testnet RPC URL must not point to Mainnet')
  }
  if (url.username || url.password || url.hash) throw new Error(`Arc ${network} RPC URL has unsupported components`)
  return url.toString()
}

export function getRpcUrlForChainId(chainId: number): string {
  const network = getNetworkForChainId(chainId)
  assertConfiguredChainId(chainId)
  if (network === 'mainnet') {
    if (process.env.NODE_ENV === 'production' && (!process.env.ARC_MAINNET_RPC_URL || !process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL)) {
      throw new Error('Production Arc Mainnet RPC URL is not configured')
    }
    const serverUrl = process.env.ARC_MAINNET_RPC_URL || ARC_MAINNET_RPC_URL
    const browserUrl = process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL || ARC_MAINNET_RPC_URL
    if (serverUrl !== browserUrl) throw new Error('Server and browser Arc Mainnet RPC URLs do not match')
    return validateRpcUrl(network, serverUrl)
  }
  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet') throw new Error(MAINNET_BUILD_REFUSES_TESTNET)
  const serverUrl = process.env.ARC_TESTNET_RPC_URL
  const browserUrl = process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL
  if (!serverUrl || !browserUrl) throw new Error('Arc Testnet server and browser RPC URLs are required')
  if (serverUrl !== browserUrl) throw new Error('Server and browser Arc Testnet RPC URLs do not match')
  return validateRpcUrl(network, serverUrl)
}

/** Public deployment manifests for Arc Testnet, relative to `contracts/`. */
export const TESTNET_LEGACY_MANIFEST_FILE = 'deployed-testnet.json'
export const TESTNET_FRESH_MANIFEST_FILE = 'deployed-testnet-fresh.json'

/** Known compromised development identity and the AutoSaver it deployed. */
const COMPROMISED_DEVELOPMENT_ADDRESS = process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet'
  ? ''
  : '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
const COMPROMISED_TESTNET_AUTO_SAVER = process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet'
  ? ''
  : '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d'

type TestnetDeployment = {
  network?: string
  chainId?: number
  contractAddress?: string
  deployBlock?: number
}

/**
 * Strict validation of the fresh Arc Testnet AutoSaver manifest. It throws on any
 * missing, malformed, or unsafe field; the caller must never fall back to another
 * manifest after a failure.
 */
export function validateFreshTestnetDeploymentManifest(value: unknown): Required<TestnetDeployment> & {
  deployTxHash: string
  owner: string
  deployer: string
  relayer: string
  usdcAddress: string
} {
  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet') throw new Error(MAINNET_BUILD_REFUSES_TESTNET)
  const fail = (reason: string): never => {
    throw new Error(`Fresh Arc Testnet deployment manifest is malformed or unsafe: ${reason}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('not an object')
  const manifest = value as Record<string, unknown>
  if (manifest.network !== 'testnet') fail('network must be testnet')
  if (manifest.chainId !== CHAIN_TESTNET_ID) fail('chainId must be 5042002')
  const address = (field: string): string => {
    const candidate = manifest[field]
    if (typeof candidate !== 'string' || !isAddress(candidate) || ZERO_ADDRESS.test(candidate)) {
      return fail(`${field} must be a valid nonzero address`)
    }
    return candidate
  }
  const contractAddress = address('contractAddress')
  const owner = address('owner')
  const deployer = address('deployer')
  const relayer = address('relayer')
  const usdcAddress = address('usdcAddress')
  if (usdcAddress.toLowerCase() !== CANONICAL_ARC_USDC) fail('usdcAddress must be the canonical Arc USDC')
  if (typeof manifest.deployBlock !== 'number' || !Number.isSafeInteger(manifest.deployBlock) || manifest.deployBlock <= 0) {
    fail('deployBlock must be a positive integer')
  }
  if (typeof manifest.deployTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(manifest.deployTxHash)) {
    fail('deployTxHash must be a 32-byte hash')
  }
  if (owner.toLowerCase() !== deployer.toLowerCase()) fail('owner must equal deployer')
  if (owner.toLowerCase() === relayer.toLowerCase()) fail('owner and relayer must be distinct')
  for (const role of [owner, deployer, relayer]) {
    if (role.toLowerCase() === COMPROMISED_DEVELOPMENT_ADDRESS) fail('a role uses the known compromised development address')
  }
  if (contractAddress.toLowerCase() === COMPROMISED_TESTNET_AUTO_SAVER) fail('contractAddress is the known compromised AutoSaver')
  return {
    network: 'testnet',
    chainId: CHAIN_TESTNET_ID,
    contractAddress,
    deployBlock: manifest.deployBlock as number,
    deployTxHash: manifest.deployTxHash as string,
    owner,
    deployer,
    relayer,
    usdcAddress,
  }
}

/**
 * Selects the Arc Testnet manifest. `contracts/deployed-testnet-fresh.json` wins when
 * it exists and must validate strictly; a bad fresh file fails closed and never falls
 * back to the old manifest. Only when it is absent is the old manifest used, as a
 * read-only compatibility record (the connected product keeps its address write-blocked).
 */
function readTestnetDeployment(): TestnetDeployment | null {
  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet') throw new Error(MAINNET_BUILD_REFUSES_TESTNET)
  const contractsDir = join(process.cwd(), 'contracts')
  const freshFile = join(contractsDir, TESTNET_FRESH_MANIFEST_FILE)
  if (existsSync(freshFile)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(freshFile, 'utf8'))
    } catch {
      throw new Error('Fresh Arc Testnet deployment manifest is malformed or unsafe: not valid JSON')
    }
    return validateFreshTestnetDeploymentManifest(parsed)
  }
  const deployedFile = join(contractsDir, TESTNET_LEGACY_MANIFEST_FILE)
  if (!existsSync(deployedFile)) return null
  try {
    return JSON.parse(readFileSync(deployedFile, 'utf8')) as TestnetDeployment
  } catch {
    return null
  }
}

/**
 * The signed local Arc certification deploys a new AutoSaver for each run.
 * That disposable address cannot be added to the checked-in public Testnet
 * manifest. Permit it only under the explicit non-production certification
 * flag and only when both configured Testnet RPCs are the same HTTP loopback
 * endpoint. Normal development and production continue to use the manifest.
 */
function readLocalArcCertificationDeployment(chainId: number): { address: `0x${string}`; deployBlock: number } | null {
  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet') throw new Error(MAINNET_BUILD_REFUSES_TESTNET)
  if (process.env.MOVY_LOCAL_ARC_CERTIFICATION !== 'true') return null
  if (process.env.NODE_ENV === 'production') throw new Error('Local Arc certification deployment is disabled in production')
  if (chainId !== CHAIN_TESTNET_ID || getConfiguredNetwork() !== 'testnet') {
    throw new Error('Local Arc certification deployment is available only for the Testnet worker gate')
  }

  const serverRpcUrl = process.env.ARC_TESTNET_RPC_URL
  const browserRpcUrl = process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL
  if (!serverRpcUrl || !browserRpcUrl || serverRpcUrl !== browserRpcUrl) {
    throw new Error('Local Arc certification server and browser RPC URLs must match')
  }
  let endpoint: URL
  try {
    endpoint = new URL(serverRpcUrl)
  } catch {
    throw new Error('Local Arc certification requires a loopback RPC URL')
  }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Local Arc certification requires a loopback RPC URL')
  }

  const address = process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET
  const deployBlockRaw = process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || ZERO_ADDRESS.test(address)) {
    throw new Error('Local Arc certification AutoSaver address is missing or invalid')
  }
  if (!deployBlockRaw || !/^[1-9][0-9]*$/.test(deployBlockRaw)) {
    throw new Error('Local Arc certification deploy block is missing or invalid')
  }
  const deployBlock = Number(deployBlockRaw)
  if (!Number.isSafeInteger(deployBlock)) throw new Error('Local Arc certification deploy block is outside the safe integer range')
  return { address: address as `0x${string}`, deployBlock }
}

export function getAutoSaverAddress(chainId: number): `0x${string}` {
  const network = getNetworkForChainId(chainId)
  assertConfiguredChainId(chainId)
  if (network === 'mainnet') {
    if (chainId !== getChainIdForNetwork(getConfiguredNetwork())) {
      throw new Error('Mainnet contract cannot be read from a non-Mainnet MOVY deployment')
    }
    const manifest = readOwnerVerifiedMainnetManifest()
    const configuredAddress = process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET
    if (!configuredAddress || configuredAddress.toLowerCase() !== manifest.contracts.autoSaver.address.toLowerCase()) {
      throw new Error('Configured AutoSaver address does not match the verified Arc Mainnet manifest')
    }
    return manifest.contracts.autoSaver.address as `0x${string}`
  }

  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet') throw new Error(MAINNET_BUILD_REFUSES_TESTNET)
  const localDeployment = readLocalArcCertificationDeployment(chainId)
  if (localDeployment) return localDeployment.address

  const deployment = readTestnetDeployment()
  if (!deployment || deployment.network !== 'testnet' || deployment.chainId !== CHAIN_TESTNET_ID || !deployment.contractAddress) {
    throw new Error('Arc Testnet AutoSaver deployment manifest is missing or invalid')
  }
  const configuredAddress = process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET
  if (configuredAddress && configuredAddress.toLowerCase() !== deployment.contractAddress.toLowerCase()) {
    throw new Error('Configured Arc Testnet AutoSaver address does not match its deployment manifest')
  }
  return deployment.contractAddress as `0x${string}`
}

export function getDeployBlock(chainId: number): number {
  const network = getNetworkForChainId(chainId)
  assertConfiguredChainId(chainId)
  if (network === 'mainnet') {
    if (chainId !== getChainIdForNetwork(getConfiguredNetwork())) {
      throw new Error('Mainnet deploy block cannot be read from a non-Mainnet MOVY deployment')
    }
    const manifest = readOwnerVerifiedMainnetManifest()
    const configuredBlock = process.env.MOVY_AUTO_SAVER_MAINNET_DEPLOY_BLOCK ||
      process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET
    if (!configuredBlock || !/^\d+$/.test(configuredBlock) || Number(configuredBlock) !== manifest.contracts.autoSaver.deployBlock) {
      throw new Error('Configured AutoSaver deploy block does not match the verified Arc Mainnet manifest')
    }
    return manifest.contracts.autoSaver.deployBlock
  }

  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet') throw new Error(MAINNET_BUILD_REFUSES_TESTNET)
  const localDeployment = readLocalArcCertificationDeployment(chainId)
  if (localDeployment) return localDeployment.deployBlock

  const deployment = readTestnetDeployment()
  if (!deployment || deployment.network !== 'testnet' || deployment.chainId !== CHAIN_TESTNET_ID || !deployment.deployBlock) {
    throw new Error('Arc Testnet AutoSaver deployment block is missing or invalid')
  }
  const configuredDeployBlock = process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK
  if (configuredDeployBlock !== undefined) {
    if (!/^[0-9]+$/.test(configuredDeployBlock)) {
      throw new Error('MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK must be a nonnegative integer')
    }
    const blockNumber = Number(configuredDeployBlock)
    if (!Number.isSafeInteger(blockNumber)) throw new Error('MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK is outside the safe integer range')
    if (blockNumber !== deployment.deployBlock) throw new Error('Arc Testnet deploy block does not match its deployment manifest')
    return blockNumber
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Production Arc Testnet deploy block must be explicitly configured')
  return Number(deployment.deployBlock)
}
