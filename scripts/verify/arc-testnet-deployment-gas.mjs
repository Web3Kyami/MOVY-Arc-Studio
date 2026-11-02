import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io'
const ARTIFACT = 'contracts/out/MovyAutoSaver.sol/MovyAutoSaver.json'
const USDC = '0x3600000000000000000000000000000000000000'
// Public, non-funded placeholders used only as eth_estimateGas inputs. They
// have no keys in this process and are never signed or written to the chain.
const OWNER = '0x1111111111111111111111111111111111111111'
const RELAYER = '0x2222222222222222222222222222222222222222'
const MAX_FEE_PER_GAS_WEI = 25_000_000_000n
const MAX_DEPLOYMENT_FEE_WEI = 150_000_000_000_000_000n // 0.15 native USDC, 18 decimals.
const OUT = process.env.ARC_TESTNET_DEPLOY_GAS_EVIDENCE
const allowedMethods = new Set(['eth_chainId', 'eth_getCode', 'eth_call', 'eth_estimateGas'])

const rpcUrl = new URL(RPC)
assert.equal(rpcUrl.protocol, 'https:', 'Arc Testnet RPC must use HTTPS')
assert.equal(rpcUrl.username, '', 'RPC URL must not embed credentials')
assert.equal(rpcUrl.password, '', 'RPC URL must not embed credentials')

const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
const bytecode = artifact.bytecode?.object?.replace(/^0x/, '')
assert(bytecode && /^[0-9a-f]+$/i.test(bytecode), 'Foundry deployment bytecode is missing or malformed')
const constructorInputs = artifact.abi.find((item) => item.type === 'constructor')?.inputs ?? []
assert.deepEqual(constructorInputs.map((input) => input.type), ['address', 'address'], 'Unexpected AutoSaver constructor')
const encodeAddress = (address) => address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const initCode = `0x${bytecode}${encodeAddress(USDC)}${encodeAddress(RELAYER)}`

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

const [chainIdRaw, code, decimalsRaw, gasEstimateRaw] = await Promise.all([
  readRpc('eth_chainId'),
  readRpc('eth_getCode', [USDC, 'latest']),
  readRpc('eth_call', [{ to: USDC, data: '0x313ce567' }, 'latest']),
  readRpc('eth_estimateGas', [{ from: OWNER, data: initCode, value: '0x0' }]),
])
const chainId = Number(BigInt(chainIdRaw))
const decimals = Number(BigInt(decimalsRaw))
const estimatedGas = BigInt(gasEstimateRaw)
assert.equal(chainId, 5_042_002, 'RPC must be Arc Testnet')
assert(code && code !== '0x', 'canonical Arc Testnet USDC must have deployed code')
assert.equal(decimals, 6, 'canonical Arc Testnet ERC-20 USDC must report six decimals')
assert(estimatedGas > 0n, 'eth_estimateGas returned zero')

const bufferedGasLimit = (estimatedGas * 120n + 99n) / 100n
const maximumFeeWei = bufferedGasLimit * MAX_FEE_PER_GAS_WEI
assert(
  maximumFeeWei <= MAX_DEPLOYMENT_FEE_WEI,
  '20% buffered deployment simulation exceeds the approved 0.15 native USDC cap at 25 Gwei',
)
const nativeUsdcWhole = maximumFeeWei / 1_000_000_000_000_000_000n
const nativeUsdcFraction = (maximumFeeWei % 1_000_000_000_000_000_000n)
  .toString()
  .padStart(18, '0')
  .replace(/0+$/, '')
const evidence = {
  result: 'PASS',
  mode: 'eth_estimateGas simulation only; no signing, deployment, or broadcast',
  chainId,
  rpc: new URL(RPC).origin,
  canonicalUsdc: USDC,
  usdcDecimals: decimals,
  deploymentBytecodeBytes: bytecode.length / 2,
  roleInputs: 'distinct non-funded public placeholders; not real certification identities',
  estimatedGas: estimatedGas.toString(),
  bufferedGasLimitWith20Percent: bufferedGasLimit.toString(),
  maxFeePerGasWei: MAX_FEE_PER_GAS_WEI.toString(),
  maximumDeploymentFeeWei: maximumFeeWei.toString(),
  maximumDeploymentFeeNativeUsdc: nativeUsdcFraction
    ? `${nativeUsdcWhole}.${nativeUsdcFraction}`
    : nativeUsdcWhole.toString(),
  approvedDeploymentFeeCapWei: MAX_DEPLOYMENT_FEE_WEI.toString(),
}
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'w' })
}
console.log(JSON.stringify(evidence))
