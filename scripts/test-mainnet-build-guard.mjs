import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  assertBuildNetworkPreflight,
  assertSourceLock,
  readSourceLock,
  verifyLocalSourceFiles,
  assertNoTestnetRuntime,
  collectTestnetContractAddresses,
  isRuntimeScanFile,
  TESTNET_RUNTIME_MARKERS,
  validateMainnetManifest,
} from './verify/network-build-guard.mjs'

const root = process.cwd()
const lock = readSourceLock()
const OLD_ONCHAIN_AUTO_SAVER_HASH = '0x2ebb521ad82e66ae297cbcfdc502d772fa25b4f72920dd534de13b93c9946206'
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
      address: `0x${'1'.repeat(40)}`, deployBlock: 10, transactionHash: `0x${'1'.repeat(64)}`,
      runtimeCodeHash: lock.contracts.autoSaver.runtimeCodeHash,
      roles: { owner: `0x${'4'.repeat(40)}`, relayer: `0x${'5'.repeat(40)}`, verified: true },
    },
    savingsVault: { address: `0x${'2'.repeat(40)}`, deployBlock: 20, transactionHash: `0x${'2'.repeat(64)}`, runtimeCodeHash: lock.contracts.savingsVault.runtimeCodeHash },
  },
  verification: {
    ownerApproved: true,
    approvedBy: 'Synthetic test approver',
    approvedAt: '2026-10-14T00:00:00.000Z',
    evidenceUrls: ['https://docs.arc.io/arc/references/connect-to-arc', 'https://explorer.arc.io'],
    observedRpcChainId: 5042,
    observedBlock: '1000',
    observedGasPriceWei: '20000000000',
    observedAt: '2026-10-14T00:00:00.000Z',
  },
}

assert.equal(validateMainnetManifest(manifest), manifest)
assert.throws(() => validateMainnetManifest({ ...manifest, status: 'unverified' }), /owner-verified/)
assert.throws(() => validateMainnetManifest({ ...manifest, contracts: { ...manifest.contracts, autoSaver: { ...manifest.contracts.autoSaver, roles: { ...manifest.contracts.autoSaver.roles, relayer: manifest.contracts.autoSaver.roles.owner } } } }), /separately controlled/)
assert.throws(() => validateMainnetManifest({ ...manifest, contracts: { ...manifest.contracts, autoSaver: { ...manifest.contracts.autoSaver, runtimeCodeHash: '0x1234' } } }), /runtimeCodeHash/)
assert.throws(() => validateMainnetManifest({ ...manifest, rpcUrl: 'https://rpc.testnet.arc.io' }), /must not point to Testnet/)
assert.throws(() => validateMainnetManifest({ ...manifest, verification: { ...manifest.verification, observedRpcChainId: 5042002 } }), /chain 5042/)
assert.throws(() => validateMainnetManifest({ ...manifest, feePolicy: undefined }), /minimum base fee is missing or invalid/)
assert.throws(() => validateMainnetManifest({ ...manifest, feePolicy: { ...manifest.feePolicy, maxFeePerGasWei: '19999999999' } }), /below its minimum base fee/)
assert.throws(() => validateMainnetManifest({ ...manifest, feePolicy: { ...manifest.feePolicy, minBaseFeePerGasWei: '19999999999' } }), /below the 20 Gwei Arc floor/)
assert.throws(() => validateMainnetManifest({ ...manifest, feePolicy: { ...manifest.feePolicy, minBaseFeePerGasWei: '1000000000', maxFeePerGasWei: '30000000000' } }), /below the 20 Gwei Arc floor/)
assert.throws(() => validateMainnetManifest({ ...manifest, feePolicy: { ...manifest.feePolicy, minBaseFeePerGasWei: '5000000000', maxFeePerGasWei: '12000000000' } }), /below the 20 Gwei Arc floor/)
assert.equal(validateMainnetManifest({ ...manifest, feePolicy: { ...manifest.feePolicy, minBaseFeePerGasWei: '20000000000' } }).feePolicy.minBaseFeePerGasWei, '20000000000')
assert.throws(() => validateMainnetManifest({ ...manifest, verification: { ...manifest.verification, observedGasPriceWei: '30000000001' } }), /observed gas price exceeds/)

