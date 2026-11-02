import {
  createPublicClient,
  http,
  parseAbiItem,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  type Hash,
  type Address,
} from 'viem'
import {
  CHAIN_TESTNET,
  CHAIN_TESTNET_ID,
  CHAIN_MAINNET,
  CHAIN_MAINNET_ID,
  SYSTEM_USDC_EMITTER,
  getNetworkForChainId,
  getRpcUrlForChainId,
  getAutoSaverAddress,
  getDeployBlock,
  readOwnerVerifiedMainnetManifest,
  CANONICAL_ARC_USDC,
} from './config'
import { MOVY_AUTO_SAVER_ABI } from '../abi/movy-auto-saver'
import {
  getCursor,
  setCursor,
  getEnrollmentHistoryAtPosition,
  getEnrollmentHistoryCursor,
  getEnrollmentHistoryWallets,
  ensurePaymentHistoryReplay,
  getPaymentHistoryReplay,
  advancePaymentHistoryReplay,
  getRoundupJobByPaymentKey,
  updatePendingRoundupJobFromHistory,
  updateJobStatus,
  saveObservedPayment,
  createRoundupJob,
  type WorkerLockToken,
} from './db'
import { calculateRoundup6 } from '../money'
import { assertWorkerExecutionLimits, MAX_WORKER_BLOCKS } from './worker-limits'
import { decidePaymentAuthorization, resolvePaymentScanWindow } from './payment-authorization'
import { isSupportedDirectPayment, sameObservedTransfer } from './payment-evidence'

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
)
const ERC20_DECIMALS_ABI = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const

/** Verify Mainnet RPC identity and the deployed AutoSaver against the owner-reviewed manifest. */
export async function verifyMainnetRuntimeDeployment(
  client: ReturnType<typeof getPublicClient>,
  chainId: number,
): Promise<void> {
  if (getNetworkForChainId(chainId) !== 'mainnet') return
  const manifest = readOwnerVerifiedMainnetManifest()
  const autoSaver = manifest.contracts.autoSaver
  const address = getAutoSaverAddress(chainId)
  const [rpcChainId, code, owner, relayer, usdc, usdcCode, decimals, vaultCode, autoReceipt, vaultReceipt] = await Promise.all([
    client.getChainId(),
    client.getCode({ address }),
    client.readContract({ address, abi: MOVY_AUTO_SAVER_ABI, functionName: 'owner' }),
    client.readContract({ address, abi: MOVY_AUTO_SAVER_ABI, functionName: 'relayer' }),
    client.readContract({ address, abi: MOVY_AUTO_SAVER_ABI, functionName: 'usdc' }),
    client.getCode({ address: CANONICAL_ARC_USDC }),
    client.readContract({ address: CANONICAL_ARC_USDC, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }),
    client.getCode({ address: manifest.contracts.savingsVault.address as Address }),
    client.getTransactionReceipt({ hash: autoSaver.transactionHash as Hash }),
    client.getTransactionReceipt({ hash: manifest.contracts.savingsVault.transactionHash as Hash }),
  ])
  if (rpcChainId !== CHAIN_MAINNET_ID) throw new Error('Arc Mainnet RPC chain ID does not match 5042')
  if (!code || code === '0x' || keccak256(code) !== autoSaver.runtimeCodeHash) {
    throw new Error('Arc Mainnet AutoSaver runtime code does not match the owner-verified manifest')
  }
  if (
    !vaultCode || vaultCode === '0x' || keccak256(vaultCode) !== manifest.contracts.savingsVault.runtimeCodeHash ||
    autoReceipt.status !== 'success' || autoReceipt.blockNumber !== BigInt(autoSaver.deployBlock) ||
    autoReceipt.contractAddress?.toLowerCase() !== autoSaver.address.toLowerCase() ||
    vaultReceipt.status !== 'success' || vaultReceipt.blockNumber !== BigInt(manifest.contracts.savingsVault.deployBlock) ||
    vaultReceipt.contractAddress?.toLowerCase() !== manifest.contracts.savingsVault.address.toLowerCase()
  ) {
    throw new Error('Arc Mainnet deployment receipts or Savings Vault code do not match the owner-verified manifest')
  }
  if (
    owner.toLowerCase() !== autoSaver.roles.owner.toLowerCase() ||
    relayer.toLowerCase() !== autoSaver.roles.relayer.toLowerCase() ||
    owner.toLowerCase() === relayer.toLowerCase()
  ) {
    throw new Error('Arc Mainnet AutoSaver owner/relayer roles do not match the owner-verified manifest')
  }
  if (usdc.toLowerCase() !== CANONICAL_ARC_USDC.toLowerCase() || !usdcCode || usdcCode === '0x' || decimals !== 6) {
    throw new Error('Arc Mainnet AutoSaver USDC configuration is invalid')
  }
}

