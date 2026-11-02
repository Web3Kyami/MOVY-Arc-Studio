import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getArcFeePolicy } from '../src/lib/fee-policy.ts'
import { getWorkerLockName } from '../src/lib/server/worker-lock.ts'
import {
  assertConfiguredChainId,
  getAutoSaverAddress,
  getConfiguredNetwork,
  getDeployBlock,
  getRpcUrlForChainId,
} from '../src/lib/server/config.ts'

const keys = [
  'NODE_ENV', 'MOVY_TARGET_NETWORK', 'NEXT_PUBLIC_MOVY_TARGET_NETWORK', 'NEXT_PUBLIC_MOVY_CHAIN_ID',
  'MOVY_DATABASE_NETWORK', 'MOVY_WORKER_ENABLED', 'MOVY_RELAYER_ENABLED', 'ARC_MAINNET_RPC_URL',
  'NEXT_PUBLIC_ARC_MAINNET_RPC_URL', 'NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL', 'ARC_TESTNET_RPC_URL', 'NEXT_PUBLIC_ARC_TESTNET_RPC_URL', 'NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL',
  'NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET', 'MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK', 'MOVY_LOCAL_ARC_CERTIFICATION',
]
const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
// The Testnet assertions below exercise the OLD manifest and its pinned address. Run them from a
// throwaway working directory holding only a copy of that manifest, so the result is identical
// whether or not `contracts/deployed-testnet-fresh.json` exists in the real project. (Fresh
// manifest selection has its own test: scripts/test-testnet-deployment-manifest.mjs.)
const repoRoot = process.cwd()
const fixtureRoot = mkdtempSync(join(tmpdir(), 'movy-network-isolation-'))
mkdirSync(join(fixtureRoot, 'contracts'), { recursive: true })
copyFileSync(join(repoRoot, 'contracts', 'deployed-testnet.json'), join(fixtureRoot, 'contracts', 'deployed-testnet.json'))
process.chdir(fixtureRoot)
const restore = () => {
  process.chdir(repoRoot)
  rmSync(fixtureRoot, { recursive: true, force: true })
  for (const key of keys) {
    if (prior[key] === undefined) delete process.env[key]
    else process.env[key] = prior[key]
  }
}

