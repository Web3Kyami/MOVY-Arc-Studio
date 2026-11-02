// Offline checks for Arc Testnet manifest selection. Each case runs in a throwaway
// working directory, so the checked-in manifests are never read as a fixture, never
// modified, and the result does not depend on whether a real fresh manifest exists.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { getAddress } from 'viem'
import {
  getAutoSaverAddress,
  getConfiguredNetwork,
  getDeployBlock,
  TESTNET_FRESH_MANIFEST_FILE,
  TESTNET_LEGACY_MANIFEST_FILE,
} from '../src/lib/server/config.ts'

const originalCwd = process.cwd()
const envKeys = [
  'NODE_ENV', 'MOVY_TARGET_NETWORK', 'NEXT_PUBLIC_MOVY_TARGET_NETWORK', 'NEXT_PUBLIC_MOVY_CHAIN_ID',
  'MOVY_DATABASE_NETWORK', 'MOVY_WORKER_ENABLED', 'MOVY_RELAYER_ENABLED', 'ARC_TESTNET_RPC_URL',
  'NEXT_PUBLIC_ARC_TESTNET_RPC_URL', 'NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL',
  'NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET', 'MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK', 'MOVY_LOCAL_ARC_CERTIFICATION',
]
const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
const workDir = mkdtempSync(join(tmpdir(), 'movy-manifest-test-'))

const hexAddress = (byte) => getAddress(`0x${byte.repeat(20)}`)
const COMPROMISED = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const COMPROMISED_CONTRACT = '0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d'
const legacy = {
  network: 'testnet',
  chainId: 5042002,
  contractAddress: COMPROMISED_CONTRACT,
  deployBlock: 64445085,
  deployTxHash: `0x${'a'.repeat(64)}`,
  deployer: COMPROMISED,
  relayer: COMPROMISED,
  usdcAddress: '0x3600000000000000000000000000000000000000',
}
const fresh = {
  network: 'testnet',
  chainId: 5042002,
  contractAddress: hexAddress('c1'),
  deployBlock: 70123456,
  deployTxHash: `0x${'b'.repeat(64)}`,
  owner: hexAddress('a1'),
  deployer: hexAddress('a1'),
  relayer: hexAddress('b1'),
  usdcAddress: '0x3600000000000000000000000000000000000000',
  deployedAt: '2026-10-31T00:00:00.000Z',
}

function prepareFixture(name, { legacyManifest, freshManifest, freshRaw }) {
  const root = join(workDir, name)
  mkdirSync(join(root, 'contracts'), { recursive: true })
  if (legacyManifest !== undefined) writeFileSync(join(root, 'contracts', TESTNET_LEGACY_MANIFEST_FILE), JSON.stringify(legacyManifest))
  if (freshRaw !== undefined) writeFileSync(join(root, 'contracts', TESTNET_FRESH_MANIFEST_FILE), freshRaw)
  else if (freshManifest !== undefined) writeFileSync(join(root, 'contracts', TESTNET_FRESH_MANIFEST_FILE), JSON.stringify(freshManifest))
  process.chdir(root)
}

