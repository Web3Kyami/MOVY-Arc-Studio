import {
  createWalletClient,
  http,
  type Hash,
  type Address,
} from 'viem'
import { calculateRoundup6 } from '../money'
import { privateKeyToAccount } from 'viem/accounts'
import { lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { decryptFoundryKeystore, loadFoundryKeystoreAccount } from './foundry-keystore.mjs'
import {
  CHAIN_TESTNET,
  CHAIN_MAINNET,
  CHAIN_MAINNET_ID,
  CANONICAL_ARC_USDC,
  getNetworkForChainId,
  getRpcUrlForChainId,
  getAutoSaverAddress,
  getDeployBlock,
} from './config'
import { computePaymentKey, getFinalizedBlockNumber, getPublicClient, verifyMainnetRuntimeDeployment } from './observer'
import {
  ensurePaymentHistoryReplay,
  getPaymentHistoryReplay,
  getPendingJobs,
  getSubmissionRecoveryJobs,
  updateJobStatus,
  type WorkerLockToken,
  type RoundupJobRecord,
} from './db'
import { MOVY_AUTO_SAVER_ABI, ERC20_ABI } from '../abi/movy-auto-saver'
import { assertWorkerChain } from './worker-limits'
import { WorkerLockLostError } from './worker-lock'
import { reconcileSubmittedRelayerTransaction, submitAndPersistRelayerTransaction } from './relayer-recovery'
import { authorizePendingJobForSubmission } from './relayer-authorization'
import { validateFinalizedPaymentEvidence } from './payment-evidence'
import { getArcFeePolicy } from '../fee-policy'
import type { ArcNetwork } from '../chain'
import {
  findFinalizedRoundupEvent,
  ROUNDUP_EXECUTED_EVENT,
  validateRoundupReceipt,
  type RoundupEventExpectation,
} from './roundup-receipt'
const KNOWN_DEVELOPMENT_ADDRESSES = new Set([
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
])

export function getRelayerFeeBudget(network: ArcNetwork, env: NodeJS.ProcessEnv = process.env): {
  maxFeePerGas: bigint
  priorityFeePerGas: bigint
  maxTxFee: bigint
} | null {
  const maxFeePerGasRaw = env.MOVY_RELAYER_MAX_FEE_PER_GAS_WEI
  const maxTxFeeRaw = env.MOVY_RELAYER_MAX_TX_FEE_WEI
  if (!maxFeePerGasRaw || !/^[1-9][0-9]*$/.test(maxFeePerGasRaw)) return null
  if (!maxTxFeeRaw || !/^[1-9][0-9]*$/.test(maxTxFeeRaw)) return null
  const maxFeePerGas = BigInt(maxFeePerGasRaw)
  const maxTxFee = BigInt(maxTxFeeRaw)
  let policy
  try {
    policy = getArcFeePolicy(network, env)
  } catch {
    return null
  }
  if (
    maxFeePerGas > policy.maxFeePerGasWei ||
    maxFeePerGas < policy.minBaseFeePerGasWei ||
    maxFeePerGas < policy.priorityFeePerGasWei ||
    (policy.maxTransactionFeeWei !== null && maxTxFee > policy.maxTransactionFeeWei)
  ) return null
  return { maxFeePerGas, priorityFeePerGas: policy.priorityFeePerGasWei, maxTxFee }
}

async function verifyRelayerDeployment(
  client: ReturnType<typeof getPublicClient>,
  chainId: number,
  autoSaverAddress: Address,
  relayerAddress: Address,
): Promise<string | null> {
  const rpcChainId = await client.getChainId()
  if (rpcChainId !== chainId) return 'rpc_chain_mismatch'
  const [code, owner, configuredRelayer, usdc] = await Promise.all([
    client.getCode({ address: autoSaverAddress }),
    client.readContract({ address: autoSaverAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'owner' }),
    client.readContract({ address: autoSaverAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'relayer' }),
    client.readContract({ address: autoSaverAddress, abi: MOVY_AUTO_SAVER_ABI, functionName: 'usdc' }),
  ])
  if (!code || code === '0x') return 'contract_code_missing'
  if (owner.toLowerCase() === configuredRelayer.toLowerCase()) return 'owner_relayer_roles_converged'
  if (KNOWN_DEVELOPMENT_ADDRESSES.has(owner.toLowerCase())) return 'known_development_owner_blocked'
  if (configuredRelayer.toLowerCase() !== relayerAddress.toLowerCase()) return 'signer_not_configured_relayer'
  if (KNOWN_DEVELOPMENT_ADDRESSES.has(configuredRelayer.toLowerCase())) return 'known_development_relayer_blocked'
  if (usdc.toLowerCase() !== CANONICAL_ARC_USDC.toLowerCase()) return 'contract_usdc_mismatch'
  return null
}

function paddedGasLimit(estimate: bigint): bigint {
  if (estimate <= 0n) throw new Error('Invalid relayer gas estimate')
  return (estimate * 120n + 99n) / 100n
}

function getRoundupEventExpectation(chainId: number, job: RoundupJobRecord): RoundupEventExpectation | null {
  if (
    job.chainId !== chainId ||
    !job.paymentTxHash || !/^0x[0-9a-f]{64}$/i.test(job.paymentTxHash) ||
    !Number.isSafeInteger(job.canonicalLogIndex) || job.canonicalLogIndex === undefined || job.canonicalLogIndex < 0 ||
    !Number.isSafeInteger(job.paymentBlockNumber) || job.paymentBlockNumber === undefined || job.paymentBlockNumber < 0 ||
    !job.paymentAmount6 || !/^[0-9]+$/.test(job.paymentAmount6) ||
    !/^[0-9]+$/.test(job.roundupAmount6) ||
    !/^0x[0-9a-f]{40}$/i.test(job.wallet) ||
    !/^0x[0-9a-f]{40}$/i.test(job.destination) ||
    !/^0x[0-9a-f]{64}$/i.test(job.paymentKey)
  ) return null

  try {
    const paymentAmount6 = BigInt(job.paymentAmount6)
    const roundupAmount6 = BigInt(job.roundupAmount6)
    const paymentTxHash = job.paymentTxHash as Hash
    const wallet = job.wallet as Address
    if (
      calculateRoundup6(paymentAmount6) !== roundupAmount6 ||
      computePaymentKey(chainId, paymentTxHash, job.canonicalLogIndex, wallet).toLowerCase() !== job.paymentKey.toLowerCase()
    ) return null

    return {
      paymentKey: job.paymentKey as Hash,
      wallet,
      destination: job.destination as Address,
      paymentAmount6,
      roundupAmount6,
      paymentTxHash,
      canonicalLogIndex: BigInt(job.canonicalLogIndex),
    }
  } catch {
    return null
  }
}

async function validateJobRelayerReceipt(
  client: ReturnType<typeof getPublicClient>,
  autoSaverAddress: Address,
  expected: RoundupEventExpectation,
  hash: Hash,
  receipt: Parameters<typeof validateRoundupReceipt>[0]['receipt'],
) {
  return validateRoundupReceipt({
    receipt,
    expectedTxHash: hash,
    autoSaverAddress,
    expected,
    getFinalizedBlockNumber: async () => BigInt(await getFinalizedBlockNumber(client)),
    getCanonicalBlockHash: async (blockNumber) => (await client.getBlock({ blockNumber })).hash ?? null,
  })
}

export interface RelayerRuntime {
  getPublicClient?: typeof getPublicClient
  createWalletClient?: typeof createWalletClient
}

type RelayerAccount = ReturnType<typeof privateKeyToAccount>
let cachedKeystoreAccount: { fingerprint: string; account: RelayerAccount | null } | null = null

function keystoreFingerprint(keystorePath: string, passwordFilePath: string): string {
  const fileVersion = (path: string) => {
    const stat = lstatSync(path)
    if (!stat.isFile()) throw new Error('Relayer credential must be a regular file')
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }
  return `${keystorePath}\0${fileVersion(keystorePath)}\0${passwordFilePath}\0${fileVersion(passwordFilePath)}`
}

function loadConfiguredKeystoreAccount(): RelayerAccount | null {
  // Server-only secrets support stateless hosting without exporting a plaintext key.
  const encryptedJson = process.env.MOVY_RELAYER_KEYSTORE_JSON
  const password = process.env.MOVY_RELAYER_KEYSTORE_PASSWORD?.replace(/[\r\n]+$/, '')
  if (encryptedJson !== undefined || password !== undefined) {
    if (!encryptedJson || !password || encryptedJson.length > 16_384 || password.length > 1024) return null
    const fingerprint = createHash('sha256').update(encryptedJson).update('\0').update(password).digest('hex')
    if (cachedKeystoreAccount?.fingerprint === fingerprint) return cachedKeystoreAccount.account
    try {
      const account = privateKeyToAccount(decryptFoundryKeystore(encryptedJson, password) as `0x${string}`)
      const expected = process.env.MOVY_AUTOMATION_APPROVED_RELAYER
      if (expected && account.address.toLowerCase() !== expected.toLowerCase()) {
        cachedKeystoreAccount = { fingerprint, account: null }
        return null
      }
      cachedKeystoreAccount = { fingerprint, account }
      return account
    } catch {
      cachedKeystoreAccount = { fingerprint, account: null }
      return null
    }
  }
  const keystorePath = process.env.MOVY_RELAYER_KEYSTORE
  const passwordFilePath = process.env.MOVY_RELAYER_PASSWORD_FILE
  if (!keystorePath || !passwordFilePath) return null

  let fingerprint: string
  try { fingerprint = keystoreFingerprint(keystorePath, passwordFilePath) } catch { return null }
  if (cachedKeystoreAccount?.fingerprint === fingerprint) return cachedKeystoreAccount.account

  try {
    const account = loadFoundryKeystoreAccount({ keystorePath, passwordFilePath })
    cachedKeystoreAccount = { fingerprint, account }
    return account
  } catch {
    cachedKeystoreAccount = { fingerprint, account: null }
    return null
  }
}

export function getRelayerAccount(
  privateKey: string | null | undefined = process.env.RELAYER_PRIVATE_KEY
) {
  if (privateKey === null) return null
  const productionMainnet = process.env.NODE_ENV === 'production' &&
    (process.env.MOVY_TARGET_NETWORK ?? process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK) === 'mainnet'
  const expected = process.env.MOVY_AUTOMATION_APPROVED_RELAYER
  if (productionMainnet && process.env.MOVY_RELAYER_ENABLED === 'true' && !/^0x[0-9a-fA-F]{40}$/.test(expected ?? '')) return null
  if (privateKey) {
    if (productionMainnet) return null
    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) return null
    try {
      return privateKeyToAccount(privateKey as `0x${string}`)
    } catch {
      return null
    }
  }
  const account = loadConfiguredKeystoreAccount()
  if (productionMainnet && expected && account?.address.toLowerCase() !== expected.toLowerCase()) return null
  return account
}

