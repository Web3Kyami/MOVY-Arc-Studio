import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = process.cwd()
const originalCwd = process.cwd()
const originalEnv = { ...process.env }
const testRoot = mkdtempSync(join(tmpdir(), 'movy-mainnet-runtime-'))
const lock = JSON.parse(readFileSync(join(process.cwd(), 'config/networks/arc-mainnet.source-lock.json'), 'utf8'))
const OLD_ONCHAIN_AUTO_SAVER_HASH = '0x2ebb521ad82e66ae297cbcfdc502d772fa25b4f72920dd534de13b93c9946206'
const autoSaverAddress = `0x${'1'.repeat(40)}`
const savingsVaultAddress = `0x${'2'.repeat(40)}`
const manifest = {
  schemaVersion: 2,
  network: 'arc-mainnet',
  status: 'owner-verified',
  chainId: 5042,
  rpcUrl: 'https://rpc.mainnet.arc.io',
  explorerUrl: 'https://explorer.arc.io',
  usdcAddress: '0x3600000000000000000000000000000000000000',
  feePolicy: {
    minBaseFeePerGasWei: '20000000000',
    maxFeePerGasWei: '30000000000',
    priorityFeePerGasWei: '1000000000',
    maxTransactionFeeWei: '50000000000000000',
  },
  contracts: {
    autoSaver: {
      address: autoSaverAddress,
      deployBlock: 100,
      transactionHash: `0x${'a'.repeat(64)}`,
      runtimeCodeHash: lock.contracts.autoSaver.runtimeCodeHash,
      roles: { owner: `0x${'4'.repeat(40)}`, relayer: `0x${'5'.repeat(40)}`, verified: true },
    },
    savingsVault: {
      address: savingsVaultAddress,
      deployBlock: 200,
      transactionHash: `0x${'c'.repeat(64)}`,
      runtimeCodeHash: lock.contracts.savingsVault.runtimeCodeHash,
    },
  },
  verification: {
    ownerApproved: true,
    approvedBy: 'Synthetic test fixture only',
    approvedAt: '2026-10-15T00:00:00.000Z',
    evidenceUrls: ['https://docs.arc.io/arc/references/connect-to-arc', 'https://explorer.arc.io'],
    observedRpcChainId: 5042,
    observedBlock: '1000',
    observedGasPriceWei: '21000000000',
    observedAt: '2026-10-15T00:00:00.000Z',
  },
}

const runtimeEnv = {
  NODE_ENV: 'production',
  MOVY_TARGET_NETWORK: 'mainnet',
  NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'mainnet',
  NEXT_PUBLIC_MOVY_CHAIN_ID: '5042',
  MOVY_DATABASE_NETWORK: 'mainnet',
  MOVY_WORKER_ENABLED: 'false',
  MOVY_RELAYER_ENABLED: 'false',
  ARC_MAINNET_RPC_URL: manifest.rpcUrl,
  NEXT_PUBLIC_ARC_MAINNET_RPC_URL: manifest.rpcUrl,
  NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL: manifest.explorerUrl,
  NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET: autoSaverAddress,
  NEXT_PUBLIC_MOVY_ADDRESS_MAINNET: savingsVaultAddress,
  NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET: '100',
  NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET: '200',
  NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.minBaseFeePerGasWei,
  NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.maxFeePerGasWei,
  NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.priorityFeePerGasWei,
  NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: manifest.feePolicy.maxTransactionFeeWei,
  MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: manifest.feePolicy.maxFeePerGasWei,
  MOVY_RELAYER_MAX_TX_FEE_WEI: manifest.feePolicy.maxTransactionFeeWei,
}

try {
  for (const key of Object.keys(process.env)) {
    if (/(?:^|_)TESTNET(?:_|$)/i.test(key)) delete process.env[key]
  }
  Object.assign(process.env, runtimeEnv)
  mkdirSync(join(testRoot, 'config', 'networks'), { recursive: true })
  writeFileSync(join(testRoot, 'config', 'networks', 'arc-mainnet.json'), JSON.stringify(manifest))
  process.chdir(testRoot)

  const config = await import(join(repoRoot, 'src/lib/server/config.ts'))
  assert.equal(config.getConfiguredNetwork(), 'mainnet')
  assert.equal(config.getAutoSaverAddress(5042).toLowerCase(), autoSaverAddress.toLowerCase())
  assert.equal(config.getDeployBlock(5042), 100)
  assert.equal(config.getRpcUrlForChainId(5042), 'https://rpc.mainnet.arc.io/')
  assert.throws(() => config.assertConfiguredChainId(5042002), /does not match this MOVY deployment/)
  process.env.ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io'
  assert.throws(() => config.getConfiguredNetwork(), /refuses Testnet configuration ARC_TESTNET_RPC_URL/)
  delete process.env.ARC_TESTNET_RPC_URL

  // A manifest whose minimum base fee is below the 20 Gwei Arc floor is rejected, even when the
  // environment is edited to match it. The fee policy is never accepted on environment values alone.
  const manifestPath = join(testRoot, 'config', 'networks', 'arc-mainnet.json')
  const belowFloor = { ...manifest, feePolicy: { ...manifest.feePolicy, minBaseFeePerGasWei: '19999999999' } }
  writeFileSync(manifestPath, JSON.stringify(belowFloor))
  process.env.NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET = '19999999999'
  assert.throws(() => config.getConfiguredNetwork(), /incomplete deployments or unverified AutoSaver roles/)
  assert.throws(() => config.getAutoSaverAddress(5042), /incomplete deployments or unverified AutoSaver roles/)
  const oldPilotStyle = { ...manifest, feePolicy: { ...manifest.feePolicy, minBaseFeePerGasWei: '5000000000', maxFeePerGasWei: '12000000000' } }
  writeFileSync(manifestPath, JSON.stringify(oldPilotStyle))
  assert.throws(() => config.getConfiguredNetwork(), /incomplete deployments or unverified AutoSaver roles/)
  // The old on-chain AutoSaver hash is rejected even though every approval and role flag is true.
  assert.equal(manifest.verification.ownerApproved, true)
  assert.equal(manifest.contracts.autoSaver.roles.verified, true)
  writeFileSync(manifestPath, JSON.stringify({
    ...manifest,
    contracts: { ...manifest.contracts, autoSaver: { ...manifest.contracts.autoSaver, runtimeCodeHash: OLD_ONCHAIN_AUTO_SAVER_HASH } },
  }))
  assert.throws(() => config.getConfiguredNetwork(), /runtime code hash does not match the release source lock/)
  assert.throws(() => config.getAutoSaverAddress(5042), /runtime code hash does not match the release source lock/)
  assert.throws(() => config.getDeployBlock(5042), /runtime code hash does not match the release source lock/)
  writeFileSync(manifestPath, JSON.stringify({
    ...manifest,
    contracts: { ...manifest.contracts, savingsVault: { ...manifest.contracts.savingsVault, runtimeCodeHash: `0x${'d'.repeat(64)}` } },
  }))
  assert.throws(() => config.getConfiguredNetwork(), /runtime code hash does not match the release source lock/)
  // The approved floor value is accepted again.
  writeFileSync(manifestPath, JSON.stringify(manifest))
  process.env.NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET = manifest.feePolicy.minBaseFeePerGasWei
  assert.equal(config.getConfiguredNetwork(), 'mainnet')
  console.log('PASS: Mainnet runtime binds RPC, contracts, deploy block, database network, roles, and fee limits to the verified manifest; Testnet config fails closed')
} finally {
  process.chdir(originalCwd)
  rmSync(testRoot, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
}
