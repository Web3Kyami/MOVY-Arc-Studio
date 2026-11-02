import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi } from 'viem'

// Verify the fresh deployment when its manifest exists (the app selects it the same way);
// otherwise verify the old manifest. A fresh file that exists is never silently skipped.
const manifestFile = existsSync('contracts/deployed-testnet-fresh.json')
  ? 'contracts/deployed-testnet-fresh.json'
  : 'contracts/deployed-testnet.json'
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestFile, 'utf8'))
assert.equal(manifest.network, 'testnet')
assert.equal(manifest.chainId, 5_042_002)
const providers = [
  { name: 'official', url: 'https://rpc.testnet.arc.io' },
  // Independent Testnet endpoint published by viem's Arc Testnet chain config.
  { name: 'blockdaemon', url: 'https://rpc.blockdaemon.testnet.arc.network' },
]
const readOnlyMethods = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getCode', 'eth_call',
])
const execFileAsync = promisify(execFile)
let requestId = 0
async function rpc(url, method, params = []) {
  assert(readOnlyMethods.has(method), `refusing non-read-only RPC method ${method}`)
  const payload = JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
  // One bounded attempt per request: an unavailable historical endpoint must
  // be reported, not repeatedly queried or converted into synthetic evidence.
  const { stdout } = await execFileAsync('curl', [
    '--silent', '--show-error', '--fail', '--max-time', '12',
    '-H', 'content-type: application/json', '--data-binary', payload, url,
  ], { maxBuffer: 2 * 1024 * 1024 })
  const body = JSON.parse(stdout)
  if (body.error) throw new Error(`${method} RPC ${body.error.code}: ${body.error.message}`)
  return body.result
}

const readAbi = parseAbi([
  'function owner() view returns (address)',
  'function relayer() view returns (address)',
  'function usdc() view returns (address)',
])
const results = []
for (const provider of providers) {
  const result = { provider: provider.name, url: provider.url, status: 'BLOCKED' }
  try {
    result.chainId = Number(BigInt(await rpc(provider.url, 'eth_chainId')))
    if (result.chainId !== manifest.chainId) throw new Error(`wrong chain id ${result.chainId}`)
    result.latestBlock = Number(BigInt(await rpc(provider.url, 'eth_blockNumber')))
    result.transaction = await rpc(provider.url, 'eth_getTransactionByHash', [manifest.deployTxHash])
    result.receipt = await rpc(provider.url, 'eth_getTransactionReceipt', [manifest.deployTxHash])
    result.historyQueried = true
    const code = await rpc(provider.url, 'eth_getCode', [manifest.contractAddress, 'latest'])
    result.liveContract = {
      address: manifest.contractAddress,
      codeBytes: (code.length - 2) / 2,
      codeHash: code === '0x' ? null : keccak256(code),
    }
    if (code === '0x') {
      result.actualMismatch = 'manifest AutoSaver has no current runtime bytecode'
      throw new Error(result.actualMismatch)
    }
    for (const functionName of ['owner', 'relayer', 'usdc']) {
      const data = encodeFunctionData({ abi: readAbi, functionName })
      const encoded = await rpc(provider.url, 'eth_call', [{ to: manifest.contractAddress, data }, 'latest'])
      result.liveContract[functionName] = decodeFunctionResult({ abi: readAbi, functionName, data: encoded })
    }
    if (result.liveContract.owner.toLowerCase() !== manifest.deployer.toLowerCase()) {
      result.actualMismatch = 'live owner does not match the manifest deployer'
      throw new Error(result.actualMismatch)
    }
    if (result.liveContract.relayer.toLowerCase() !== manifest.relayer.toLowerCase()) {
      result.actualMismatch = 'live relayer does not match the manifest'
      throw new Error(result.actualMismatch)
    }
    if (result.liveContract.usdc.toLowerCase() !== manifest.usdcAddress.toLowerCase()) {
      result.actualMismatch = 'live USDC contract does not match the manifest'
      throw new Error(result.actualMismatch)
    }
    result.liveContract.rolesMatchManifest = true
    result.liveContract.knownUnsafeSharedOwnerRelayer = result.liveContract.owner.toLowerCase() === result.liveContract.relayer.toLowerCase()
    if (result.receipt) {
      assert.equal(result.receipt.status, '0x1', `${provider.name}: deployment receipt must have succeeded`)
      assert.equal(result.receipt.contractAddress?.toLowerCase(), manifest.contractAddress.toLowerCase(), `${provider.name}: receipt contract address must match manifest`)
      assert.equal(Number(BigInt(result.receipt.blockNumber)), manifest.deployBlock, `${provider.name}: receipt block must match manifest`)
      result.receiptStatus = 'PASS'
      result.status = 'PASS'
    } else {
      result.receiptStatus = result.transaction ? 'BLOCKED_RECEIPT_NOT_RETURNED' : 'BLOCKED_TRANSACTION_NOT_INDEXED'
      result.status = 'BLOCKED'
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    if (result.actualMismatch || result.receipt) result.status = 'FAIL'
  }
  results.push(result)
}

const providersWithReceipt = results.filter((result) => result.receiptStatus === 'PASS')
const actualMismatches = results.filter((result) => result.status === 'FAIL')
const liveMatches = results.some((result) => result.liveContract?.rolesMatchManifest && result.liveContract?.codeBytes > 0)
const hasProviderFailure = results.some((result) => result.error)
const allHistoryQueried = results.every((result) => result.historyQueried === true)
const status = actualMismatches.length ? 'FAIL'
  : providersWithReceipt.length ? 'PASS'
    : liveMatches ? 'BLOCKED'
      : 'BLOCKED'
const classification = providersWithReceipt.length
  ? 'Deployment receipt was independently verified.'
  : results.some((result) => result.transaction)
    ? 'A provider returns the transaction but no receipt; historical receipt availability is blocked.'
    : liveMatches && !allHistoryQueried
      ? 'Current bytecode and roles match the manifest, but at least one provider did not complete historical lookup. The cause cannot be classified.'
    : liveMatches
      ? 'Current bytecode and roles match the manifest, but neither provider indexed the deployment transaction. Cannot distinguish pruned/unavailable history from a stale manifest hash.'
      : hasProviderFailure
        ? 'Historical and live deployment state could not be fully verified because at least one provider failed.'
        : 'Neither provider returned deployment history or a matching live contract state.'
const evidence = {
  status,
  classification,
  mode: 'read-only diagnostic; no wallet, signature, deployment, or transaction broadcast',
  manifest: {
    file: manifestFile,
    network: manifest.network,
    chainId: manifest.chainId,
    contractAddress: manifest.contractAddress,
    deployBlock: manifest.deployBlock,
    deployTxHash: manifest.deployTxHash,
    deployer: manifest.deployer,
    relayer: manifest.relayer,
    usdcAddress: manifest.usdcAddress,
  },
  providers: results,
  unsafeFinancialWritesBlockedByConnectedProduct: true,
}
const output = process.env.TESTNET_PROVENANCE_EVIDENCE || 'artifacts/testnet-deployment-provenance.json'
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(JSON.stringify(evidence, null, 2))
if (status === 'FAIL') process.exitCode = 1