export async function processPendingJobs(
  chainId: number,
  options?: { assertLockActive?: () => Promise<void>; workerLock?: WorkerLockToken; runtime?: RelayerRuntime; allowBroadcast?: boolean }
): Promise<{
  processed: number
  confirmed: number
  skipped: number
  failed: number
  deferred: number
}> {
  assertWorkerChain(chainId)
  await options?.assertLockActive?.()
  await ensurePaymentHistoryReplay(chainId, getDeployBlock(chainId), options?.workerLock)
  const recoveryJobs = await getSubmissionRecoveryJobs(chainId, 10)
  const jobs = await getPendingJobs(chainId, 10)
  if (jobs.length === 0 && recoveryJobs.length === 0) {
    return { processed: 0, confirmed: 0, skipped: 0, failed: 0, deferred: 0 }
  }

  let confirmedCount = 0
  let skippedCount = 0
  let failedCount = 0
  let deferredCount = 0
  let publicClient: ReturnType<typeof getPublicClient> | null = null
  const getClient = () => {
    if (!publicClient) publicClient = (options?.runtime?.getPublicClient ?? getPublicClient)(chainId)
    return publicClient
  }
  if (chainId === CHAIN_MAINNET_ID) await verifyMainnetRuntimeDeployment(getClient(), chainId)
  const updateStatus = (
    jobId: number,
    status: 'submitting' | 'submitted' | 'confirmed' | 'skipped' | 'failed',
    details?: { relayerTxHash?: string; skipReason?: string; error?: string }
  ) => updateJobStatus(jobId, status, details, options?.workerLock)

  for (const job of recoveryJobs) {
    await options?.assertLockActive?.()
    if (!job.jobId || job.status !== 'submitted' || !job.relayerTxHash) {
      // A crash or uncertain RPC response may leave a pre-broadcast marker
      // without a hash. Keep it quarantined until an operator reconciles it.
      deferredCount++
      continue
    }
    const expectedEvent = getRoundupEventExpectation(chainId, job)
    let recoveryAutoSaverAddress: Address
    try {
      recoveryAutoSaverAddress = getAutoSaverAddress(chainId)
    } catch {
      deferredCount++
      continue
    }
    if (!expectedEvent) {
      deferredCount++
      console.warn('movy_relayer_recovery_deferred', { chainId, jobId: job.jobId, reason: 'roundup_expectation_invalid' })
      continue
    }
    try {
      const recovery = await reconcileSubmittedRelayerTransaction({
        hash: job.relayerTxHash as Hash,
        getReceipt: (hash) => getClient().getTransactionReceipt({ hash }),
        resolveReceipt: (receipt, hash) => validateJobRelayerReceipt(
          getClient(),
          recoveryAutoSaverAddress,
          expectedEvent,
          hash,
          receipt,
        ),
        persistFinalStatus: async (resolution, hash) => {
          await options?.assertLockActive?.()
          await updateStatus(job.jobId!, resolution.status, {
            relayerTxHash: hash,
            ...(resolution.status === 'failed' ? { error: resolution.reason } : {}),
          })
        },
      })
      if (recovery === 'confirmed') confirmedCount++
      else if (recovery === 'failed') failedCount++
      else deferredCount++
    } catch (error) {
      if (error instanceof WorkerLockLostError) throw error
      deferredCount++
    }
  }

  // A legacy job can still be pending while its payment lies beyond the
  // current bounded migration replay window. Keep every new broadcast closed
  // until the whole old payment range has been replayed. Submitted jobs above
  // remain independently receipt-reconcilable during migration.
  if (await getPaymentHistoryReplay(chainId)) {
    return {
      processed: recoveryJobs.length,
      confirmed: confirmedCount,
      skipped: skippedCount,
      failed: failedCount,
      deferred: deferredCount + jobs.length,
    }
  }

  const authorizedJobs: RoundupJobRecord[] = []
  for (const job of jobs) {
    await options?.assertLockActive?.()
    if (!job.jobId) continue
    const authorization = await authorizePendingJobForSubmission(chainId, job)
    if (authorization.status === 'deferred') {
      deferredCount++
    } else if (authorization.status === 'skip') {
      await updateStatus(job.jobId, 'skipped', { skipReason: authorization.reason })
      skippedCount++
    } else {
      authorizedJobs.push(job)
    }
  }

  const broadcastEnabled = options?.allowBroadcast === true && process.env.MOVY_RELAYER_ENABLED === 'true'
  if (!broadcastEnabled) {
    return {
      processed: recoveryJobs.length + jobs.length,
      confirmed: confirmedCount,
      skipped: skippedCount,
      failed: failedCount,
      deferred: deferredCount + authorizedJobs.length,
    }
  }

  const relayerAccount = getRelayerAccount()
  if (!relayerAccount || authorizedJobs.length === 0) {
    return {
      processed: recoveryJobs.length + jobs.length,
      confirmed: confirmedCount,
      skipped: skippedCount,
      failed: failedCount,
      deferred: deferredCount + (!relayerAccount ? authorizedJobs.length : 0),
    }
  }

  let autoSaverAddress: Address
  try {
    autoSaverAddress = getAutoSaverAddress(chainId)
  } catch {
    console.error('movy_relayer_preflight_deferred', { chainId, reason: 'contract_not_configured' })
    return {
      processed: recoveryJobs.length + jobs.length,
      confirmed: confirmedCount,
      skipped: skippedCount,
      failed: failedCount,
      deferred: deferredCount + authorizedJobs.length,
    }
  }

  const feeBudget = getRelayerFeeBudget(getNetworkForChainId(chainId))
  if (!feeBudget) {
    console.error('movy_relayer_preflight_deferred', { chainId, reason: 'fee_budget_missing_or_invalid' })
    return {
      processed: recoveryJobs.length + jobs.length,
      confirmed: confirmedCount,
      skipped: skippedCount,
      failed: failedCount,
      deferred: deferredCount + authorizedJobs.length,
    }
  }

  const preflightClient = getClient()
  try {
    const preflightError = await verifyRelayerDeployment(
      preflightClient,
      chainId,
      autoSaverAddress,
      relayerAccount.address,
    )
    if (preflightError) {
      console.error('movy_relayer_preflight_deferred', { chainId, reason: preflightError })
      return {
        processed: recoveryJobs.length + jobs.length,
        confirmed: confirmedCount,
        skipped: skippedCount,
        failed: failedCount,
        deferred: deferredCount + authorizedJobs.length,
      }
    }
  } catch (error) {
    console.error('movy_relayer_preflight_deferred', {
      chainId,
      reason: error instanceof Error ? error.name : 'rpc_error',
    })
    return {
      processed: recoveryJobs.length + jobs.length,
      confirmed: confirmedCount,
      skipped: skippedCount,
      failed: failedCount,
      deferred: deferredCount + authorizedJobs.length,
    }
  }

  const network = getNetworkForChainId(chainId)
  const rpcUrl = getRpcUrlForChainId(chainId)
  const walletClient = (options?.runtime?.createWalletClient ?? createWalletClient)({
    account: relayerAccount,
    chain: network === 'mainnet' ? CHAIN_MAINNET : CHAIN_TESTNET,
    transport: http(rpcUrl, { retryCount: 3, timeout: 20_000 }),
  })

  let submissionStatePersisted = false

  for (const job of authorizedJobs) {
    await options?.assertLockActive?.()
    if (!job.jobId) continue
    submissionStatePersisted = false
    const wallet = job.wallet as Address
    const destination = job.destination as Address
    const configEpoch = job.configEpoch

    try {
      if (!job.paymentTxHash || job.canonicalLogIndex === undefined || job.paymentBlockNumber === undefined) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'payment_evidence_missing' })
        skippedCount++
        continue
      }

      // Database fields are only a lookup hint. Before any financial write,
      // independently bind the job to a finalized transaction, canonical
      // receipt, exact system-USDC transfer log, recipient, and calculated
      // roundup amount from the configured RPC.
      const paymentTxHash = job.paymentTxHash as Hash
      const paymentTransaction = await getClient().getTransaction({ hash: paymentTxHash })
      const paymentReceipt = await getClient().getTransactionReceipt({ hash: paymentTxHash })
      const finalizedBlock = BigInt(await getFinalizedBlockNumber(getClient()))
      const paymentBlock = await getClient().getBlock({ blockNumber: paymentReceipt.blockNumber })
      if (!paymentBlock.hash) {
        deferredCount++
        continue
      }
      const evidence = validateFinalizedPaymentEvidence({
        chainId,
        finalizedBlockNumber: finalizedBlock,
        canonicalBlockHash: paymentBlock.hash,
        job,
        transaction: paymentTransaction,
        receipt: paymentReceipt,
      })
      if (evidence.status === 'deferred') {
        deferredCount++
        continue
      }
      if (evidence.status === 'invalid') {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: evidence.reason })
        skippedCount++
        continue
      }

      const roundupAmount6 = BigInt(job.roundupAmount6)
      const expectedRoundupEvent = getRoundupEventExpectation(chainId, job)
      if (!expectedRoundupEvent) {
        deferredCount++
        console.warn('movy_relayer_job_deferred', { chainId, jobId: job.jobId, reason: 'roundup_expectation_invalid' })
        continue
      }

      // 0. Contract-wide emergency pause. This comes before every state- or quota-based
      // classification, and every decision read below uses the SAME finalized block as
      // this one, so a pause that lands between two RPC reads can never turn a temporary
      // pause into a permanent skip. Paused, or a pause state that cannot be read (a
      // thrown read lands in the catch below), is a deferral: the job stays pending, no
      // attempt is recorded, and nothing is broadcast.
      const snapshotBlock = finalizedBlock
      const servicePaused = await getClient().readContract({
        address: autoSaverAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'paused',
        blockNumber: snapshotBlock,
      })
      if (typeof servicePaused !== 'boolean' || servicePaused) {
        deferredCount++
        console.warn('movy_relayer_job_deferred', {
          chainId,
          jobId: job.jobId,
          reason: servicePaused === true ? 'service_paused' : 'service_pause_unknown',
        })
        continue
      }

      // 1. Read onchain user config from MovyAutoSaver
      const userConfig = await getClient().readContract({
        address: autoSaverAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'getUserConfig',
        args: [wallet],
        blockNumber: snapshotBlock,
      })

      if (!userConfig.enrolled) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'not_enrolled' })
        skippedCount++
        continue
      }

      if (userConfig.paused) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'user_paused' })
        skippedCount++
        continue
      }

      if (userConfig.destination.toLowerCase() !== destination.toLowerCase()) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'destination_mismatch' })
        skippedCount++
        continue
      }

      if (userConfig.configEpoch !== configEpoch) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'config_epoch_mismatch' })
        skippedCount++
        continue
      }

      if (roundupAmount6 > userConfig.maxRoundup6) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'roundup_exceeds_cap' })
        skippedCount++
        continue
      }

      // 2. Check onchain USDC balance
      const balance = await getClient().readContract({
        address: CANONICAL_ARC_USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [wallet],
        blockNumber: snapshotBlock,
      })

      if (balance < roundupAmount6) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'insufficient_balance' })
        skippedCount++
        continue
      }

      // 3. Check onchain allowance granted to MovyAutoSaver
      const allowance = await getClient().readContract({
        address: CANONICAL_ARC_USDC,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [wallet, autoSaverAddress],
        blockNumber: snapshotBlock,
      })

      if (allowance < roundupAmount6) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'insufficient_allowance' })
        skippedCount++
        continue
      }

      // 4. Check onchain daily cap
      const remainingDaily = await getClient().readContract({
        address: autoSaverAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'getRemainingDailyAllowance',
        args: [wallet],
        blockNumber: snapshotBlock,
      })

      // The service was confirmed unpaused at this same block, so a short remainder here is a
      // real daily-cap exhaustion and not the contract's pause-time zero.
      if (BigInt(remainingDaily) < roundupAmount6) {
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'skipped', { skipReason: 'daily_cap_exceeded' })
        skippedCount++
        continue
      }

      // 5. Check if already processed onchain
      const isProcessed = await getClient().readContract({
        address: autoSaverAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'isPaymentProcessed',
        args: [job.paymentKey as Hash],
        blockNumber: snapshotBlock,
      })

      if (isProcessed) {
        // An onchain replay flag prevents duplicate transfers, but it does not
        // attest the saved destination and amounts. Find the one matching event
        // in finalized canonical history before exposing this job as confirmed.
        const executedEvent = await findFinalizedRoundupEvent({
          startBlock: BigInt(job.paymentBlockNumber),
          finalizedBlockNumber: snapshotBlock,
          autoSaverAddress,
          expected: expectedRoundupEvent,
          getLogs: (fromBlock, toBlock) => getClient().getLogs({
            address: autoSaverAddress,
            event: ROUNDUP_EXECUTED_EVENT,
            fromBlock,
            toBlock,
            strict: true,
          }),
          getCanonicalBlockHash: async (blockNumber) => (await getClient().getBlock({ blockNumber })).hash ?? null,
        })
        if (
          !executedEvent || executedEvent.blockNumber === null || !executedEvent.transactionHash
        ) {
          deferredCount++
          console.warn('movy_relayer_job_deferred', { chainId, jobId: job.jobId, reason: 'processed_roundup_event_unavailable' })
          continue
        }
        await options?.assertLockActive?.()
        await updateStatus(job.jobId, 'confirmed', { relayerTxHash: executedEvent.transactionHash })
        confirmedCount++
        continue
      }

      // 6. Submit executeRoundup onchain
      const canonicalLogIndex = BigInt(job.canonicalLogIndex ?? 0)
      const paymentAmount6 = evidence.paymentAmount6
      const executeArgs = [
        wallet,
        paymentTxHash,
        canonicalLogIndex,
        paymentAmount6,
        destination,
        configEpoch,
      ] as const
      const gasEstimate = await getClient().estimateContractGas({
        account: relayerAccount.address,
        address: autoSaverAddress,
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'executeRoundup',
        args: executeArgs,
      })
      const gasLimit = paddedGasLimit(gasEstimate)
      const maximumTxCost = gasLimit * feeBudget.maxFeePerGas
      if (maximumTxCost > feeBudget.maxTxFee) {
        deferredCount++
        console.warn('movy_relayer_job_deferred', { chainId, jobId: job.jobId, reason: 'tx_fee_budget_exceeded' })
        continue
      }
      const relayerBalance = await getClient().getBalance({ address: relayerAccount.address })
      if (relayerBalance < maximumTxCost) {
        deferredCount++
        console.warn('movy_relayer_job_deferred', { chainId, jobId: job.jobId, reason: 'relayer_balance_below_fee_cap' })
        continue
      }

      console.info('movy_relayer_submission_started', { chainId, jobId: job.jobId })

      const { hash, receipt } = await submitAndPersistRelayerTransaction({
        markSubmitting: async () => {
          await options?.assertLockActive?.()
          await updateStatus(job.jobId!, 'submitting')
          submissionStatePersisted = true
        },
        broadcast: async () => {
          await options?.assertLockActive?.()
          return walletClient.writeContract({
            address: autoSaverAddress,
            abi: MOVY_AUTO_SAVER_ABI,
            functionName: 'executeRoundup',
            args: executeArgs,
            gas: gasLimit,
            maxFeePerGas: feeBudget.maxFeePerGas,
            maxPriorityFeePerGas: feeBudget.priorityFeePerGas,
          })
        },
        persistHash: async (submittedHash) => {
          await options?.assertLockActive?.()
          await updateStatus(job.jobId!, 'submitted', { relayerTxHash: submittedHash })
        },
        waitForReceipt: (submittedHash) => getClient().waitForTransactionReceipt({ hash: submittedHash }),
      })

      await options?.assertLockActive?.()
      const receiptDecision = await validateJobRelayerReceipt(
        getClient(),
        autoSaverAddress,
        expectedRoundupEvent,
        hash,
        receipt,
      )
      if (receiptDecision.status === 'confirmed') {
        await updateStatus(job.jobId, 'confirmed', { relayerTxHash: hash })
        confirmedCount++
        submissionStatePersisted = false
      } else if (receiptDecision.status === 'failed') {
        await updateStatus(job.jobId, 'failed', { relayerTxHash: hash, error: receiptDecision.reason })
        failedCount++
        submissionStatePersisted = false
      } else {
        deferredCount++
        console.warn('movy_relayer_job_deferred', {
          chainId,
          jobId: job.jobId,
          reason: receiptDecision.reason,
        })
      }
    } catch (err: unknown) {
      if (err instanceof WorkerLockLostError) throw err
      if (submissionStatePersisted) {
        // Broadcast failure, lost response, receipt timeout, or persistence
        // failure is uncertain. Leave submitting/submitted quarantined and do
        // not turn it back into a retryable pending job.
        deferredCount++
        continue
      }
      // Any failure before the durable submitting marker is retryable. In
      // particular, RPC timeouts on evidence, state, allowance, or gas reads
      // must not destroy the only record of an eligible payment.
      console.warn('movy_relayer_job_deferred', {
        chainId,
        jobId: job.jobId,
        reason: err instanceof Error ? err.name : 'rpc_error',
      })
      deferredCount++
    }
  }

  return {
    processed: jobs.length + recoveryJobs.length,
    confirmed: confirmedCount,
    skipped: skippedCount,
    failed: failedCount,
    deferred: deferredCount,
  }
}
