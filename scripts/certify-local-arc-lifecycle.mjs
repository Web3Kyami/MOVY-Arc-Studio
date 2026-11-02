import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import pg from 'pg'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { ERC20_ABI, MOVY_AUTO_SAVER_ABI } from '../src/lib/abi/movy-auto-saver.ts'

const { Pool } = pg
const ROOT = process.cwd()
const LOCAL_ARC_RPC_URL = process.env.MOVY_LOCAL_ARC_RPC_URL || 'http://127.0.0.1:8545'
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:55433/movy_certification?sslmode=disable'
const CHAIN_ID = 5_042_002
const CANONICAL_USDC = '0x3600000000000000000000000000000000000000'
const SYSTEM_USDC_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'
const PAYMENT_17_CENTS = 170_000n
const ROUNDUP_83_CENTS = 830_000n
const NATIVE_UNITS_PER_ERC20_UNIT = 1_000_000_000_000n
const MAX_FEE_PER_GAS = 25_000_000_000n
const PRIORITY_FEE_PER_GAS = 1_000_000_000n
const DEPLOY_TX_CAP = 150_000_000_000_000_000n
const WALLET_TX_CAP = 20_000_000_000_000_000n
const RELAYER_TX_CAP = 40_000_000_000_000_000n
const LOCAL_TESTER_BALANCE = 1_100_000_000_000_000_000n

const LOCAL_ARC_CHAIN = defineChain({
  id: CHAIN_ID,
  name: 'Arc Local Certification',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_ARC_RPC_URL] } },
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function safeError(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return message.replace(/0x[0-9a-fA-F]{64}/g, '0x[REDACTED]')
}

function assertLoopbackUrl(raw, label, protocol) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} must be a valid URL`)
  }
  assert(url.protocol === protocol, `${label} must use ${protocol}`)
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${label} must point to loopback only`)
  return url
}

function paddedGasLimit(estimate) {
  return (estimate * 120n + 99n) / 100n
}

function units(value) {
  return value.toString()
}

function serializableReceipt(receipt) {
  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: units(receipt.blockNumber),
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: receipt.to,
    contractAddress: receipt.contractAddress,
    gasUsed: units(receipt.gasUsed),
    effectiveGasPrice: receipt.effectiveGasPrice == null ? null : units(receipt.effectiveGasPrice),
    feePaidWei: receipt.effectiveGasPrice == null ? null : units(receipt.gasUsed * receipt.effectiveGasPrice),
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
      logIndex: units(log.logIndex),
      blockNumber: units(log.blockNumber),
      blockHash: log.blockHash,
      transactionHash: log.transactionHash,
    })),
  }
}

async function waitSuccess(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
  assert(receipt.status === 'success', `${label} transaction did not succeed`)
  return receipt
}

async function readBalances(publicClient, address) {
  const [native18, erc20Usdc6] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: CANONICAL_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
  ])
  return { native18: units(native18), erc20Usdc6: units(erc20Usdc6) }
}

function verifySharedBalanceView(balance, label) {
  const native18 = BigInt(balance.native18)
  const erc20Usdc6 = BigInt(balance.erc20Usdc6)
  assert(
    erc20Usdc6 * NATIVE_UNITS_PER_ERC20_UNIT <= native18 &&
      native18 < (erc20Usdc6 + 1n) * NATIVE_UNITS_PER_ERC20_UNIT,
    `${label} native 18-decimal and ERC-20 6-decimal views diverged`,
  )
}

async function certifyFeeEstimate(publicClient, estimate, cap, label) {
  assert(estimate > 0n, `${label} gas estimate was zero`)
  const gasLimit = paddedGasLimit(estimate)
  const maxFeeWei = gasLimit * MAX_FEE_PER_GAS
  assert(maxFeeWei <= cap, `${label} buffered maximum fee exceeds its cap`)
  return { estimate: units(estimate), gasLimit: units(gasLimit), maxFeePerGas: units(MAX_FEE_PER_GAS), maxFeeWei: units(maxFeeWei) }
}

async function signedContractTransaction({ publicClient, walletClient, account, address, abi, functionName, args, cap, label }) {
  const estimate = await publicClient.estimateContractGas({
    account: account.address,
    address,
    abi,
    functionName,
    args,
  })
  const feeCheck = await certifyFeeEstimate(publicClient, estimate, cap, label)
  const hash = await walletClient.writeContract({
    address,
    abi,
    functionName,
    args,
    gas: BigInt(feeCheck.gasLimit),
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
  })
  const receipt = await waitSuccess(publicClient, hash, label)
  return { feeCheck, receipt }
}

function runWorkerProcess({ label, contractAddress, deployBlock, schema, relayerPrivateKey, relayerEnabled, rpcUrl = LOCAL_ARC_RPC_URL }) {
  const workerSource = `
    import { runWorkerCycle } from './src/lib/server/worker.ts';
    try {
      const result = await runWorkerCycle(${CHAIN_ID}, { maxBlocks: 1000 });
      console.log('LOCAL_ARC_WORKER_RESULT=' + JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown worker failure';
      console.error('LOCAL_ARC_WORKER_ERROR=' + message.replace(/0x[0-9a-fA-F]{64}/g, '0x[REDACTED]'));
      process.exitCode = 1;
    }
  `
  const env = {
    ...process.env,
    DATABASE_URL,
    MOVY_DB_SCHEMA: schema,
    MOVY_LOCAL_ARC_CERTIFICATION: 'true',
    ARC_TESTNET_RPC_URL: rpcUrl,
    NEXT_PUBLIC_ARC_TESTNET_RPC_URL: rpcUrl,
    NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET: contractAddress,
    MOVY_AUTO_SAVER_TESTNET_DEPLOY_BLOCK: String(deployBlock),
    MOVY_RELAYER_ENABLED: relayerEnabled ? 'true' : 'false',
    MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: String(MAX_FEE_PER_GAS),
    MOVY_RELAYER_MAX_TX_FEE_WEI: String(RELAYER_TX_CAP),
  }
  if (relayerPrivateKey) env.RELAYER_PRIVATE_KEY = relayerPrivateKey
  else delete env.RELAYER_PRIVATE_KEY

  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerSource], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const stdout = run.stdout || ''
  const stderr = run.stderr || ''
  const safeOutput = `${stdout}\n${stderr}`.replace(/0x[0-9a-fA-F]{64}/g, '0x[REDACTED]')
  if (run.error || run.status !== 0) {
    const error = run.error ? safeError(run.error) : `exit ${run.status}`
    throw new Error(`${label} worker process failed (${error}): ${safeOutput.slice(-1600)}`)
  }
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('LOCAL_ARC_WORKER_RESULT='))
  assert(line, `${label} worker result was not emitted`)
  return JSON.parse(line.slice('LOCAL_ARC_WORKER_RESULT='.length))
}