export function getPublicClient(chainId: number) {
  const network = getNetworkForChainId(chainId)
  const chain = network === 'mainnet' ? CHAIN_MAINNET : CHAIN_TESTNET
  const rpcUrl = getRpcUrlForChainId(chainId)

  return createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 3, timeout: 15_000 }),
  })
}

/** Arc exposes deterministic finalized blocks. Never enqueue a payment from an unfinalized head. */
export async function getFinalizedBlockNumber(client: ReturnType<typeof getPublicClient>): Promise<number> {
  if (process.env.MOVY_LOCAL_ARC_CERTIFICATION === 'true') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Local Arc certification finality is disabled in production')
    }
    const rpcUrl = getRpcUrlForChainId(CHAIN_TESTNET_ID)
    let endpoint: URL
    try {
      endpoint = new URL(rpcUrl)
    } catch {
      throw new Error('Local Arc certification requires a loopback RPC URL')
    }
    if (
      endpoint.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    ) {
      throw new Error('Local Arc certification requires a loopback RPC URL')
    }
    if (await client.getChainId() !== CHAIN_TESTNET_ID) {
      throw new Error('Local Arc certification RPC chain ID does not match Arc Testnet')
    }
    const nodeInfo = await client.request({
      method: 'anvil_nodeInfo' as never,
      params: [] as never,
    }) as unknown as { network?: string; forkConfig?: { forkUrl?: string | null } }
    if (nodeInfo.network !== 'arc' || nodeInfo.forkConfig?.forkUrl != null) {
      throw new Error('Local Arc certification requires a non-forked Arc Foundry node')
    }
    // Arc Foundry has no consensus finality; its local, single-process blocks
    // cannot be reorganized unless the test explicitly resets the node. Use
    // latest only under this non-production, loopback-only certification gate.
    const block = await client.request({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
    })
    if (!block?.number) throw new Error('Local Arc RPC did not return a latest block')
    const number = Number(BigInt(block.number))
    if (!Number.isSafeInteger(number) || number < 0) throw new Error('Local Arc latest block number is invalid')
    return number
  }

  if (client.chain?.id !== undefined && await client.getChainId() !== client.chain.id) {
    throw new Error('Arc RPC chain ID does not match the configured MOVY network')
  }

  const block = await client.request({
    method: 'eth_getBlockByNumber',
    params: ['finalized', false],
  })
  if (!block?.number) throw new Error('Arc RPC did not return a finalized block')
  const number = Number(BigInt(block.number))
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Arc finalized block number is invalid')
  return number
}

export function computePaymentKey(
  chainId: number,
  txHash: Hash,
  logIndex: number,
  wallet: Address
): Hash {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('uint256, bytes32, uint256, address'),
      [BigInt(chainId), txHash, BigInt(logIndex), wallet]
    )
  )
}

