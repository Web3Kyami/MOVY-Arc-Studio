import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Offline check of `config/networks/arc-mainnet.env.template`. It makes no network call. It confirms
 * the template carries exactly the reviewed Arc Mainnet facts, no Testnet
 * variable, no secret, and keeps every financial action disabled.
 */
const parse = (text) => Object.fromEntries(
  text.split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)

const text = readFileSync(new URL('../config/networks/arc-mainnet.env.template', import.meta.url), 'utf8')
const env = parse(text)
const manifest = JSON.parse(readFileSync(new URL('../config/networks/arc-mainnet.json', import.meta.url), 'utf8'))

assert.equal(env.MOVY_TARGET_NETWORK, 'mainnet')
assert.equal(env.NEXT_PUBLIC_MOVY_TARGET_NETWORK, 'mainnet')
assert.equal(env.NEXT_PUBLIC_MOVY_CHAIN_ID, '5042')
assert.equal(env.MOVY_DATABASE_NETWORK, 'mainnet')
assert.equal(env.ARC_MAINNET_RPC_URL, 'https://rpc.mainnet.arc.io')
assert.equal(env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL, env.ARC_MAINNET_RPC_URL)
assert.equal(env.NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET, manifest.contracts.autoSaver.address, 'select only the verified current-source deployment')
assert.equal(env.NEXT_PUBLIC_MOVY_AUTO_SAVER_DEPLOY_BLOCK_MAINNET, String(manifest.contracts.autoSaver.deployBlock))
assert.equal(env.NEXT_PUBLIC_MOVY_ADDRESS_MAINNET, '0xFc194011A769e90D93B51Dd9507d69dfc4681164')
assert.equal(env.NEXT_PUBLIC_MOVY_DEPLOY_BLOCK_MAINNET, '26036021')

assert.equal(env.MOVY_WORKER_ENABLED, 'false')
assert.equal(env.MOVY_RELAYER_ENABLED, 'false')
assert.equal(env.MOVY_DEMO_MERCHANT_PAYMENT_ENABLED, 'false')
assert.equal(env.MOVY_PRODUCT_ORIGINS, 'http://localhost:3211')
assert.equal(env.MOVY_DEMO_ORIGINS, 'http://localhost:3212')
assert.notEqual(env.MOVY_PRODUCT_ORIGINS, env.MOVY_DEMO_ORIGINS)

for (const key of Object.keys(env)) {
  assert.ok(!/(?:^|_)TESTNET(?:_|$)/i.test(key), `template must not set Testnet variable ${key}`)
  assert.ok(!/PRIVATE_KEY|SECRET|TOKEN|DATABASE_URL/.test(key), `template must not carry a secret: ${key}`)
}

// Owner-approved initial pilot fee policy. Relayer ceilings match it exactly.
const approvedFees = {
  NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: '20000000000',
  NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: '30000000000',
  NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: '1000000000',
  NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: '50000000000000000',
  MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: '30000000000',
  MOVY_RELAYER_MAX_TX_FEE_WEI: '50000000000000000',
}
for (const [key, value] of Object.entries(approvedFees)) assert.equal(env[key], value, `${key} must match the approved fee policy`)
assert.ok(BigInt(env.NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET) >= 20_000_000_000n, 'minimum base fee must be at least the 20 Gwei Arc floor')
assert.ok(BigInt(env.NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET) <= BigInt(env.NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET))
assert.equal(env.MOVY_RELAYER_MAX_FEE_PER_GAS_WEI, env.NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET)
assert.equal(env.MOVY_RELAYER_MAX_TX_FEE_WEI, env.NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET)

console.log('Mainnet env template checks passed')