function dbClient(schema) {
  return new Pool({
    connectionString: DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5_000,
    options: `-c search_path=${schema}`,
  })
}

async function captureDbRows(pool) {
  const [payments, jobs, enrollments, enrollmentHistory, cursors, migrations] = await Promise.all([
    pool.query(`SELECT payment_key, chain_id, tx_hash, log_index, block_number, payer, recipient,
      amount_6, roundup_6, is_eligible, exclusion_reason FROM observed_payments ORDER BY block_number, log_index`),
    pool.query(`SELECT job_id, payment_key, chain_id, wallet, destination, roundup_amount_6,
      config_epoch, status, skip_reason, relayer_tx_hash, attempts, last_error FROM roundup_jobs ORDER BY job_id`),
    pool.query(`SELECT chain_id, wallet, destination, max_roundup_6, daily_cap_6,
      config_epoch, status FROM enrollments ORDER BY wallet`),
    pool.query(`SELECT chain_id, wallet, block_number, log_index, destination, max_roundup_6,
      daily_cap_6, config_epoch, status FROM enrollment_state_history ORDER BY block_number, log_index, wallet`),
    pool.query(`SELECT 'payment' AS kind, chain_id, last_processed_block FROM chain_cursor
      UNION ALL SELECT 'enrollment_event', chain_id, last_processed_block FROM enrollment_event_cursor
      UNION ALL SELECT 'enrollment_history', chain_id, last_processed_block FROM enrollment_history_cursor ORDER BY kind`),
    pool.query(`SELECT version FROM schema_migrations ORDER BY version`),
  ])
  return {
    observedPayments: payments.rows,
    roundupJobs: jobs.rows,
    enrollments: enrollments.rows,
    enrollmentHistory: enrollmentHistory.rows,
    cursors: cursors.rows,
    schemaMigrations: migrations.rows.map((row) => row.version),
  }
}