// The release source lock is the only accepted runtime code. Every approval below is true,
// so only the lock can reject these manifests.
const withHashes = (autoSaverHash, savingsHash) => ({
  ...manifest,
  contracts: {
    ...manifest.contracts,
    autoSaver: { ...manifest.contracts.autoSaver, runtimeCodeHash: autoSaverHash },
    savingsVault: { ...manifest.contracts.savingsVault, runtimeCodeHash: savingsHash },
  },
})
assert.equal(manifest.verification.ownerApproved, true)
assert.equal(manifest.contracts.autoSaver.roles.verified, true)
assert.throws(() => validateMainnetManifest(withHashes(OLD_ONCHAIN_AUTO_SAVER_HASH, lock.contracts.savingsVault.runtimeCodeHash)), /AutoSaver runtimeCodeHash does not match the release source lock/)
assert.throws(() => validateMainnetManifest(withHashes(lock.contracts.autoSaver.runtimeCodeHash, `0x${'c'.repeat(64)}`)), /Savings vault runtimeCodeHash does not match the release source lock/)
assert.throws(() => validateMainnetManifest(withHashes(`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`)), /does not match the release source lock/)
// Case differences in the manifest hash are not a bypass and not a false rejection.
assert.doesNotThrow(() => validateMainnetManifest(withHashes(lock.contracts.autoSaver.runtimeCodeHash.toUpperCase().replace('0X', '0x'), lock.contracts.savingsVault.runtimeCodeHash)))
// A malformed lock fails closed.
assert.throws(() => validateMainnetManifest(manifest, { ...lock, schemaVersion: 2 }), /source lock schemaVersion must be 1/)
assert.throws(() => validateMainnetManifest(manifest, { ...lock, contracts: { ...lock.contracts, autoSaver: { ...lock.contracts.autoSaver, sourcePath: 'contracts/src/Other.sol' } } }), /sourcePath must be contracts\/src\/MovyAutoSaver.sol/)
assert.throws(() => assertSourceLock(null), /missing or invalid/)

