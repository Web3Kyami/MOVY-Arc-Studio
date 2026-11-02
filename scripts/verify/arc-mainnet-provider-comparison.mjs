import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ARC_USDC, ARC_DOCS, readOnlyRpc, verifyArcMainnetReadOnly } from './arc-mainnet-readonly.mjs'

// These endpoints are intentionally fixed and public. This verifier does not
// read credentials, retry requests, or issue any transaction-capable RPC call.
export const PROVIDERS = [
  { name: 'Official Arc RPC', url: 'https://rpc.mainnet.arc.io' },
  { name: 'Blockdaemon independent RPC', url: 'https://rpc.blockdaemon.mainnet.arc.io' },
]

export function compareProviderEvidence(providers) {
  const successful = providers.filter((provider) => provider.status === 'PASS')
  if (successful.length !== PROVIDERS.length) {
    return {
      status: 'BLOCKED',
      reason: 'Both official and independent provider reads must succeed before comparison.',
      providerCount: successful.length,
      requiredProviderCount: PROVIDERS.length,
    }
  }

  const [official, independent] = successful.map((provider) => provider.evidence)
  const codeMatches = official.usdcRuntimeBytecode === independent.usdcRuntimeBytecode
  const comparison = {
    status: 'PASS',
    chainIdMatches: official.chainId === independent.chainId && official.chainId === 5042,
    usdcAddressMatches: official.usdcAddress.toLowerCase() === independent.usdcAddress.toLowerCase()
      && official.usdcAddress.toLowerCase() === ARC_USDC.toLowerCase(),
    usdcBytecodeMatches: codeMatches,
    usdcCodeHashMatches: official.usdcRuntimeCodeHash === independent.usdcRuntimeCodeHash,
    erc20DecimalsMatch: official.erc20Decimals === independent.erc20Decimals
      && official.erc20Decimals === 6,
    latestBlockDelta: (BigInt(official.latestBlock) - BigInt(independent.latestBlock)).toString(),
    nativeBalanceWei: {
      official: official.nativeBalanceWei,
      independent: independent.nativeBalanceWei,
      matches: official.nativeBalanceWei === independent.nativeBalanceWei,
    },
    gasPriceWei: {
      official: official.observedGasPriceWei,
      independent: independent.observedGasPriceWei,
      matches: official.observedGasPriceWei === independent.observedGasPriceWei,
    },
  }

  const identityAgrees = comparison.chainIdMatches
    && comparison.usdcAddressMatches
    && comparison.usdcBytecodeMatches
    && comparison.usdcCodeHashMatches
    && comparison.erc20DecimalsMatch
  comparison.status = identityAgrees ? 'PASS' : 'FAIL'
  return comparison
}

function safeFailure(error, stage) {
  return {
    stage,
    message: error instanceof Error ? error.message : 'Unknown RPC failure',
  }
}

export async function runArcMainnetProviderComparison({
  providers = PROVIDERS,
  verify = verifyArcMainnetReadOnly,
  evidencePath = process.env.ARC_MAINNET_READONLY_EVIDENCE || 'artifacts/arc-mainnet-readonly/mainnet-rpc-verification.json',
  env = process.env,
} = {}) {
  assert.equal(providers.length, PROVIDERS.length, 'Exactly two allowlisted providers are required')
  assert.deepEqual(providers.map(({ url }) => url), PROVIDERS.map(({ url }) => url), 'Provider URLs must match the reviewed allowlist')

  const startedAt = new Date().toISOString()
  const records = []
  for (const provider of providers) {
    let stage = 'URL validation'
    try {
      const evidence = await verify({
        env: { ...env, ARC_MAINNET_RPC_URL: provider.url },
        fetchRpc: async (url, method, params, id) => {
          stage = method
          // The verifier uses only eth_chainId, eth_blockNumber, eth_getCode,
          // eth_call(decimals), eth_getBalance, and eth_gasPrice.
          return readOnlyRpc(url, method, params, id)
        },
      })
      records.push({ name: provider.name, host: new URL(provider.url).hostname, status: 'PASS', evidence })
    } catch (error) {
      records.push({
        name: provider.name,
        host: new URL(provider.url).hostname,
        status: 'BLOCKED',
        failure: safeFailure(error, stage),
      })
    }
  }

  const comparison = compareProviderEvidence(records)
  if (comparison.status === 'FAIL') comparison.reason = 'The independent providers disagree on chain identity or canonical USDC bytecode.'
  const report = {
    result: comparison.status,
    evidenceClass: 'live_rpc_attempt',
    successfulLiveVerification: comparison.status === 'PASS',
    readOnly: true,
    transactionsSent: false,
    startedAt,
    completedAt: new Date().toISOString(),
    commitSha: env.GITHUB_SHA || null,
    workflowRunId: env.GITHUB_RUN_ID || null,
    workflowRunAttempt: env.GITHUB_RUN_ATTEMPT || null,
    requiredChecks: {
      chainId: 5042,
      canonicalUsdcAddress: ARC_USDC,
      erc20Decimals: 6,
      methods: ['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call(decimals)', 'eth_getBalance', 'eth_gasPrice'],
      requestPolicy: 'One sequential attempt per endpoint; no retry, signing, funding, or broadcast.',
    },
    providers: records,
    comparison,
    officialDocumentation: ARC_DOCS,
  }

  await mkdir(dirname(evidencePath), { recursive: true })
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report
}

if (process.argv[1]?.endsWith('/arc-mainnet-provider-comparison.mjs')) {
  try {
    const report = await runArcMainnetProviderComparison()
    const summary = {
      result: report.result,
      evidenceClass: report.evidenceClass,
      readOnly: report.readOnly,
      commitSha: report.commitSha,
      providers: report.providers.map((provider) => ({
        name: provider.name,
        host: provider.host,
        status: provider.status,
        failure: provider.failure,
        evidence: provider.evidence && {
          chainId: provider.evidence.chainId,
          latestBlock: provider.evidence.latestBlock,
          usdcAddress: provider.evidence.usdcAddress,
          usdcCodeBytes: provider.evidence.usdcCodeBytes,
          usdcRuntimeCodeHash: provider.evidence.usdcRuntimeCodeHash,
          erc20Decimals: provider.evidence.erc20Decimals,
          nativeBalanceWei: provider.evidence.nativeBalanceWei,
          nativeBalanceUnit: provider.evidence.nativeBalanceUnit,
          observedGasPriceWei: provider.evidence.observedGasPriceWei,
        },
      })),
      comparison: report.comparison,
    }
    console.log(JSON.stringify(summary, null, 2))
    if (report.result !== 'PASS') process.exitCode = 1
  } catch (error) {
    console.error(`Arc Mainnet RPC comparison did not complete: ${error instanceof Error ? error.message : 'unknown failure'}`)
    process.exitCode = 1
  }
}