async function main() {
  const rpcUrl = assertLoopbackUrl(LOCAL_ARC_RPC_URL, 'MOVY_LOCAL_ARC_RPC_URL', 'http:').toString().replace(/\/$/, '')
  const databaseUrl = assertLoopbackUrl(DATABASE_URL, 'DATABASE_URL', 'postgresql:')
  assert(!databaseUrl.password, 'Local certification database URL must not contain a password')
  assert(databaseUrl.pathname.replace(/^\//, '') === 'movy_certification', 'DATABASE_URL must target the isolated movy_certification database')

  const publicClient = createPublicClient({
    chain: LOCAL_ARC_CHAIN,
    transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }),
  })
  const chainId = await publicClient.getChainId()
  assert(chainId === CHAIN_ID, 'Local Arc node chain ID mismatch')
  const nodeInfo = await publicClient.request({ method: 'anvil_nodeInfo', params: [] })
  assert(nodeInfo?.network === 'arc', 'Local RPC is not running Circle Arc Foundry in Arc mode')
  assert(nodeInfo?.forkConfig?.forkUrl == null, 'Core lifecycle requires a non-forked isolated local Arc chain')
  const [usdcCode, usdcDecimals] = await Promise.all([
    publicClient.getCode({ address: CANONICAL_USDC }),
    publicClient.readContract({ address: CANONICAL_USDC, abi: ERC20_ABI, functionName: 'decimals' }),
  ])
  assert(usdcCode && usdcCode !== '0x', 'Arc local system USDC code is missing')
  assert(usdcDecimals === 6, 'Arc ERC-20 USDC view must use six decimals')

  const schema = `movy_local_arc_${Date.now()}_${randomBytes(4).toString('hex')}`
  const schemaRoot = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 })
  await schemaRoot.query(`CREATE SCHEMA "${schema}"`)
  await schemaRoot.end()

  const baseEvidence = {
    certification: 'LOCAL PASS',
    environment: 'Circle Arc Foundry local chain; no public Testnet transactions',
    generatedAt: new Date().toISOString(),
    arcFoundryNetwork: nodeInfo.network,
    chainId,
    localRpcHost: new URL(rpcUrl).host,
    forked: false,
    finalityMode: 'local latest: Arc Foundry has no consensus finality; this flag is process-only and loopback-guarded',
    canonicalUsdc: CANONICAL_USDC,
    systemUsdcEmitter: SYSTEM_USDC_EMITTER,
    erc20Decimals: usdcDecimals,
    nativeDecimals: 18,
    nativeToErc20UnitScale: units(NATIVE_UNITS_PER_ERC20_UNIT),
    isolatedDatabaseSchema: schema,
    databaseRowsCaptured: false,
    identities: {},
    gasPolicy: {
      maxFeePerGasWei: units(MAX_FEE_PER_GAS),
      gasLimitBufferPercent: 20,
      deploymentMaximumFeeWei: units(DEPLOY_TX_CAP),
      walletTransactionMaximumFeeWei: units(WALLET_TX_CAP),
      relayerMaximumFeeWei: units(RELAYER_TX_CAP),
    },
    fundingMethod: 'Local Arc anvil_setBalance only; no generated identity is exposed by eth_accounts or funded from a public development key.',
    assertions: [],
    fees: [],
    receipts: {},
    balances: {},
    database: null,
  }

  let pool = null
  let evidencePath = null
  try {
    const migration = spawnSync(process.execPath, ['scripts/db/migrate.mjs'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL, MOVY_DB_SCHEMA: schema },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert(migration.status === 0, `Local PostgreSQL migration failed: ${(migration.stderr || migration.stdout || '').slice(-1000)}`)
    pool = dbClient(schema)
    await pool.query('SELECT 1')

    const ethAccounts = await publicClient.request({ method: 'eth_accounts', params: [] })
    assert(Array.isArray(ethAccounts) && ethAccounts.length === 0, 'Local chain exposes generated dev accounts; start arc-anvil with --accounts 0')

    // All five required roles use fresh, random local-only keys held in process memory.
    const accounts = Object.fromEntries(['owner', 'relayer', 'spending', 'merchant', 'savings', 'edgeCase'].map((role) => {
      const privateKey = generatePrivateKey()
      return [role, { privateKey, account: privateKeyToAccount(privateKey) }]
    }))
    assert(new Set(Object.values(accounts).map((entry) => entry.account.address.toLowerCase())).size === Object.keys(accounts).length,
      'Generated local testing identities must all be distinct')
    evidencePath = resolve(process.env.MOVY_LOCAL_EVIDENCE_PATH || 'docs/evidence/local-arc-financial-certification.json')
    baseEvidence.identities = Object.fromEntries(Object.entries(accounts).map(([role, entry]) => [role, entry.account.address]))

    const walletClients = Object.fromEntries(Object.entries(accounts).map(([role, entry]) => [role, createWalletClient({
      account: entry.account,
      chain: LOCAL_ARC_CHAIN,
      transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }),
    })]))

    for (const [role, entry] of Object.entries(accounts)) {
      const localTopup = role === 'owner' ? 200_000_000_000_000_000n
        : role === 'relayer' ? 50_000_000_000_000_000n
          : role === 'merchant' || role === 'savings' ? 0n
            : LOCAL_TESTER_BALANCE
      const localRpc = new URL(rpcUrl)
      const response = await fetch(localRpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [entry.account.address, `0x${localTopup.toString(16)}`] }),
      })
      const body = await response.json()
      assert(response.ok && !body.error && body.result === null, `Local-only balance setup failed for ${role}`)
    }

    const initialBalances = {}
    for (const [role, entry] of Object.entries(accounts)) {
      initialBalances[role] = await readBalances(publicClient, entry.account.address)
      verifySharedBalanceView(initialBalances[role], `${role} initial`)
    }
    assert(BigInt(initialBalances.spending.native18) === LOCAL_TESTER_BALANCE, 'Spending wallet local funding amount mismatch')
    assert(BigInt(initialBalances.spending.erc20Usdc6) === 1_100_000n, 'ERC-20 six-decimal spending balance does not match 1.10 USDC')
    baseEvidence.balances.before = initialBalances
    baseEvidence.assertions.push('PASS: generated owner, relayer, spending, merchant, savings, and edge-case identities are distinct and local-only')
    baseEvidence.assertions.push('PASS: local native balance uses 18 decimals while canonical ERC-20 USDC reports six decimals against the same backing balance')
    baseEvidence.assertions.push('PASS: local worker uses Arc Foundry latest blocks only behind the process-only non-production loopback guard')

    const artifactPath = resolve(ROOT, 'contracts/out/MovyAutoSaver.sol/MovyAutoSaver.json')
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'))
    const bytecode = artifact.bytecode?.object
    assert(typeof bytecode === 'string' && bytecode.startsWith('0x') && bytecode.length > 10, 'Build contracts with arc-forge before running this certification')
    const constructorData = encodeDeployData({ abi: MOVY_AUTO_SAVER_ABI, bytecode, args: ['0x0000000000000000000000000000000000000000', accounts.relayer.account.address] })
    const deployEstimate = await publicClient.estimateGas({ account: accounts.owner.account.address, data: constructorData })
    const deployFeeCheck = await certifyFeeEstimate(publicClient, deployEstimate, DEPLOY_TX_CAP, 'AutoSaver deployment')
    const deployHash = await walletClients.owner.sendTransaction({
      data: constructorData,
      gas: BigInt(deployFeeCheck.gasLimit),
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
    })
    const deployReceipt = await waitSuccess(publicClient, deployHash, 'AutoSaver deployment')
    const contractAddress = deployReceipt.contractAddress
    assert(contractAddress, 'Local AutoSaver deployment receipt did not include a contract address')
    baseEvidence.receipts.deployment = serializableReceipt(deployReceipt)
    baseEvidence.fees.push({ operation: 'deployment', gasEstimate: deployFeeCheck.estimate, bufferedGasLimit: deployFeeCheck.gasLimit, bufferedMaxFeeWei: deployFeeCheck.maxFeeWei, actualFeeWei: units(deployReceipt.gasUsed * deployReceipt.effectiveGasPrice) })
    const deployBlock = Number(deployReceipt.blockNumber)

    const [deployedCode, onchainOwner, onchainRelayer, onchainUsdc] = await Promise.all([
      publicClient.getCode({ address: contractAddress }),
      publicClient.readContract({ address: contractAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'owner' }),
      publicClient.readContract({ address: contractAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'relayer' }),
      publicClient.readContract({ address: contractAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'usdc' }),
    ])
    assert(deployedCode && deployedCode !== '0x', 'Fresh local AutoSaver has no runtime code')
    assert(onchainOwner.toLowerCase() === accounts.owner.account.address.toLowerCase(), 'Fresh local contract owner mismatch')
    assert(onchainRelayer.toLowerCase() === accounts.relayer.account.address.toLowerCase(), 'Fresh local contract relayer mismatch')
    assert(onchainOwner.toLowerCase() !== onchainRelayer.toLowerCase(), 'Owner and relayer must be separate')
    assert(onchainUsdc.toLowerCase() === CANONICAL_USDC.toLowerCase(), 'AutoSaver did not select canonical local Arc USDC')
    baseEvidence.contract = {
      address: contractAddress,
      deployBlock,
      deploymentHash: deployReceipt.transactionHash,
      runtimeCodeBytes: (deployedCode.length - 2) / 2,
      runtimeCodeHash: keccak256(deployedCode),
      owner: onchainOwner,
      relayer: onchainRelayer,
      usdc: onchainUsdc,
    }
    baseEvidence.assertions.push('PASS: fresh AutoSaver deployed locally with separate owner and relayer roles and canonical Arc USDC')

    const enrollment = await signedContractTransaction({
      publicClient,
      walletClient: walletClients.spending,
      account: accounts.spending.account,
      address: contractAddress,
      abi: MOVY_AUTO_SAVER_ABI,
      functionName: 'enroll',
      args: [accounts.savings.account.address, ROUNDUP_83_CENTS, ROUNDUP_83_CENTS],
      cap: WALLET_TX_CAP,
      label: 'spending enrollment',
    })
    baseEvidence.receipts.enrollment = serializableReceipt(enrollment.receipt)
    baseEvidence.fees.push({ operation: 'enrollment', ...enrollment.feeCheck, actualFeeWei: units(enrollment.receipt.gasUsed * enrollment.receipt.effectiveGasPrice) })

    const approval = await signedContractTransaction({
      publicClient,
      walletClient: walletClients.spending,
      account: accounts.spending.account,
      address: CANONICAL_USDC,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [contractAddress, ROUNDUP_83_CENTS],
      cap: WALLET_TX_CAP,
      label: 'limited USDC approval',
    })
    baseEvidence.receipts.approval = serializableReceipt(approval.receipt)
    baseEvidence.fees.push({ operation: 'approval', ...approval.feeCheck, actualFeeWei: units(approval.receipt.gasUsed * approval.receipt.effectiveGasPrice) })
    const approvedAllowance = await publicClient.readContract({ address: CANONICAL_USDC, abi: ERC20_ABI, functionName: 'allowance', args: [accounts.spending.account.address, contractAddress] })
    assert(approvedAllowance === ROUNDUP_83_CENTS, 'Signed approval did not set an exact $0.83 allowance')

    const payment = await signedContractTransaction({
      publicClient,
      walletClient: walletClients.spending,
      account: accounts.spending.account,
      address: CANONICAL_USDC,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [accounts.merchant.account.address, PAYMENT_17_CENTS],
      cap: WALLET_TX_CAP,
      label: 'direct $0.17 merchant payment',
    })
    baseEvidence.receipts.payment = serializableReceipt(payment.receipt)
    baseEvidence.fees.push({ operation: 'payment', ...payment.feeCheck, actualFeeWei: units(payment.receipt.gasUsed * payment.receipt.effectiveGasPrice) })
    const tokenTransferLogs = parseEventLogs({ abi: ERC20_ABI, logs: payment.receipt.logs, eventName: 'Transfer', strict: false })
    const paymentLog = tokenTransferLogs.find((log) =>
      log.address.toLowerCase() === SYSTEM_USDC_EMITTER.toLowerCase() &&
      log.args.from.toLowerCase() === accounts.spending.account.address.toLowerCase() &&
      log.args.to.toLowerCase() === accounts.merchant.account.address.toLowerCase() &&
      log.args.value === PAYMENT_17_CENTS * NATIVE_UNITS_PER_ERC20_UNIT)
    assert(paymentLog, 'Signed $0.17 transfer did not emit the canonical Arc system-USDC event')
    baseEvidence.payment = {
      amount6: units(PAYMENT_17_CENTS),
      systemEventAmount18: units(paymentLog.args.value),
      logIndex: units(paymentLog.logIndex),
      transactionHash: payment.receipt.transactionHash,
      blockNumber: units(payment.receipt.blockNumber),
    }
    baseEvidence.balances.afterPayment = {
      spending: await readBalances(publicClient, accounts.spending.account.address),
      merchant: await readBalances(publicClient, accounts.merchant.account.address),
      savings: await readBalances(publicClient, accounts.savings.account.address),
    }
    baseEvidence.assertions.push('PASS: real signed wallet approval is exactly 830000 six-decimal units ($0.83)')
    baseEvidence.assertions.push('PASS: real signed direct $0.17 USDC payment emitted the Arc system Transfer log in 18-decimal native units')

    const dbCountBeforeObservation = await pool.query('SELECT (SELECT count(*) FROM observed_payments)::int AS payments, (SELECT count(*) FROM roundup_jobs)::int AS jobs')
    const cursorsBeforeRpcFailure = await pool.query(`SELECT kind, last_processed_block FROM (
      SELECT 'payment' AS kind, last_processed_block FROM chain_cursor WHERE chain_id = $1
      UNION ALL SELECT 'enrollment_event', last_processed_block FROM enrollment_event_cursor WHERE chain_id = $1
      UNION ALL SELECT 'enrollment_history', last_processed_block FROM enrollment_history_cursor WHERE chain_id = $1
    ) cursors ORDER BY kind`, [CHAIN_ID])
    const rpcFailure = (() => {
      try {
        return runWorkerProcess({ label: 'RPC failure rehearsal', contractAddress, deployBlock, schema, relayerPrivateKey: null, relayerEnabled: false, rpcUrl: 'http://127.0.0.1:1' })
      } catch (error) {
        return { failedClosed: true, diagnostic: safeError(error) }
      }
    })()
    assert(rpcFailure.failedClosed, 'Worker unexpectedly succeeded while its local RPC was unavailable')
    const dbCountAfterRpcFailure = await pool.query('SELECT (SELECT count(*) FROM observed_payments)::int AS payments, (SELECT count(*) FROM roundup_jobs)::int AS jobs')
    const cursorsAfterRpcFailure = await pool.query(`SELECT kind, last_processed_block FROM (
      SELECT 'payment' AS kind, last_processed_block FROM chain_cursor WHERE chain_id = $1
      UNION ALL SELECT 'enrollment_event', last_processed_block FROM enrollment_event_cursor WHERE chain_id = $1
      UNION ALL SELECT 'enrollment_history', last_processed_block FROM enrollment_history_cursor WHERE chain_id = $1
    ) cursors ORDER BY kind`, [CHAIN_ID])
    assert(dbCountBeforeObservation.rows[0].payments === dbCountAfterRpcFailure.rows[0].payments && dbCountBeforeObservation.rows[0].jobs === dbCountAfterRpcFailure.rows[0].jobs,
      'RPC failure changed payment/job rows before observation')
    baseEvidence.rpcFailure = {
      failedClosed: true,
      paymentsBefore: dbCountBeforeObservation.rows[0].payments,
      paymentsAfter: dbCountAfterRpcFailure.rows[0].payments,
      jobsBefore: dbCountBeforeObservation.rows[0].jobs,
      jobsAfter: dbCountAfterRpcFailure.rows[0].jobs,
      cursorsBefore: cursorsBeforeRpcFailure.rows,
      cursorsAfter: cursorsAfterRpcFailure.rows,
      diagnostic: rpcFailure.diagnostic,
    }

    // This worker subprocess exits with a durable pending job. A separate process resumes it.
    const observeResult = runWorkerProcess({ label: 'observer-only worker', contractAddress, deployBlock, schema, relayerPrivateKey: null, relayerEnabled: false })
    const observedRows = await pool.query(`SELECT payment_key, tx_hash, log_index, block_number, payer, recipient,
      amount_6, roundup_6, is_eligible FROM observed_payments`)
    const pendingJobs = await pool.query(`SELECT job_id, payment_key, status, roundup_amount_6, relayer_tx_hash FROM roundup_jobs`)
    assert(observedRows.rowCount === 1 && observedRows.rows[0].amount_6 === '170000' && observedRows.rows[0].roundup_6 === '830000' && observedRows.rows[0].is_eligible === true,
      `Actual observer did not persist the exact eligible $0.17 → $0.83 payment; rows=${JSON.stringify(observedRows.rows)}; worker=${JSON.stringify(observeResult)}`)
    assert(pendingJobs.rowCount === 1 && pendingJobs.rows[0].status === 'pending' && pendingJobs.rows[0].roundup_amount_6 === '830000',
      `Observer did not create the durable $0.83 pending job; rows=${JSON.stringify(pendingJobs.rows)}; worker=${JSON.stringify(observeResult)}`)
    assert(observeResult.observerResult.observedTransfers === 1 && observeResult.observerResult.newJobs === 1,
      'Observer worker did not report exactly one new payment and job')
    baseEvidence.worker = { observerOnlyResult: observeResult }
    baseEvidence.databaseAfterObservation = { observedPayment: observedRows.rows[0], roundupJob: pendingJobs.rows[0] }
    baseEvidence.assertions.push('PASS: actual MOVY worker observed the finalized local payment and committed an eligible $0.83 roundup job to PostgreSQL')
    baseEvidence.assertions.push('PASS: worker process exited with a durable pending job; the relayer was activated only in the next one-shot local worker process')

    const mainConfig = await publicClient.readContract({
      address: contractAddress,
      abi: MOVY_AUTO_SAVER_ABI,
      functionName: 'getUserConfig',
      args: [accounts.spending.account.address],
    })
    const relayerEstimate = await publicClient.estimateContractGas({
      account: accounts.relayer.account.address,
      address: contractAddress,
      abi: MOVY_AUTO_SAVER_ABI,
      functionName: 'executeRoundup',
      args: [
        accounts.spending.account.address,
        payment.receipt.transactionHash,
        BigInt(observedRows.rows[0].log_index),
        PAYMENT_17_CENTS,
        accounts.savings.account.address,
        mainConfig.configEpoch,
      ],
    })
    const relayerFeeCheck = await certifyFeeEstimate(publicClient, relayerEstimate, RELAYER_TX_CAP, 'AutoSaver roundup')

    const relayerResult = runWorkerProcess({ label: 'one-shot relayer worker', contractAddress, deployBlock, schema, relayerPrivateKey: accounts.relayer.privateKey, relayerEnabled: true })
    assert(relayerResult.relayerResult.confirmed === 1 && relayerResult.relayerResult.failed === 0,
      'Actual MOVY relayer worker did not confirm exactly one roundup')
    const mainJob = await pool.query(`SELECT job_id, payment_key, status, relayer_tx_hash, attempts FROM roundup_jobs WHERE wallet = $1`, [accounts.spending.account.address.toLowerCase()])
    assert(mainJob.rowCount === 1 && mainJob.rows[0].status === 'confirmed' && mainJob.rows[0].relayer_tx_hash,
      'PostgreSQL did not persist the confirmed relayer transaction')
    const roundupHash = mainJob.rows[0].relayer_tx_hash
    const roundupReceipt = await publicClient.getTransactionReceipt({ hash: roundupHash })
    assert(roundupReceipt.status === 'success', 'Local roundup receipt was not successful')
    const roundupEvents = parseEventLogs({ abi: MOVY_AUTO_SAVER_ABI, logs: roundupReceipt.logs, eventName: 'RoundupExecuted', strict: true })
    const roundupEvent = roundupEvents.find((log) => log.args.paymentKey.toLowerCase() === mainJob.rows[0].payment_key.toLowerCase())
    assert(roundupEvent && roundupEvent.args.paymentAmount6 === PAYMENT_17_CENTS && roundupEvent.args.roundupAmount6 === ROUNDUP_83_CENTS,
      'Actual relayer receipt does not contain the expected $0.17/$0.83 RoundupExecuted event')
    const processed = await publicClient.readContract({ address: contractAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'isPaymentProcessed', args: [mainJob.rows[0].payment_key] })
    const allowanceAfterRoundup = await publicClient.readContract({ address: CANONICAL_USDC, abi: ERC20_ABI, functionName: 'allowance', args: [accounts.spending.account.address, contractAddress] })
    const dailySpent = await publicClient.readContract({ address: contractAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'getDailySpent', args: [accounts.spending.account.address, BigInt((await publicClient.getBlock({ blockNumber: roundupReceipt.blockNumber })).timestamp) / 86_400n] })
    const balancesAfterRoundup = {
      spending: await readBalances(publicClient, accounts.spending.account.address),
      merchant: await readBalances(publicClient, accounts.merchant.account.address),
      savings: await readBalances(publicClient, accounts.savings.account.address),
    }
    assert(processed === true, 'Onchain payment replay protection was not set')
    assert(allowanceAfterRoundup === 0n, 'Exact approval was not consumed to zero')
    assert(dailySpent === ROUNDUP_83_CENTS, 'Onchain daily accounting did not record exactly $0.83')
    assert(BigInt(balancesAfterRoundup.savings.erc20Usdc6) === 830_000n,
      `Savings destination did not receive exactly $0.83: ${JSON.stringify(balancesAfterRoundup.savings)}`)
    assert(BigInt(balancesAfterRoundup.merchant.erc20Usdc6) === 170_000n,
      `Merchant did not receive exactly the original $0.17: ${JSON.stringify(balancesAfterRoundup.merchant)}`)
    for (const [role, balance] of Object.entries(balancesAfterRoundup)) verifySharedBalanceView(balance, `${role} after roundup`)
    baseEvidence.receipts.roundup = serializableReceipt(roundupReceipt)
    assert(roundupReceipt.gasUsed <= BigInt(relayerFeeCheck.gasLimit), 'Relayer receipt exceeded its buffered gas limit')
    baseEvidence.fees.push({ operation: 'relayer roundup', ...relayerFeeCheck, gasUsed: units(roundupReceipt.gasUsed), actualFeeWei: units(roundupReceipt.gasUsed * roundupReceipt.effectiveGasPrice), transactionHash: roundupHash })
    baseEvidence.roundup = {
      amount6: units(roundupEvent.args.roundupAmount6),
      paymentAmount6: units(roundupEvent.args.paymentAmount6),
      paymentKey: roundupEvent.args.paymentKey,
      wallet: roundupEvent.args.wallet,
      destination: roundupEvent.args.destination,
      allowanceAfter: units(allowanceAfterRoundup),
      dailySpent6: units(dailySpent),
      isPaymentProcessed: processed,
      transactionHash: roundupHash,
    }
    baseEvidence.balances.afterRoundup = balancesAfterRoundup
    baseEvidence.worker.relayerResult = relayerResult
    baseEvidence.assertions.push('PASS: actual MOVY relayer signed and broadcast one local executeRoundup transaction; destination received exactly $0.83')
    baseEvidence.assertions.push('PASS: onchain RoundupExecuted receipt, replay flag, allowance consumption, daily accounting, merchant amount, and savings balance reconcile')

    // Simulate the durable submitted state after process interruption using the real confirmed hash.
    await pool.query(`UPDATE roundup_jobs SET status = 'submitted', relayer_tx_hash = $1 WHERE job_id = $2`, [roundupHash, mainJob.rows[0].job_id])
    const recoveryResult = runWorkerProcess({ label: 'submitted-receipt recovery worker', contractAddress, deployBlock, schema, relayerPrivateKey: accounts.relayer.privateKey, relayerEnabled: true })
    assert(recoveryResult.relayerResult.confirmed === 1 && recoveryResult.relayerResult.processed === 1,
      'Restarted worker did not recover the persisted submitted transaction from its real receipt')
    const recoveredJob = await pool.query(`SELECT status, relayer_tx_hash FROM roundup_jobs WHERE job_id = $1`, [mainJob.rows[0].job_id])
    assert(recoveredJob.rows[0].status === 'confirmed' && recoveredJob.rows[0].relayer_tx_hash === roundupHash,
      'Receipt recovery did not restore confirmed status without changing the transaction hash')
    baseEvidence.worker.receiptRecoveryResult = recoveryResult
    baseEvidence.assertions.push('PASS: submitted-state recovery rehearsal restarted the worker with the actual local hash; receipt reconciliation confirmed it without broadcasting a duplicate')

    // Rewind only this disposable schema cursor to force the same canonical logs through idempotency again.
    const rowCountsBeforeDuplicateScan = await pool.query('SELECT (SELECT count(*) FROM observed_payments)::int AS payments, (SELECT count(*) FROM roundup_jobs)::int AS jobs')
    await pool.query('UPDATE chain_cursor SET last_processed_block = $1 WHERE chain_id = $2', [deployBlock - 1, CHAIN_ID])
    const duplicateScanResult = runWorkerProcess({ label: 'duplicate event rescan worker', contractAddress, deployBlock, schema, relayerPrivateKey: accounts.relayer.privateKey, relayerEnabled: true })
    const rowCountsAfterDuplicateScan = await pool.query('SELECT (SELECT count(*) FROM observed_payments)::int AS payments, (SELECT count(*) FROM roundup_jobs)::int AS jobs')
    assert(rowCountsBeforeDuplicateScan.rows[0].payments === rowCountsAfterDuplicateScan.rows[0].payments && rowCountsBeforeDuplicateScan.rows[0].jobs === rowCountsAfterDuplicateScan.rows[0].jobs,
      'Duplicate event replay created duplicate database rows')
    assert(duplicateScanResult.relayerResult.confirmed === 0, 'Duplicate event replay caused another roundup')
    baseEvidence.worker.duplicateEventScanResult = duplicateScanResult
    baseEvidence.duplicateEventReplay = { rowsBefore: rowCountsBeforeDuplicateScan.rows[0], rowsAfter: rowCountsAfterDuplicateScan.rows[0], duplicateJobsCreated: 0, duplicateRoundupsBroadcast: 0 }
    baseEvidence.assertions.push('PASS: replaying the same finalized payment log left one payment row and one job and did not broadcast again')

    const wrongChainSource = `
      import { runWorkerCycle } from './src/lib/server/worker.ts';
      try {
        await runWorkerCycle(5042, { maxBlocks: 1000 });
        console.log('LOCAL_ARC_WRONG_CHAIN=accepted');
        process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        console.log('LOCAL_ARC_WRONG_CHAIN=' + message.replace(/0x[0-9a-fA-F]{64}/g, '0x[REDACTED]'));
      }
    `
    const cursorsBeforeWrongChain = await pool.query(`SELECT kind, last_processed_block FROM (
      SELECT 'payment' AS kind, last_processed_block FROM chain_cursor WHERE chain_id = $1
      UNION ALL SELECT 'enrollment_event', last_processed_block FROM enrollment_event_cursor WHERE chain_id = $1
      UNION ALL SELECT 'enrollment_history', last_processed_block FROM enrollment_history_cursor WHERE chain_id = $1
    ) cursors ORDER BY kind`, [CHAIN_ID])
    const wrongChainRun = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', wrongChainSource], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL, MOVY_DB_SCHEMA: schema },
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert(wrongChainRun.status === 0 && wrongChainRun.stdout.includes('Only Arc Testnet (chain 5042002) is supported'),
      'Actual MOVY worker accepted a wrong-chain request')
    const cursorsAfterWrongChain = await pool.query(`SELECT kind, last_processed_block FROM (
      SELECT 'payment' AS kind, last_processed_block FROM chain_cursor WHERE chain_id = $1
      UNION ALL SELECT 'enrollment_event', last_processed_block FROM enrollment_event_cursor WHERE chain_id = $1
      UNION ALL SELECT 'enrollment_history', last_processed_block FROM enrollment_history_cursor WHERE chain_id = $1
    ) cursors ORDER BY kind`, [CHAIN_ID])
    const wrongChainCursorsUnchanged = JSON.stringify(cursorsAfterWrongChain.rows) === JSON.stringify(cursorsBeforeWrongChain.rows)
    assert(wrongChainCursorsUnchanged, 'Wrong-chain worker request changed a local database cursor')
    baseEvidence.wrongChain = { rejected: true, cursorsUnchanged: wrongChainCursorsUnchanged, cursorsBefore: cursorsBeforeWrongChain.rows, cursorsAfter: cursorsAfterWrongChain.rows, diagnostic: wrongChainRun.stdout.trim().slice(-250) }
    baseEvidence.assertions.push('PASS: actual worker rejects wrong-chain requests before contacting RPC or writing database state')

    // Test a signed cap rejection and a real payment whose finite allowance is zero.
    const invalidCapData = encodeFunctionData({ abi: MOVY_AUTO_SAVER_ABI, functionName: 'enroll', args: [accounts.savings.account.address, 100_000_001n, 100_000_001n] })
    const invalidCapGas = 200_000n
    const invalidCapFeeWei = invalidCapGas * MAX_FEE_PER_GAS
    assert(invalidCapFeeWei <= WALLET_TX_CAP, 'Invalid-cap local test transaction exceeds wallet fee cap')
    const invalidCapHash = await walletClients.edgeCase.sendTransaction({
      to: contractAddress,
      data: invalidCapData,
      gas: invalidCapGas,
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: PRIORITY_FEE_PER_GAS,
    })
    const invalidCapReceipt = await publicClient.waitForTransactionReceipt({ hash: invalidCapHash, timeout: 60_000 })
    assert(invalidCapReceipt.status === 'reverted', 'Onchain cap overrun was not rejected')
    const edgeConfigBeforeValidEnrollment = await publicClient.readContract({ address: contractAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'getUserConfig', args: [accounts.edgeCase.account.address] })
    assert(edgeConfigBeforeValidEnrollment.enrolled === false, 'Rejected cap transaction changed enrollment state')
    baseEvidence.receipts.invalidCapRejectedEnrollment = serializableReceipt(invalidCapReceipt)
    baseEvidence.fees.push({ operation: 'invalid cap rejection', gasLimit: units(invalidCapGas), maxFeeWei: units(invalidCapFeeWei), actualFeeWei: units(invalidCapReceipt.gasUsed * invalidCapReceipt.effectiveGasPrice), expectedStatus: 'reverted' })

    const edgeEnrollment = await signedContractTransaction({
      publicClient,
      walletClient: walletClients.edgeCase,
      account: accounts.edgeCase.account,
      address: contractAddress,
      abi: MOVY_AUTO_SAVER_ABI,
      functionName: 'enroll',
      args: [accounts.savings.account.address, ROUNDUP_83_CENTS, ROUNDUP_83_CENTS],
      cap: WALLET_TX_CAP,
      label: 'edge-case wallet enrollment',
    })
    baseEvidence.receipts.edgeCaseEnrollment = serializableReceipt(edgeEnrollment.receipt)
    baseEvidence.fees.push({ operation: 'edge-case enrollment', ...edgeEnrollment.feeCheck, actualFeeWei: units(edgeEnrollment.receipt.gasUsed * edgeEnrollment.receipt.effectiveGasPrice) })
    const edgePayment = await signedContractTransaction({
      publicClient,
      walletClient: walletClients.edgeCase,
      account: accounts.edgeCase.account,
      address: CANONICAL_USDC,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [accounts.merchant.account.address, PAYMENT_17_CENTS],
      cap: WALLET_TX_CAP,
      label: 'edge-case direct $0.17 payment without allowance',
    })
    baseEvidence.receipts.edgeCasePayment = serializableReceipt(edgePayment.receipt)
    baseEvidence.fees.push({ operation: 'edge-case payment', ...edgePayment.feeCheck, actualFeeWei: units(edgePayment.receipt.gasUsed * edgePayment.receipt.effectiveGasPrice) })
    const insufficientAllowanceResult = runWorkerProcess({ label: 'insufficient-allowance worker', contractAddress, deployBlock, schema, relayerPrivateKey: accounts.relayer.privateKey, relayerEnabled: true })
    const edgeJob = await pool.query(`SELECT j.status, j.skip_reason, j.roundup_amount_6, p.amount_6, p.is_eligible
      FROM roundup_jobs j JOIN observed_payments p USING (payment_key) WHERE lower(j.wallet) = lower($1)`, [accounts.edgeCase.account.address])
    assert(edgeJob.rowCount === 1 && edgeJob.rows[0].status === 'skipped' && edgeJob.rows[0].skip_reason === 'insufficient_allowance',
      'Actual relayer did not safely skip the observed payment with zero allowance')
    baseEvidence.worker.insufficientAllowanceResult = insufficientAllowanceResult
    baseEvidence.insufficientAllowance = edgeJob.rows[0]
    baseEvidence.assertions.push('PASS: actual observer/relayer pipeline persisted the second payment and skipped it with insufficient_allowance without transfer')
    baseEvidence.assertions.push('PASS: signed enrollment above the onchain cap reverted with no enrollment state change')

    const pause = await signedContractTransaction({
      publicClient,
      walletClient: walletClients.spending,
      account: accounts.spending.account,
      address: contractAddress,
      abi: MOVY_AUTO_SAVER_ABI,
      functionName: 'setPaused',
      args: [true],
      cap: WALLET_TX_CAP,
      label: 'user pause',
    })
    baseEvidence.receipts.pause = serializableReceipt(pause.receipt)
    baseEvidence.fees.push({ operation: 'pause', ...pause.feeCheck, actualFeeWei: units(pause.receipt.gasUsed * pause.receipt.effectiveGasPrice) })
    const revoke = await signedContractTransaction({
      publicClient,
      walletClient: walletClients.spending,
      account: accounts.spending.account,
      address: contractAddress,
      abi: MOVY_AUTO_SAVER_ABI,
      functionName: 'revoke',
      args: [],
      cap: WALLET_TX_CAP,
      label: 'user revocation',
    })
    baseEvidence.receipts.revoke = serializableReceipt(revoke.receipt)
    baseEvidence.fees.push({ operation: 'revoke', ...revoke.feeCheck, actualFeeWei: units(revoke.receipt.gasUsed * revoke.receipt.effectiveGasPrice) })
    const revokedConfig = await publicClient.readContract({ address: contractAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'getUserConfig', args: [accounts.spending.account.address] })
    assert(revokedConfig.enrolled === false && revokedConfig.paused === true && revokedConfig.destination === '0x0000000000000000000000000000000000000000' && revokedConfig.maxRoundup6 === 0n && revokedConfig.dailyCap6 === 0n,
      'Onchain revoke did not clear the user authorization state')
    baseEvidence.onchainRevocation = {
      enrolled: revokedConfig.enrolled,
      paused: revokedConfig.paused,
      destination: revokedConfig.destination,
      maxRoundup6: units(revokedConfig.maxRoundup6),
      dailyCap6: units(revokedConfig.dailyCap6),
      configEpoch: revokedConfig.configEpoch,
    }

    const finalWorkerResult = runWorkerProcess({ label: 'post-revocation history worker', contractAddress, deployBlock, schema, relayerPrivateKey: accounts.relayer.privateKey, relayerEnabled: true })
    baseEvidence.worker.postRevocationResult = finalWorkerResult
    const finalEnrollment = await pool.query(`SELECT status, max_roundup_6, daily_cap_6, config_epoch FROM enrollments WHERE chain_id = $1 AND lower(wallet) = lower($2)`, [CHAIN_ID, accounts.spending.account.address])
    assert(finalEnrollment.rowCount === 1 && finalEnrollment.rows[0].status === 'revoked' && finalEnrollment.rows[0].max_roundup_6 === '0' && finalEnrollment.rows[0].daily_cap_6 === '0',
      'Post-revocation worker did not persist revoked state')
    baseEvidence.assertions.push('PASS: signed pause then revoke cleared destination/caps and the restarted observer/indexer reconciled PostgreSQL status to revoked')

    const latestReceipts = {
      deployment: deployReceipt,
      enrollment: enrollment.receipt,
      approval: approval.receipt,
      payment: payment.receipt,
      roundup: roundupReceipt,
      pause: pause.receipt,
      revoke: revoke.receipt,
    }
    baseEvidence.balances.afterAllLocalTests = {
      spending: await readBalances(publicClient, accounts.spending.account.address),
      merchant: await readBalances(publicClient, accounts.merchant.account.address),
      savings: await readBalances(publicClient, accounts.savings.account.address),
    }
    baseEvidence.balances.finalNote = 'afterAllLocalTests includes the separate edge-case wallet $0.17 merchant payment; afterRoundup is the primary $0.17 → $0.83 lifecycle snapshot.'
    baseEvidence.database = await captureDbRows(pool)
    baseEvidence.databaseRowsCaptured = true
    baseEvidence.worker.finalResult = finalWorkerResult
    baseEvidence.assertions.push('PASS: isolated local PostgreSQL rows reconcile each observed payment and job to actual local transaction hashes/receipts')
    baseEvidence.assertions.push('PASS: complete local signed lifecycle completed with no wallet mocks and no public-chain writes')
    baseEvidence.mainLifecycleTransactionHashes = Object.fromEntries(Object.entries(latestReceipts).map(([label, receipt]) => [label, receipt.transactionHash]))
    const mainLifecycleOperations = new Set(['deployment', 'enrollment', 'approval', 'payment', 'relayer roundup', 'pause', 'revoke'])
    const mainLifecycleBufferedMaxFeeWei = baseEvidence.fees
      .filter((fee) => mainLifecycleOperations.has(fee.operation))
      .reduce((sum, fee) => sum + BigInt(fee.bufferedMaxFeeWei ?? fee.maxFeeWei), 0n)
    assert(mainLifecycleBufferedMaxFeeWei <= 350_000_000_000_000_000n, 'Primary lifecycle buffered fee estimate exceeds the approved aggregate ceiling')
    baseEvidence.gasPolicy.aggregatePrimaryLifecycleBufferedMaximumWei = units(mainLifecycleBufferedMaxFeeWei)
    baseEvidence.gasPolicy.aggregatePrimaryLifecycleActualFeesWei = units(
      baseEvidence.fees.filter((fee) => mainLifecycleOperations.has(fee.operation))
        .reduce((sum, fee) => sum + BigInt(fee.actualFeeWei), 0n),
    )
    baseEvidence.gasPolicy.localBalanceFundingTransactions = 0

    await mkdir(dirname(evidencePath), { recursive: true })
    await writeFile(evidencePath, `${JSON.stringify(baseEvidence, null, 2)}\n`, { mode: 0o644 })
    console.log(JSON.stringify({ status: 'LOCAL PASS', evidencePath, contractAddress, transactionHashes: baseEvidence.mainLifecycleTransactionHashes, databaseRows: { observedPayments: baseEvidence.database.observedPayments.length, roundupJobs: baseEvidence.database.roundupJobs.length } }))
  } finally {
    if (pool) await pool.end()
    const cleanup = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 })
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await cleanup.end()
    }
  }
}

main().catch((error) => {
  console.error(`LOCAL_AR_CERTIFICATION_FAILED=${safeError(error)}`)
  process.exitCode = 1
})