const validEnv = {
  MOVY_TARGET_NETWORK: 'mainnet',
  NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'mainnet',
  NEXT_PUBLIC_MOVY_CHAIN_ID: '5042',
  MOVY_DATABASE_NETWORK: 'mainnet',
  MOVY_WORKER_ENABLED: 'false',
  MOVY_RELAYER_ENABLED: 'false',
  ARC_MAINNET_RPC_URL: manifest.rpcUrl,
  NEXT_PUBLIC_ARC_MAINNET_RPC_URL: manifest.rpcUrl,
  NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL: manifest.explorerUrl,
  NEXT_PUBLIC_MOVY_ADDRESS_MAINNET: manifest.contracts.savingsVault.address,
  NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET: manifest.contracts.autoSaver.address,
  NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET: '20',
  NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET: '10',
  NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.minBaseFeePerGasWei,
  NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.maxFeePerGasWei,
  NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: manifest.feePolicy.priorityFeePerGasWei,
  NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: manifest.feePolicy.maxTransactionFeeWei,
  MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: manifest.feePolicy.maxFeePerGasWei,
  MOVY_RELAYER_MAX_TX_FEE_WEI: manifest.feePolicy.maxTransactionFeeWei,
}
assert.equal(assertBuildNetworkPreflight({ env: validEnv, manifest, runtimeImplemented: true }).target, 'mainnet')
assert.throws(() => assertBuildNetworkPreflight({ env: validEnv, manifest, runtimeImplemented: false }), /still Testnet-only/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, MOVY_LOCAL_ARC_CERTIFICATION: 'true' }, manifest, runtimeImplemented: true }), /local Arc certification mode is enabled/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, MOVY_TARGET_NETWORK: undefined }, manifest, runtimeImplemented: true }), /MOVY_TARGET_NETWORK must be explicitly mainnet/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_MOVY_TARGET_NETWORK: undefined }, manifest, runtimeImplemented: true }), /NEXT_PUBLIC_MOVY_TARGET_NETWORK must be explicitly mainnet/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_MOVY_CHAIN_ID: undefined }, manifest, runtimeImplemented: true }), /NEXT_PUBLIC_MOVY_CHAIN_ID must be explicitly 5042/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, MOVY_DEMO_MERCHANT_PAYMENT_ENABLED: 'true' }, manifest, runtimeImplemented: true }), /merchant checkout must remain disabled/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io' }, manifest, runtimeImplemented: true }), /Testnet configuration ARC_TESTNET_RPC_URL/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_MOVY_CHAIN_ID: '5042002' }, manifest, runtimeImplemented: true }), /NEXT_PUBLIC_MOVY_CHAIN_ID must be explicitly 5042/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'testnet' }, manifest, runtimeImplemented: true }), /targets do not match/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, MOVY_NETWORK: 'testnet' }, manifest, runtimeImplemented: true }), /MOVY_NETWORK does not match/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, MOVY_DATABASE_NETWORK: 'testnet' }, manifest, runtimeImplemented: true }), /MOVY_DATABASE_NETWORK must be explicitly mainnet/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, MOVY_WORKER_ENABLED: 'true' }, manifest, runtimeImplemented: true }), /MOVY_AUTOMATION_APPROVED_CONTRACT must match/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_ARC_MAINNET_RPC_URL: 'https://rpc.testnet.arc.io' }, manifest, runtimeImplemented: true }), /NEXT_PUBLIC_ARC_MAINNET_RPC_URL does not match the verified manifest/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL: 'https://explorer.testnet.arc.io' }, manifest, runtimeImplemented: true }), /NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL does not match the verified manifest/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL: 'https://explorer.testnet.arc.io' }, manifest, runtimeImplemented: true }), /Testnet configuration NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: '25000000000' }, manifest, runtimeImplemented: true }), /MOVY_RELAYER_MAX_FEE_PER_GAS_WEI does not match the verified manifest/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, MOVY_RELAYER_MAX_TX_FEE_WEI: '1' }, manifest, runtimeImplemented: true }), /MOVY_RELAYER_MAX_TX_FEE_WEI does not match the verified manifest/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: undefined }, manifest, runtimeImplemented: true }), /missing NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET/)
assert.throws(() => assertBuildNetworkPreflight({ env: { ...validEnv, NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: undefined }, manifest, runtimeImplemented: true }), /missing NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET/)
assert.throws(() => assertBuildNetworkPreflight({ env: { MOVY_TARGET_NETWORK: 'mainnet' }, manifest: null }), /Mainnet-targeted build refused: .* is missing or has not been provided/)

