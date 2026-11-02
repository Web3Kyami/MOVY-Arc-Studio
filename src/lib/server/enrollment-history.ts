import type { EnrollmentHistoryState } from './db'
import { assertWorkerExecutionLimits } from './worker-limits'

export type EnrollmentHistoryEvent =
  | {
      kind: 'enrolled' | 'config-updated'
      wallet: string
      blockNumber: number
      logIndex: number
      destination: string
      maxRoundup6: string
      dailyCap6: string
      configEpoch: number
    }
  | {
      kind: 'pause-toggled'
      wallet: string
      blockNumber: number
      logIndex: number
      paused: boolean
    }
  | {
      kind: 'revoked'
      wallet: string
      blockNumber: number
      logIndex: number
      finalEpoch: number
    }

export interface EnrollmentHistoryWindowDependencies {
  getCurrentBlock: (chainId: number) => Promise<number>
  getCursor: (chainId: number) => Promise<number | null>
  getDeployBlock: (chainId: number) => number
  getEvents: (chainId: number, fromBlock: number, toBlock: number) => Promise<EnrollmentHistoryEvent[]>
  getStateBeforePosition: (
    chainId: number,
    wallet: string,
    blockNumber: number,
    logIndex: number
  ) => Promise<EnrollmentHistoryState | null>
  saveState: (state: EnrollmentHistoryState) => Promise<void>
  syncWallet: (chainId: number, wallet: string) => Promise<void>
  setCursor: (chainId: number, blockNumber: number) => Promise<void>
  assertLockActive?: () => Promise<void>
}

export function applyEnrollmentHistoryEvent(
  previous: EnrollmentHistoryState | null,
  event: EnrollmentHistoryEvent,
  chainId: number
): EnrollmentHistoryState {
  const wallet = event.wallet.toLowerCase()
  if (event.kind === 'enrolled') {
    return {
      chainId,
      wallet,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      destination: event.destination,
      maxRoundup6: event.maxRoundup6,
      dailyCap6: event.dailyCap6,
      configEpoch: event.configEpoch,
      status: 'active',
    }
  }

  if (!previous) {
    throw new Error(`Enrollment history is missing its initial enrollment event for ${wallet}`)
  }

  if (event.kind === 'config-updated') {
    return {
      ...previous,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      destination: event.destination,
      maxRoundup6: event.maxRoundup6,
      dailyCap6: event.dailyCap6,
      configEpoch: event.configEpoch,
    }
  }

  if (event.kind === 'pause-toggled') {
    if (previous.status === 'revoked') throw new Error(`Cannot apply a pause event after revocation for ${wallet}`)
    return {
      ...previous,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      status: event.paused ? 'paused' : 'active',
    }
  }

  if (event.kind === 'revoked') {
    return {
      ...previous,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      configEpoch: event.finalEpoch,
      status: 'revoked',
    }
  }

  throw new Error('Unsupported enrollment history event')
}

export async function processEnrollmentHistoryWindow(
  chainId: number,
  maxBlocks: number,
  dependencies: EnrollmentHistoryWindowDependencies
): Promise<{ processedBlocks: number; savedEvents: number; syncedWallets: number; toBlock: number | null }> {
  assertWorkerExecutionLimits(chainId, maxBlocks)
  await dependencies.assertLockActive?.()
  const currentBlock = await dependencies.getCurrentBlock(chainId)
  await dependencies.assertLockActive?.()
  if (!Number.isSafeInteger(currentBlock) || currentBlock < 0) throw new Error('Invalid current block number')

  const deployBlock = dependencies.getDeployBlock(chainId)
  const storedCursor = await dependencies.getCursor(chainId)
  const fromBlock = storedCursor === null || storedCursor < deployBlock ? deployBlock : storedCursor + 1
  if (fromBlock > currentBlock) {
    return { processedBlocks: 0, savedEvents: 0, syncedWallets: 0, toBlock: storedCursor }
  }

  const toBlock = Math.min(fromBlock + maxBlocks - 1, currentBlock)
  const events = await dependencies.getEvents(chainId, fromBlock, toBlock)
  await dependencies.assertLockActive?.()
  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)

  const uniqueWallets = new Set<string>()
  for (const event of events) {
    await dependencies.assertLockActive?.()
    if (!Number.isSafeInteger(event.blockNumber) || event.blockNumber < fromBlock || event.blockNumber > toBlock ||
      !Number.isSafeInteger(event.logIndex) || event.logIndex < 0) {
      throw new Error('Enrollment event has an invalid chain position')
    }
    const wallet = event.wallet.toLowerCase()
    // A retry can encounter snapshots from events written before a prior
    // attempt failed to advance its cursor. Only the state preceding this
    // event is valid input; a later snapshot would leak future enrollment,
    // pause, or revocation state backward in time.
    const previous = await dependencies.getStateBeforePosition(
      chainId,
      wallet,
      event.blockNumber,
      event.logIndex
    )
    const next = applyEnrollmentHistoryEvent(previous, event, chainId)
    await dependencies.saveState(next)
    uniqueWallets.add(wallet)
  }

  for (const wallet of uniqueWallets) {
    await dependencies.assertLockActive?.()
    await dependencies.syncWallet(chainId, wallet)
  }

  await dependencies.assertLockActive?.()
  await dependencies.setCursor(chainId, toBlock)
  return { processedBlocks: toBlock - fromBlock + 1, savedEvents: events.length, syncedWallets: uniqueWallets.size, toBlock }
}