export async function processBlocks(
  chainId: number,
  options?: {
    maxBlocks?: number
    targetWallet?: Address
    assertLockActive?: () => Promise<void>
    workerLock?: WorkerLockToken
  }
): Promise<{ processedBlocks: number; observedTransfers: number; newJobs: number }> {
  const maxBlocks = options?.maxBlocks ?? MAX_WORKER_BLOCKS
  assertWorkerExecutionLimits(chainId, maxBlocks)
  await options?.assertLockActive?.()

  const client = getPublicClient(chainId)
  if (await client.getChainId() !== chainId) throw new Error('Observer RPC chain ID does not match the requested network')
  await verifyMainnetRuntimeDeployment(client, chainId)
  const currentBlock = await getFinalizedBlockNumber(client)
  await options?.assertLockActive?.()

  const deployBlock = getDeployBlock(chainId)
  await ensurePaymentHistoryReplay(chainId, deployBlock, options?.workerLock)
  const historyCursor = await getEnrollmentHistoryCursor(chainId)
  const replay = await getPaymentHistoryReplay(chainId)
  const chainCursor = await getCursor(chainId)
  const scanWindow = resolvePaymentScanWindow({
    deployBlock,
    currentBlock,
    historyCursor,
    paymentCursor: chainCursor,
    replay,
    maxBlocks,
  })
  if (!scanWindow) return { processedBlocks: 0, observedTransfers: 0, newJobs: 0 }
  const { fromBlock, toBlock } = scanWindow

  const autoSaverAddress = getAutoSaverAddress(chainId)

  // Include every wallet with historical enrollment events. Eligibility below
  // is resolved at each transfer's exact block/log position, never from the
  // wallet's latest configuration.
  const enrolledWalletSet = new Set((await getEnrollmentHistoryWallets(chainId)).map((wallet) => wallet.toLowerCase()))

  if (options?.targetWallet) {
    enrolledWalletSet.add(options.targetWallet.toLowerCase())
  }

  if (enrolledWalletSet.size === 0) {
    await options?.assertLockActive?.()
    if (scanWindow.mode === 'replay') await advancePaymentHistoryReplay(chainId, toBlock + 1, options?.workerLock)
    else await setCursor(chainId, toBlock, options?.workerLock)
    return { processedBlocks: toBlock - fromBlock + 1, observedTransfers: 0, newJobs: 0 }
  }

  // Ingest canonical USDC Transfer events from system emitter
  const logs = await client.getLogs({
    address: SYSTEM_USDC_EMITTER,
    event: TRANSFER_EVENT,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  })

  let observedCount = 0
  let newJobsCount = 0

  for (const log of logs) {
    await options?.assertLockActive?.()
    const from = log.args.from?.toLowerCase() as Address | undefined
    const to = log.args.to as Address | undefined
    const value18 = log.args.value

    if (!from || !to || value18 === undefined) continue

    // Check if the sender is one of our enrolled wallets
    if (!enrolledWalletSet.has(from)) continue

    const txHash = log.transactionHash as Hash
    if (log.logIndex === null || log.logIndex === undefined) continue
    const logIndex = Number(log.logIndex)
    if (!Number.isSafeInteger(logIndex) || logIndex < 0) continue
    observedCount++
    const blockNumber = Number(log.blockNumber)
    const paymentKey = computePaymentKey(chainId, txHash, logIndex, from)

    // Convert 18-decimal native system value to 6-decimal USDC units
    // 1 USDC = 10^18 in system log, 10^6 in ERC20 units. Divide by 10^12
    const amount6 = value18 / 1_000_000_000_000n

    const enrollment = await getEnrollmentHistoryAtPosition(chainId, from, blockNumber, logIndex)
    const initialAuthorization = decidePaymentAuthorization(enrollment, 0n)
    if (!initialAuthorization.authorized) {
      const job = await getRoundupJobByPaymentKey(paymentKey)
      if (job?.jobId && job.status === 'pending') {
        await updateJobStatus(job.jobId, 'skipped', { skipReason: initialAuthorization.reason }, options?.workerLock)
      }
      continue
    }
    const authorizedEnrollment = initialAuthorization.enrollment

    // Eligibility Classification
    let isEligible = true
    let exclusionReason: string | undefined

    if (to.toLowerCase() === from.toLowerCase()) {
      isEligible = false
      exclusionReason = 'self_transfer'
    } else if (to.toLowerCase() === '0x0000000000000000000000000000000000000000') {
      isEligible = false
      exclusionReason = 'burn'
    } else if (autoSaverAddress && to.toLowerCase() === autoSaverAddress.toLowerCase()) {
      isEligible = false
      exclusionReason = 'movy_contract'
    } else if (to.toLowerCase() === authorizedEnrollment.destination.toLowerCase()) {
      isEligible = false
      exclusionReason = 'savings_destination'
    } else if (amount6 === 0n) {
      isEligible = false
      exclusionReason = 'sub_micro_amount'
    } else {
      // Inspect transaction receipt and call data to ensure clean, simple payment
      let inspectionStage: 'transaction' | 'receipt' = 'transaction'
      let tx
      let receipt
      try {
        tx = await client.getTransaction({ hash: txHash })
        if (!tx || typeof tx.input !== 'string') throw new Error('Transaction data is not yet available')
        inspectionStage = 'receipt'
        receipt = await client.getTransactionReceipt({ hash: txHash })
        if (!receipt) throw new Error('Transaction receipt is not yet available')
      } catch {
        // Keep the failure diagnostic useful without logging provider errors,
        // which can contain RPC URLs or other configured connection details.
        console.warn('Observer transaction inspection incomplete; payment window will retry', {
          chainId,
          blockNumber,
          txHash,
          stage: inspectionStage,
        })
        throw new Error(`Observer ${inspectionStage} inspection incomplete; bounded payment window will retry`)
      }

      if (receipt.status !== 'success') {
        isEligible = false
        exclusionReason = 'reverted_transaction'
      } else if (!sameObservedTransfer(log, receipt.logs)) {
        // A provider returning a log that is absent from its transaction
        // receipt is inconsistent (or the head changed). Do not classify it
        // as an ordinary exclusion or advance the durable cursor past it.
        throw new Error('Observer receipt does not contain the canonical system transfer; payment window will retry')
      } else if (isSupportedDirectPayment({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        input: tx.input,
        blockNumber: tx.blockNumber,
        blockHash: tx.blockHash,
      }, log)) {
        isEligible = true
      } else {
        // Complex smart contract interaction (swap, bridge, lending, DEX, etc.)
        // Per MVP specification: exclude ambiguous and complex contract interactions
        isEligible = false
        exclusionReason = 'unsupported_contract_interaction'
      }
    }

    const roundup6 = isEligible ? calculateRoundup6(amount6) : 0n
    const paymentAuthorization = decidePaymentAuthorization(enrollment, roundup6)

    await saveObservedPayment({
      paymentKey,
      chainId,
      txHash,
      logIndex,
      blockNumber,
      payer: from,
      recipient: to,
      amount6: amount6.toString(),
      roundup6: roundup6.toString(),
      isEligible,
      exclusionReason,
      createdAt: new Date().toISOString(),
    }, options?.workerLock)

    if (isEligible && roundup6 > 0n && paymentAuthorization.authorized) {
      const existingJob = await getRoundupJobByPaymentKey(paymentKey)
      if (existingJob?.jobId && existingJob.status === 'pending') {
        await updatePendingRoundupJobFromHistory(existingJob.jobId, {
          destination: authorizedEnrollment.destination,
          roundupAmount6: roundup6.toString(),
          configEpoch: authorizedEnrollment.configEpoch,
        }, options?.workerLock)
      } else if (!existingJob) {
        const jobCreated = await createRoundupJob({
          paymentKey,
          chainId,
          wallet: from,
          destination: authorizedEnrollment.destination,
          roundupAmount6: roundup6.toString(),
          configEpoch: authorizedEnrollment.configEpoch,
          status: 'pending',
          attempts: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, options?.workerLock)
        if (jobCreated) newJobsCount++
      }
    } else if (!paymentAuthorization.authorized) {
      const existingJob = await getRoundupJobByPaymentKey(paymentKey)
      if (existingJob?.jobId && existingJob.status === 'pending') {
        await updateJobStatus(existingJob.jobId, 'skipped', { skipReason: paymentAuthorization.reason }, options?.workerLock)
      }
    }
  }

  await options?.assertLockActive?.()
  if (scanWindow.mode === 'replay') await advancePaymentHistoryReplay(chainId, toBlock + 1, options?.workerLock)
  else await setCursor(chainId, toBlock, options?.workerLock)

  return {
    processedBlocks: toBlock - fromBlock + 1,
    observedTransfers: observedCount,
    newJobs: newJobsCount,
  }
}