// Source files are checked against the lock in a safe temporary copy. The real contract sources
// are only ever read, never written.
const lockedFiles = ['contracts/src/MovyAutoSaver.sol', 'contracts/src/MovySavings.sol', 'contracts/foundry.toml']
const lockRelative = 'config/networks/arc-mainnet.source-lock.json'
function makeSourceFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'movy-source-lock-'))
  for (const relative of [...lockedFiles, lockRelative]) {
    mkdirSync(join(dir, relative, '..'), { recursive: true })
    cpSync(join(root, relative), join(dir, relative))
  }
  return dir
}
const sourceFixtures = []
try {
  const clean = makeSourceFixture()
  sourceFixtures.push(clean)
  assert.equal(verifyLocalSourceFiles(readSourceLock(clean), clean), true)
  assert.equal(assertBuildNetworkPreflight({ env: validEnv, manifest, runtimeImplemented: true, sourceRoot: clean }).target, 'mainnet')
  const realBefore = lockedFiles.map((relative) => readFileSync(join(root, relative), 'utf8'))

  for (const relative of lockedFiles) {
    const dir = makeSourceFixture()
    sourceFixtures.push(dir)
    writeFileSync(join(dir, relative), `${readFileSync(join(dir, relative), 'utf8')}\n// tampered`)
    assert.throws(() => verifyLocalSourceFiles(readSourceLock(dir), dir), new RegExp(`${relative.replace(/[./]/g, '\\$&')} does not match the release source lock`))
    assert.throws(() => assertBuildNetworkPreflight({ env: validEnv, manifest, runtimeImplemented: true, sourceRoot: dir }), /does not match the release source lock/)
  }

  const missingSource = makeSourceFixture()
  sourceFixtures.push(missingSource)
  rmSync(join(missingSource, 'contracts/src/MovySavings.sol'))
  assert.throws(() => verifyLocalSourceFiles(readSourceLock(missingSource), missingSource), /locked source file contracts\/src\/MovySavings.sol is missing/)

  const missingLock = makeSourceFixture()
  sourceFixtures.push(missingLock)
  rmSync(join(missingLock, lockRelative))
  assert.throws(() => readSourceLock(missingLock), /source-lock.json is missing/)
  assert.throws(() => assertBuildNetworkPreflight({ env: validEnv, manifest, runtimeImplemented: true, sourceRoot: missingLock }), /source-lock.json is missing/)

  const brokenLock = makeSourceFixture()
  sourceFixtures.push(brokenLock)
  writeFileSync(join(brokenLock, lockRelative), '{ not json')
  assert.throws(() => readSourceLock(brokenLock), /invalid JSON/)
  writeFileSync(join(brokenLock, lockRelative), JSON.stringify({ ...lock, foundryConfigSha256: 'xyz' }))
  assert.throws(() => readSourceLock(brokenLock), /foundryConfigSha256 is invalid/)

  // A Testnet build never reads the lock, so a missing lock cannot change Testnet behavior.
  assert.deepEqual(assertBuildNetworkPreflight({ env: { MOVY_TARGET_NETWORK: 'testnet', NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'testnet' }, manifest: null, sourceRoot: missingLock }), { target: 'testnet' })

  const realAfter = lockedFiles.map((relative) => readFileSync(join(root, relative), 'utf8'))
  assert.deepEqual(realAfter, realBefore, 'the real contract sources must be untouched by the tests')
} finally {
  for (const dir of sourceFixtures) rmSync(dir, { recursive: true, force: true })
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'movy-mainnet-runtime-'))
try {
  mkdirSync(join(fixtureRoot, '.next/server'), { recursive: true })
  mkdirSync(join(fixtureRoot, 'contracts'), { recursive: true })
  writeFileSync(
    join(fixtureRoot, 'contracts/deployed-testnet.json'),
    JSON.stringify({ network: 'testnet', contractAddress: `0x${'4'.repeat(40)}`, usdcAddress: manifest.usdcAddress }),
  )
  for (const [index, marker] of TESTNET_RUNTIME_MARKERS.entries()) {
    writeFileSync(join(fixtureRoot, '.next/server', `fixture-${index}.js`), `runtime marker: ${marker}`)
  }
  assert.throws(() => assertNoTestnetRuntime(fixtureRoot), /contains Testnet configuration/)
  rmSync(join(fixtureRoot, '.next/server'), { recursive: true, force: true })
  mkdirSync(join(fixtureRoot, '.next/server'), { recursive: true })
  writeFileSync(join(fixtureRoot, '.next/server/main.js'), `testnet deployment: 0x${'4'.repeat(40)}`)
  assert.throws(() => assertNoTestnetRuntime(fixtureRoot), /contains Testnet configuration/)
  writeFileSync(join(fixtureRoot, '.next/server/main.js'), 'mainnet runtime fixture')
  assert.equal(assertNoTestnetRuntime(fixtureRoot), true)
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}

// Runtime scan scope: Testnet CONTRACT addresses and endpoints are forbidden in executable output,
// while shared compromised-key EOAs and source maps are not Testnet configuration.
const SHARED_COMPROMISED_EOA = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
const TESTNET_CONTRACT = `0x${'4'.repeat(40)}`
const testnetManifest = {
  network: 'testnet',
  contractAddress: TESTNET_CONTRACT,
  owner: SHARED_COMPROMISED_EOA,
  deployer: SHARED_COMPROMISED_EOA,
  relayer: SHARED_COMPROMISED_EOA,
  usdcAddress: manifest.usdcAddress,
}
assert.deepEqual(collectTestnetContractAddresses(testnetManifest), [TESTNET_CONTRACT], 'only the contract address is collected, never owner, deployer, relayer or USDC')
assert.deepEqual(collectTestnetContractAddresses({ owner: SHARED_COMPROMISED_EOA, nested: { contractAddress: TESTNET_CONTRACT, Relayer: SHARED_COMPROMISED_EOA } }), [TESTNET_CONTRACT])
assert.equal(isRuntimeScanFile('/x/.next/server/chunks/a.js'), true)
assert.equal(isRuntimeScanFile('/x/.next/server/chunks/a.js.map'), false)
assert.equal(isRuntimeScanFile('/x/.next/static/chunks/a.js.map.txt'), true, 'only real source maps are excluded')
assert.equal(isRuntimeScanFile('/x/public/data.json'), true)
assert.equal(isRuntimeScanFile('/x/public/config.map'), true, 'a public asset cannot hide configuration behind a map extension')

