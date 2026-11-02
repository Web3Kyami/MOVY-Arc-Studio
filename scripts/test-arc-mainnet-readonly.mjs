import assert from 'node:assert/strict'
import { keccak256 } from 'viem'
import { compareProviderEvidence, PROVIDERS } from './verify/arc-mainnet-provider-comparison.mjs'
import { verifyArcMainnetReadOnly } from './verify/arc-mainnet-readonly.mjs'

const calls = []
const result = await verifyArcMainnetReadOnly({
  env: { ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.io' },
  fetchRpc: async (url, method, params, id) => {
    calls.push({ host: url.hostname, method, params, id })
    return {
      eth_chainId: '0x13b2',
      eth_blockNumber: '0x1234',
      eth_getCode: '0x60016000',
      eth_call: '0x' + '0'.repeat(63) + '6',
      eth_getBalance: '0x0',
      eth_gasPrice: '0x4a817c800',
    }[method]
  },
})
assert.equal(result.readOnly, true)
assert.equal(result.chainId, 5042)
assert.equal(result.latestBlock, '4660')
assert.equal(result.erc20Decimals, 6)
assert.equal(result.nativeBalanceWei, '0')
assert.equal(result.usdcRuntimeCodeHash, keccak256('0x60016000'))
assert.equal(result.observedGasPriceWei, '20000000000')
assert.deepEqual(calls.map(({ method }) => method), [
  'eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getBalance', 'eth_gasPrice',
])
assert(calls.every(({ host }) => host === 'rpc.mainnet.arc.io'))
const comparison = compareProviderEvidence(PROVIDERS.map((provider) => ({
  name: provider.name,
  status: 'PASS',
  evidence: { ...result, rpcHost: new URL(provider.url).hostname },
})))
assert.equal(comparison.status, 'PASS')
assert.equal(comparison.latestBlockDelta, '0')
assert.equal(comparison.nativeBalanceWei.matches, true)
assert.equal(comparison.gasPriceWei.matches, true)
const mismatchedCode = compareProviderEvidence([
  { status: 'PASS', evidence: result },
  { status: 'PASS', evidence: { ...result, usdcRuntimeBytecode: '0x6002', usdcRuntimeCodeHash: keccak256('0x6002') } },
])
assert.equal(mismatchedCode.status, 'FAIL')
assert.equal(compareProviderEvidence([{ status: 'BLOCKED' }, { status: 'PASS' }]).status, 'BLOCKED')
await assert.rejects(
  verifyArcMainnetReadOnly({
    env: { ARC_MAINNET_RPC_URL: 'https://rpc.mainnet.arc.io' },
    fetchRpc: async () => '0x4c4b42',
  }),
  /chain ID must be Arc Mainnet/,
)
console.log('PASS: offline mocked-RPC unit fixtures validate read-only checks and provider comparison; this is not live Mainnet evidence')
