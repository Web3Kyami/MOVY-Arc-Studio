import { processBlocks } from './observer'
import { processPendingJobs } from './relayer'
import { processEnrollmentEvents } from './enrollment-indexer'
import { getActiveChainId } from './config'
import { assertWorkerExecutionLimits, MAX_WORKER_BLOCKS } from './worker-limits'
import { withWorkerLock } from './worker-lock'
import type { Address } from 'viem'

export async function runWorkerCycle(
  chainId: number = getActiveChainId(),
  options?: { targetWallet?: Address; maxBlocks?: number }
) {
  const maxBlocks = options?.maxBlocks ?? MAX_WORKER_BLOCKS
  assertWorkerExecutionLimits(chainId, maxBlocks)

  return withWorkerLock(async (lock) => {
    await lock.assertActive()
    const start = Date.now()

    // 1. Reconcile missed enrollment state from durable onchain events.
    const enrollmentResult = await processEnrollmentEvents(chainId, maxBlocks, {
      assertLockActive: lock.assertActive,
      workerLock: lock.token,
    })
    await lock.assertActive()

    // 2. Ingest blocks and observe payments.
    const observerResult = await processBlocks(chainId, {
      maxBlocks,
      targetWallet: options?.targetWallet,
      assertLockActive: lock.assertActive,
      workerLock: lock.token,
    })

    // 3. Process pending roundup jobs with relayer.
    await lock.assertActive()
    const relayerResult = await processPendingJobs(chainId, {
      assertLockActive: lock.assertActive,
      workerLock: lock.token,
      allowBroadcast: process.env.MOVY_RELAYER_ENABLED === 'true',
    })

    const durationMs = Date.now() - start

    const result = {
      chainId,
      enrollmentResult,
      observerResult,
      relayerResult,
      durationMs,
    }
    console.info('movy_worker_cycle_completed', {
      chainId,
      durationMs,
      processedBlocks: observerResult.processedBlocks,
      observedTransfers: observerResult.observedTransfers,
      newJobs: observerResult.newJobs,
      relayerProcessed: relayerResult.processed,
      relayerDeferred: relayerResult.deferred,
    })
    return result
  })
}