const scanRoot = mkdtempSync(join(tmpdir(), 'movy-runtime-scan-'))
try {
  mkdirSync(join(scanRoot, 'contracts'), { recursive: true })
  writeFileSync(join(scanRoot, 'contracts/deployed-testnet.json'), JSON.stringify(testnetManifest))
  const server = join(scanRoot, '.next/server')
  const resetServer = () => { rmSync(server, { recursive: true, force: true }); mkdirSync(server, { recursive: true }) }

  // A shared compromised EOA in executable code (mandatory key rejection) is not Testnet configuration.
  resetServer()
  writeFileSync(join(server, 'main.js'), `const denied = new Set(["${SHARED_COMPROMISED_EOA}"])`)
  assert.equal(assertNoTestnetRuntime(scanRoot), true)

  // Source maps carry original source text; they are not executable runtime.
  resetServer()
  writeFileSync(join(server, 'main.js'), 'mainnet runtime fixture')
  writeFileSync(join(server, 'main.js.map'), JSON.stringify({
    sourcesContent: [`https://explorer.testnet.arc.io ${TESTNET_CONTRACT} 0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d`],
  }))
  assert.equal(assertNoTestnetRuntime(scanRoot), true)

  // The same text in executable output is still rejected: endpoint, manifest contract, and known markers.
  for (const executable of ['https://explorer.testnet.arc.io', 'https://rpc.testnet.arc.io', TESTNET_CONTRACT, '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d']) {
    resetServer()
    writeFileSync(join(server, 'main.js'), `fetch("${executable}")`)
    writeFileSync(join(server, 'main.js.map'), '{}')
    assert.throws(() => assertNoTestnetRuntime(scanRoot), /contains Testnet configuration/, executable)
  }

  // Public assets are still scanned, and renaming a map does not hide executable text in a non-map file.
  resetServer()
  mkdirSync(join(scanRoot, 'public'), { recursive: true })
  writeFileSync(join(scanRoot, 'public/config.json'), `{"contract":"${TESTNET_CONTRACT}"}`)
  assert.throws(() => assertNoTestnetRuntime(scanRoot), /contains Testnet configuration/)
  rmSync(join(scanRoot, 'public/config.json'))
  writeFileSync(join(scanRoot, 'public/config.map'), `{"contract":"${TESTNET_CONTRACT}"}`)
  assert.throws(() => assertNoTestnetRuntime(scanRoot), /contains Testnet configuration/)
  rmSync(join(scanRoot, 'public/config.map'))
  writeFileSync(join(server, 'chunk.js.map.js'), `fetch("${TESTNET_CONTRACT}")`)
  assert.throws(() => assertNoTestnetRuntime(scanRoot), /contains Testnet configuration/)
} finally {
  rmSync(scanRoot, { recursive: true, force: true })
}

const buildEnv = { ...process.env, MOVY_TARGET_NETWORK: 'mainnet' }
delete buildEnv.NEXT_PUBLIC_MOVY_TARGET_NETWORK
for (const key of [
  'ARC_TESTNET_RPC_URL',
  'NEXT_PUBLIC_MOVY_ADDRESS_TESTNET',
  'NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET',
  'NEXT_PUBLIC_DEMO_STORE_TESTNET',
  'NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_TESTNET',
]) delete buildEnv[key]
const build = spawnSync('npm', ['run', 'build'], { cwd: root, env: buildEnv, encoding: 'utf8' })
assert.notEqual(build.status, 0, 'a Mainnet-targeted npm build must fail closed at the current unsupported runtime')
assert.match(`${build.stdout}\n${build.stderr}`, /Mainnet-targeted build refused/)
assert.doesNotMatch(`${build.stdout}\n${build.stderr}`, /Creating an optimized production build/)

console.log('PASS: Mainnet-targeted build rejects missing or unverified configuration, Testnet runtime settings and Testnet artifacts; no real Mainnet build or RPC was used')
