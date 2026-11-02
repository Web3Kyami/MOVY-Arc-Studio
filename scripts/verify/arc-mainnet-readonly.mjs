import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { keccak256 } from 'viem'

export const MAINNET_RPC = 'https://rpc.mainnet.arc.io'
export const ARC_USDC = '0x3600000000000000000000000000000000000000'
export const ARC_DOCS = [
  'https://docs.arc.io/arc/references/connect-to-arc',
  'https://docs.arc.io/arc/references/contract-addresses',
]

function rpcUrlFromEnvironment(env = process.env) {
  const value = env.ARC_MAINNET_RPC_URL || MAINNET_RPC
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('ARC_MAINNET_RPC_URL must be a valid HTTPS URL')
  }
  assert.equal(url.protocol, 'https:', 'Arc Mainnet RPC must use HTTPS')
  assert(!/testnet/i.test(url.hostname), 'Mainnet RPC must not point to Testnet')
  assert(!url.username && !url.password && !url.search && !url.hash, 'RPC URL must not contain credentials, query, or fragment data')
  return url
}

export async function readOnlyRpc(url, method, params, id) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(12_000),
    })
  } catch (error) {
    const causeCode = error?.cause?.code ?? error?.code
    const safeCode = typeof causeCode === 'string' && /^[A-Z0-9_]+$/.test(causeCode)
      ? causeCode
      : undefined
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`${method} timed out after 12000ms at ${url.hostname}`)
    }
    throw new Error(`${method} network request failed at ${url.hostname}${safeCode ? ` (${safeCode})` : ` (${error?.name || 'network error'})`}`)
  }
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status} at ${url.hostname}`)
  const payload = await response.json()
  if (payload.error || payload.id !== id) throw new Error(`${method} returned an invalid or failed JSON-RPC response at ${url.hostname}`)
  return payload.result
}

export async function verifyArcMainnetReadOnly({ env = process.env, fetchRpc = readOnlyRpc } = {}) {
  const url = rpcUrlFromEnvironment(env)
  const chainId = await fetchRpc(url, 'eth_chainId', [], 1)
  assert.equal(chainId, '0x13b2', 'RPC chain ID must be Arc Mainnet (5042)')
  const blockHex = await fetchRpc(url, 'eth_blockNumber', [], 2)
  assert.match(blockHex, /^0x[0-9a-f]+$/i, 'RPC latest block must be hexadecimal')
  const latestBlock = BigInt(blockHex).toString()
  const usdcCode = await fetchRpc(url, 'eth_getCode', [ARC_USDC, 'latest'], 3)
  assert(typeof usdcCode === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(usdcCode), 'Arc USDC must have deployed bytecode')
  const decimalsHex = await fetchRpc(url, 'eth_call', [{ to: ARC_USDC, data: '0x313ce567' }, 'latest'], 4)
  assert.equal(BigInt(decimalsHex), 6n, 'Arc USDC ERC-20 allowance interface must use six decimals')
  // eth_getBalance is a read-only check of the EVM native-value RPC path. Arc
  // documents native USDC as 18 decimals; this check does not infer units from
  // an arbitrary account balance or send a transaction.
  const nativeBalance = await fetchRpc(url, 'eth_getBalance', ['0x0000000000000000000000000000000000000001', 'latest'], 5)
  assert.match(nativeBalance, /^0x[0-9a-f]+$/i, 'RPC native balance must be hexadecimal')
  const gasPrice = await fetchRpc(url, 'eth_gasPrice', [], 6)
  assert.match(gasPrice, /^0x[0-9a-f]+$/i, 'RPC gas price must be hexadecimal')
  return {
    result: 'PASS',
    readOnly: true,
    rpcHost: url.hostname,
    chainId: 5042,
    latestBlock,
    usdcAddress: ARC_USDC,
    usdcCodeBytes: (usdcCode.length - 2) / 2,
    usdcRuntimeBytecode: usdcCode.toLowerCase(),
    usdcRuntimeCodeHash: keccak256(usdcCode),
    erc20Decimals: Number(BigInt(decimalsHex)),
    nativeBalanceWei: BigInt(nativeBalance).toString(),
    nativeBalanceUnit: 'wei; Arc native USDC uses 18 decimals per official Arc documentation',
    observedGasPriceWei: BigInt(gasPrice).toString(),
    officialDocumentation: ARC_DOCS,
    observedAt: new Date().toISOString(),
  }
}

if (process.argv[1]?.endsWith('/arc-mainnet-readonly.mjs')) {
  try {
    const evidence = await verifyArcMainnetReadOnly()
    const output = process.env.ARC_MAINNET_READONLY_EVIDENCE
    if (output) await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(evidence, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown RPC failure'
    console.error(`Arc Mainnet read-only verification blocked: ${message}`)
    process.exitCode = 1
  }
}
