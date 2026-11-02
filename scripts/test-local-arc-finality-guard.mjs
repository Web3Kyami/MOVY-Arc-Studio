import assert from 'node:assert/strict'
import { getFinalizedBlockNumber } from '../src/lib/server/observer.ts'
import { getAutoSaverAddress, getDeployBlock } from '../src/lib/server/config.ts'

const testEnvKeys = [
  'MOVY_LOCAL_ARC_CERTIFICATION', 'ARC_TESTNET_RPC_URL', 'NEXT_PUBLIC_ARC_TESTNET_RPC_URL',
  'NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET', 'MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK',
  'MOVY_TARGET_NETWORK', 'NEXT_PUBLIC_MOVY_TARGET_NETWORK', 'NEXT_PUBLIC_MOVY_CHAIN_ID',
  'MOVY_DATABASE_NETWORK', 'MOVY_WORKER_ENABLED', 'MOVY_RELAYER_ENABLED',
  'NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL', 'NODE_ENV',
]
const original = Object.fromEntries(testEnvKeys.map((key) => [key, process.env[key]]))

async function rejectedBeforeRpc(expectedMessage) {
  let rpcCalls = 0
  const client = {
    getChainId: async () => {
      rpcCalls++
      return 5042002
    },
    request: async () => {
      rpcCalls++
      throw new Error('unexpected RPC call')
    },
  }
  await assert.rejects(getFinalizedBlockNumber(client), new RegExp(expectedMessage))
  assert.equal(rpcCalls, 0, 'local finality guard must reject before making an RPC call')
}

try {
  process.env.MOVY_TARGET_NETWORK = 'testnet'
  process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK = 'testnet'
  process.env.NEXT_PUBLIC_MOVY_CHAIN_ID = '5042002'
  process.env.MOVY_DATABASE_NETWORK = 'testnet'
  process.env.MOVY_WORKER_ENABLED = 'false'
  process.env.MOVY_RELAYER_ENABLED = 'false'
  process.env.NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL = 'https://explorer.testnet.arc.io'
  process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET = '0x1111111111111111111111111111111111111111'
  process.env.MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK = '1'
  process.env.MOVY_LOCAL_ARC_CERTIFICATION = 'true'
  process.env.ARC_TESTNET_RPC_URL = 'http://127.0.0.1:8545'
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC_URL
  process.env.NODE_ENV = 'production'
  await rejectedBeforeRpc('disabled in production')
  assert.throws(() => getAutoSaverAddress(5042002), /production|deployment manifest/i,
    'a generated local deployment must not bypass production Testnet manifest checks')

  process.env.NODE_ENV = 'test'
  process.env.ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io'
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC_URL
  await rejectedBeforeRpc('requires a loopback RPC URL')
  assert.throws(() => getAutoSaverAddress(5042002), /requires a loopback RPC URL/,
    'a local generated address must not be accepted with a public RPC')

  process.env.ARC_TESTNET_RPC_URL = 'http://127.0.0.1:8545'
  process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL = process.env.ARC_TESTNET_RPC_URL
  assert.equal(getAutoSaverAddress(5042002), '0x1111111111111111111111111111111111111111')
  assert.equal(getDeployBlock(5042002), 1)
  assert.throws(() => getAutoSaverAddress(5042), /does not match this MOVY deployment/,
    'local deployment override must remain Testnet-only')

  console.log('PASS: local Arc certification uses only an explicit non-production loopback deployment; public RPC, production, wrong-chain, and finality bypasses are rejected')
} finally {
  for (const key of testEnvKeys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
}