try {
  assert.equal(getWorkerLockName('testnet'), 'arc-testnet-worker')
  assert.equal(getWorkerLockName('mainnet'), 'arc-mainnet-worker')
  assert.throws(() => getArcFeePolicy('mainnet', {}), /missing NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET/)
  const mainnetFeePolicy = getArcFeePolicy('mainnet', {
    NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: '20000000000',
    NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: '30000000000',
    NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: '1000000000',
    NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: '50000000000000000',
  })
  assert.equal(mainnetFeePolicy.minBaseFeePerGasWei, 20_000_000_000n)
  assert.equal(mainnetFeePolicy.maxFeePerGasWei, 30_000_000_000n)
  assert.equal(mainnetFeePolicy.priorityFeePerGasWei, 1_000_000_000n)
  assert.equal(mainnetFeePolicy.maxTransactionFeeWei, 50_000_000_000_000_000n)
  // Below the documented 20 Gwei Arc floor is rejected, including the former pilot-style values.
  for (const belowFloor of ['19999999999', '5000000000', '1000000000']) {
    assert.throws(() => getArcFeePolicy('mainnet', {
      NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: belowFloor,
      NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: '30000000000',
      NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: '1000000000',
      NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: '50000000000000000',
    }), /below the 20 Gwei Arc floor/)
  }
  assert.throws(() => getArcFeePolicy('mainnet', {
    NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: '30000000000',
    NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: '25000000000',
    NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: '1000000000',
    NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: '50000000000000000',
  }), /below its verified minimum/)
  assert.throws(() => getArcFeePolicy('mainnet', {
    NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: '20000000000',
    NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: '30000000000',
    NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: '1000000000',
    NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: '50000000000000000',
    MOVY_RELAYER_MAX_TX_FEE_WEI: '1',
  }), /does not match the owner-verified fee policy/)

  Object.assign(process.env, {
    NODE_ENV: 'development',
    MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042002',
    MOVY_DATABASE_NETWORK: 'testnet',
    ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io',
    NEXT_PUBLIC_ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io',
    NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL: 'https://explorer.testnet.arc.io',
    NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET: '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d',
    MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK: '64445085',
  })
  assert.equal(getConfiguredNetwork(), 'testnet')
  assertConfiguredChainId(5042002)
  assert.equal(getRpcUrlForChainId(5042002), 'https://rpc.testnet.arc.io/')
  assert.equal(getAutoSaverAddress(5042002).toLowerCase(), '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d')
  assert.equal(getDeployBlock(5042002), 64445085)
  assert.throws(() => assertConfiguredChainId(5042), /does not match this MOVY deployment/)
  assert.throws(() => getRpcUrlForChainId(5042), /does not match this MOVY deployment/)
  assert.throws(() => getAutoSaverAddress(5042), /does not match this MOVY deployment/)
  assert.throws(() => getDeployBlock(5042), /does not match this MOVY deployment/)

  Object.assign(process.env, {
    MOVY_LOCAL_ARC_CERTIFICATION: 'true',
    ARC_TESTNET_RPC_URL: 'http://127.0.0.1:8545',
    NEXT_PUBLIC_ARC_TESTNET_RPC_URL: 'http://127.0.0.1:8545',
  })
  assert.equal(getRpcUrlForChainId(5042002), 'http://127.0.0.1:8545/')
  process.env.ARC_TESTNET_RPC_URL = 'http://rpc.example.com'
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = 'http://rpc.example.com'
  process.env.MOVY_WORKER_ENABLED = 'false'
  process.env.MOVY_RELAYER_ENABLED = 'false'
  assert.throws(() => getRpcUrlForChainId(5042002), /must use HTTPS/)
  process.env.NODE_ENV = 'production'
  process.env.ARC_TESTNET_RPC_URL = 'https://rpc.example.com'
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = 'https://rpc.example.com'
  assert.throws(() => getRpcUrlForChainId(5042002), /disabled in production/)
  delete process.env.MOVY_LOCAL_ARC_CERTIFICATION
  process.env.NODE_ENV = 'development'

  Object.assign(process.env, {
    MOVY_TARGET_NETWORK: 'mainnet',
    NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'mainnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042',
    MOVY_DATABASE_NETWORK: 'mainnet',
    ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.io',
    NEXT_PUBLIC_ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.io',
  })
  assert.equal(getConfiguredNetwork(), 'mainnet')
  assertConfiguredChainId(5042)
  assert.equal(getRpcUrlForChainId(5042), 'https://rpc.mainnet.arc.io/')
  assert.throws(() => getRpcUrlForChainId(5042002), /does not match this MOVY deployment/)
  // Fail closed whether or not the owner-verified manifest file is present in this checkout.
  const manifestGate = /Owner-verified Arc Mainnet deployment manifest is missing|does not match the verified Arc Mainnet manifest/
  assert.throws(() => getAutoSaverAddress(5042), manifestGate)
  assert.throws(() => getDeployBlock(5042), manifestGate)

  assert.throws(() => getConfiguredNetwork({
    NODE_ENV: 'production', MOVY_TARGET_NETWORK: 'mainnet', NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042', MOVY_DATABASE_NETWORK: 'mainnet', MOVY_WORKER_ENABLED: 'false', MOVY_RELAYER_ENABLED: 'false',
  }), /do not match/)
  assert.throws(() => getConfiguredNetwork({
    NODE_ENV: 'production', MOVY_TARGET_NETWORK: 'mainnet', NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'mainnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042', MOVY_DATABASE_NETWORK: 'testnet', MOVY_WORKER_ENABLED: 'false', MOVY_RELAYER_ENABLED: 'false',
  }), /MOVY_DATABASE_NETWORK must match/)
  assert.throws(() => getConfiguredNetwork({ NODE_ENV: 'production' }), /explicit server\/browser network targets/)

  // Production Mainnet isolation: any Testnet-specific variable fails specifically, and BEFORE the
  // owner-verified Mainnet manifest is loaded (so this runs without inventing a valid manifest).
  const productionMainnet = {
    NODE_ENV: 'production', MOVY_TARGET_NETWORK: 'mainnet', NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'mainnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042', MOVY_DATABASE_NETWORK: 'mainnet', MOVY_WORKER_ENABLED: 'false', MOVY_RELAYER_ENABLED: 'false',
  }
  assert.throws(() => getConfiguredNetwork({ ...productionMainnet, ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io' }),
    /Production Mainnet runtime refuses Testnet configuration ARC_TESTNET_RPC_URL/)
  assert.throws(() => getConfiguredNetwork({ ...productionMainnet, NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET: '0x1111111111111111111111111111111111111111' }),
    /Production Mainnet runtime refuses Testnet configuration NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET/)
  assert.throws(() => getConfiguredNetwork({ ...productionMainnet, MOVY_SOME_TESTNET_FLAG: 'yes' }),
    /Production Mainnet runtime refuses Testnet configuration MOVY_SOME_TESTNET_FLAG/)
  const productionManifestGate = /Owner-verified Arc Mainnet deployment manifest is missing|does not match the owner-verified Arc Mainnet manifest/
  // Empty Testnet values are not "present"; with none present the Mainnet manifest guard still fails closed.
  assert.throws(() => getConfiguredNetwork({ ...productionMainnet, ARC_TESTNET_RPC_URL: '' }),
    productionManifestGate)
  assert.throws(() => getConfiguredNetwork(productionMainnet), productionManifestGate)
  // A Mainnet-targeted production runtime with a Testnet variable never reaches "success".
  assert.throws(() => getConfiguredNetwork({ ...productionMainnet, NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL: 'https://explorer.testnet.arc.io' }),
    (error) => /refuses Testnet configuration/.test(error.message) && !/manifest is missing/.test(error.message))

  console.log('PASS: network selection is explicit, API/server chain IDs cannot cross, RPCs stay on the selected Arc network, and Mainnet deployments fail closed without the verified manifest')
} finally {
  restore()
}
