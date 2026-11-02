import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io'
const USDC = '0x3600000000000000000000000000000000000000'
const OUT = process.env.ARC_TESTNET_READONLY_EVIDENCE
const allowedMethods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call'])
const rpcUrl = new URL(RPC)
assert.equal(rpcUrl.protocol, 'https:', 'Arc Testnet RPC must use HTTPS')
assert.equal(rpcUrl.username, '', 'RPC URL must not embed credentials')
assert.equal(rpcUrl.password, '', 'RPC URL must not embed credentials')

const execFileAsync = promisify(execFile)
let requestId = 0
async function readRpc(method, params = []) {
  assert(allowedMethods.has(method), `refusing non-read-only RPC method ${method}`)
  const payload = JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
  const { stdout } = await execFileAsync('curl', [
    '--silent', '--show-error', '--fail', '--max-time', '15',
    '--retry', '2', '--retry-all-errors', '--retry-delay', '1', '--retry-max-time', '8',
    '-H', 'content-type: application/json', '--data-binary', payload, RPC,
  ], { maxBuffer: 1024 * 1024 })
  const result = JSON.parse(stdout)
  if (result.error) throw new Error(`Read-only RPC ${method} failed with code ${result.error.code}`)
  return result.result
}

const [chainIdRaw, blockRaw, code, decimalsRaw] = await Promise.all([
  readRpc('eth_chainId'),
  readRpc('eth_blockNumber'),
  readRpc('eth_getCode', [USDC, 'latest']),
  readRpc('eth_call', [{ to: USDC, data: '0x313ce567' }, 'latest']),
])
const chainId = Number(BigInt(chainIdRaw))
const blockNumber = Number(BigInt(blockRaw))
const decimals = Number(BigInt(decimalsRaw))
assert.equal(chainId, 5_042_002, 'RPC must be Arc Testnet')
assert(code && code !== '0x', 'canonical Arc Testnet USDC must have deployed code')
assert.equal(decimals, 6, 'canonical Arc Testnet ERC-20 USDC must report six decimals')

const evidence = {
  result: 'PASS',
  mode: 'read-only; no wallet or contract writes',
  chainId,
  blockNumber,
  canonicalUsdc: USDC,
  codeBytes: (code.length - 2) / 2,
  erc20Decimals: decimals,
}
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'w' })
}
console.log(JSON.stringify(evidence))