try {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042002',
    MOVY_DATABASE_NETWORK: 'testnet',
  })
  for (const key of ['NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET', 'MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK', 'MOVY_LOCAL_ARC_CERTIFICATION']) delete process.env[key]

  // 1. The fresh manifest wins over the old one whenever it exists and is valid.
  prepareFixture('fresh-wins', { legacyManifest: legacy, freshManifest: fresh })
  assert.equal(getAutoSaverAddress(5042002), fresh.contractAddress)
  assert.equal(getDeployBlock(5042002), fresh.deployBlock)
  process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET = fresh.contractAddress.toLowerCase()
  process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK = String(fresh.deployBlock)
  assert.equal(getAutoSaverAddress(5042002), fresh.contractAddress, 'a matching explicit configuration is accepted')
  assert.equal(getDeployBlock(5042002), fresh.deployBlock)
  // Configuration pointing at the old contract no longer matches once a fresh manifest exists.
  process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET = COMPROMISED_CONTRACT
  process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK = String(legacy.deployBlock)
  assert.throws(() => getAutoSaverAddress(5042002), /does not match its deployment manifest/)
  assert.throws(() => getDeployBlock(5042002), /does not match its deployment manifest/)
  delete process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET
  delete process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK

  // 2. A valid fresh manifest does not need the old one to be present.
  prepareFixture('fresh-only', { freshManifest: fresh })
  assert.equal(getAutoSaverAddress(5042002), fresh.contractAddress)

  // 3. Absent fresh manifest: the old manifest is still used, read-only, as before.
  prepareFixture('legacy-fallback', { legacyManifest: legacy })
  assert.equal(getAutoSaverAddress(5042002).toLowerCase(), COMPROMISED_CONTRACT)
  assert.equal(getDeployBlock(5042002), legacy.deployBlock)
  process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET = COMPROMISED_CONTRACT
  process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK = String(legacy.deployBlock)
  assert.equal(getAutoSaverAddress(5042002).toLowerCase(), COMPROMISED_CONTRACT)
  delete process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET
  delete process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK

  // 4. Neither manifest: fail closed with the existing message.
  prepareFixture('none', {})
  assert.throws(() => getAutoSaverAddress(5042002), /manifest is missing or invalid/)
  assert.throws(() => getDeployBlock(5042002), /deployment block is missing or invalid/)

  // 5. A fresh manifest that exists but is malformed or unsafe fails closed. It must never
  //    fall back to the (present, readable) old manifest.
  const mutate = (patch) => ({ ...fresh, ...patch })
  const without = (field) => Object.fromEntries(Object.entries(fresh).filter(([key]) => key !== field))
  const hostile = {
    'invalid JSON': { freshRaw: '{ not json' },
    'JSON array': { freshRaw: '[]' },
    'JSON null': { freshRaw: 'null' },
    'wrong network name': { freshManifest: mutate({ network: 'mainnet' }) },
    'wrong chain id': { freshManifest: mutate({ chainId: 5042 }) },
    'string chain id': { freshManifest: mutate({ chainId: '5042002' }) },
    'non-canonical USDC': { freshManifest: mutate({ usdcAddress: hexAddress('d1') }) },
    'missing USDC': { freshManifest: without('usdcAddress') },
    'zero contract': { freshManifest: mutate({ contractAddress: '0x0000000000000000000000000000000000000000' }) },
    'malformed contract': { freshManifest: mutate({ contractAddress: '0x1234' }) },
    'bad checksum contract': { freshManifest: mutate({ contractAddress: `0x${'Ab'.repeat(20)}` }) },
    'missing relayer': { freshManifest: without('relayer') },
    'zero relayer': { freshManifest: mutate({ relayer: '0x0000000000000000000000000000000000000000' }) },
    'missing owner': { freshManifest: without('owner') },
    'owner differs from deployer': { freshManifest: mutate({ deployer: hexAddress('a2') }) },
    'owner equals relayer': { freshManifest: mutate({ relayer: fresh.owner }) },
    'compromised owner (and deployer)': { freshManifest: mutate({ owner: COMPROMISED, deployer: COMPROMISED }) },
    'compromised owner, lower case': { freshManifest: mutate({ owner: COMPROMISED.toLowerCase(), deployer: COMPROMISED.toLowerCase() }) },
    'compromised relayer': { freshManifest: mutate({ relayer: COMPROMISED }) },
    'compromised AutoSaver as contract': { freshManifest: mutate({ contractAddress: COMPROMISED_CONTRACT }) },
    'zero deploy block': { freshManifest: mutate({ deployBlock: 0 }) },
    'negative deploy block': { freshManifest: mutate({ deployBlock: -1 }) },
    'fractional deploy block': { freshManifest: mutate({ deployBlock: 1.5 }) },
    'string deploy block': { freshManifest: mutate({ deployBlock: '70123456' }) },
    'unsafe-integer deploy block': { freshManifest: mutate({ deployBlock: Number.MAX_SAFE_INTEGER + 2 }) },
    'short deploy hash': { freshManifest: mutate({ deployTxHash: '0x1234' }) },
    'missing deploy hash': { freshManifest: without('deployTxHash') },
  }
  for (const [name, fixture] of Object.entries(hostile)) {
    prepareFixture(`hostile-${name.replace(/\W+/g, '-')}`, { legacyManifest: legacy, ...fixture })
    assert.throws(() => getAutoSaverAddress(5042002), /Fresh Arc Testnet deployment manifest is malformed or unsafe/, `address: ${name}`)
    assert.throws(() => getDeployBlock(5042002), /Fresh Arc Testnet deployment manifest is malformed or unsafe/, `block: ${name}`)
  }

  // 6. Production Testnet startup validation also fails closed on a bad fresh manifest,
  //    and accepts a valid one only with matching explicit configuration.
  const productionEnv = (extra = {}) => ({
    NODE_ENV: 'production',
    MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'testnet',
    NEXT_PUBLIC_MOVY_CHAIN_ID: '5042002',
    MOVY_DATABASE_NETWORK: 'testnet',
    MOVY_WORKER_ENABLED: 'false',
    MOVY_RELAYER_ENABLED: 'false',
    ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io',
    NEXT_PUBLIC_ARC_TESTNET_RPC_URL: 'https://rpc.testnet.arc.io',
    NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL: 'https://explorer.testnet.arc.io',
    NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET: fresh.contractAddress,
    MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK: String(fresh.deployBlock),
    ...extra,
  })
  prepareFixture('production-valid', { legacyManifest: legacy, freshManifest: fresh })
  assert.equal(getConfiguredNetwork(productionEnv()), 'testnet')
  assert.throws(() => getConfiguredNetwork(productionEnv({
    NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET: COMPROMISED_CONTRACT,
    MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK: String(legacy.deployBlock),
  })), /does not match its isolated deployment manifest/)
  prepareFixture('production-unsafe', { legacyManifest: legacy, freshManifest: mutate({ relayer: fresh.owner }) })
  assert.throws(() => getConfiguredNetwork(productionEnv()), /malformed or unsafe/)

  // 7. Compiled for Mainnet: Testnet-only validation is removed from the bundle, so any Testnet
  //    runtime selection must fail immediately. Removing the code can never act as a bypass.
  const repoRoot = originalCwd
  const configModule = pathToFileURL(join(repoRoot, 'src/lib/server/config.ts')).href
  const mainnetChild = (code, extraEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    const c = await import(${JSON.stringify(configModule)})
    ${code}
    console.log('child-ok')
  `], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', NEXT_PUBLIC_MOVY_TARGET_NETWORK: 'mainnet', ...extraEnv },
    encoding: 'utf8',
  })
  const refuses = /refuses any Testnet runtime selection/
  const refusedOrMismatch = /refuses any Testnet runtime selection|do not match|does not match this MOVY deployment/
  const testnetSelection = {
    MOVY_TARGET_NETWORK: 'testnet', NEXT_PUBLIC_MOVY_CHAIN_ID: '5042002', MOVY_DATABASE_NETWORK: 'testnet',
    MOVY_WORKER_ENABLED: 'false', MOVY_RELAYER_ENABLED: 'false',
  }
  for (const nodeEnv of ['development', 'production']) {
    const child = mainnetChild(`
      const env = ${JSON.stringify({ ...testnetSelection, NODE_ENV: nodeEnv })}
      env.NEXT_PUBLIC_MOVY_TARGET_NETWORK = 'mainnet'
      // Server says testnet but the build is Mainnet: the target-network pair mismatch is refused first.
      assert.throws(() => c.getConfiguredNetwork(env), /do not match/)
      env.NEXT_PUBLIC_MOVY_TARGET_NETWORK = 'testnet'
      // Both say testnet, yet this build is compiled for Mainnet: refused outright, never accepted.
      assert.throws(() => c.getConfiguredNetwork(env), ${refuses})
    `)
    assert.equal(child.status, 0, `${nodeEnv}: ${child.stdout}\n${child.stderr}`)
  }
  const pureValidation = mainnetChild(`
    assert.throws(() => c.validateFreshTestnetDeploymentManifest(${JSON.stringify(fresh)}), ${refuses})
    assert.throws(() => c.validateFreshTestnetDeploymentManifest(null), ${refuses})
  `)
  assert.equal(pureValidation.status, 0, `${pureValidation.stdout}\n${pureValidation.stderr}`)
  // A Testnet server selection cannot reach contract or RPC lookups either.
  const lookups = mainnetChild(`
    assert.throws(() => c.getAutoSaverAddress(5042002), ${refusedOrMismatch})
    assert.throws(() => c.getDeployBlock(5042002), ${refusedOrMismatch})
    assert.throws(() => c.getRpcUrlForChainId(5042002), ${refusedOrMismatch})
  `, { MOVY_TARGET_NETWORK: 'testnet', MOVY_DATABASE_NETWORK: 'testnet' })
  assert.equal(lookups.status, 0, `${lookups.stdout}\n${lookups.stderr}`)

  // 8. The inlined target actually removes Testnet-only strings from a minified Mainnet bundle,
  //    keeps them in a Testnet bundle, and keeps the mandatory compromised-key rejection.
  const { build } = createRequire(import.meta.url)('esbuild')
  const bundle = async (entry, target) => (await build({
    entryPoints: [join(repoRoot, entry)], bundle: true, write: false, minify: true, format: 'esm', platform: 'node',
    external: ['viem', 'node:*'], loader: { '.json': 'json' },
    define: { 'process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK': JSON.stringify(target) },
  })).outputFiles[0].text.toLowerCase()
  const testnetOnly = ['https://explorer.testnet.arc.io', COMPROMISED_CONTRACT]
  for (const entry of ['src/lib/server/config.ts', 'src/lib/auto-saver-write-safety.ts']) {
    const mainnetBundle = await bundle(entry, 'mainnet')
    for (const marker of testnetOnly) assert.ok(!mainnetBundle.includes(marker), `${entry}: Mainnet bundle must not contain ${marker}`)
  }
  const mainnetConfig = await bundle('src/lib/server/config.ts', 'mainnet')
  assert.ok(mainnetConfig.includes(COMPROMISED.toLowerCase()), 'the compromised development key stays in Mainnet role rejection')
  assert.ok(mainnetConfig.includes('refuses any testnet runtime selection'))
  const testnetConfig = await bundle('src/lib/server/config.ts', 'testnet')
  for (const marker of testnetOnly) assert.ok(testnetConfig.includes(marker), `Testnet bundle keeps ${marker}`)

  console.log('PASS: the fresh Arc Testnet manifest is selected when present, malformed or unsafe fresh manifests fail closed without falling back, and the old manifest remains a read-only fallback when the fresh file is absent')
} finally {
  process.chdir(originalCwd)
  for (const key of envKeys) {
    if (priorEnv[key] === undefined) delete process.env[key]
    else process.env[key] = priorEnv[key]
  }
  rmSync(workDir, { recursive: true, force: true })
}
