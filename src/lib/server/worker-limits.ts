import { getActiveChainId, getConfiguredNetwork } from './config'

export const MAX_WORKER_BLOCKS = 1_000

export function assertWorkerChain(chainId: number): void {
  const activeChainId = getActiveChainId()
  if (chainId !== activeChainId) {
    const network = getConfiguredNetwork() === 'mainnet' ? 'Arc Mainnet' : 'Arc Testnet'
    throw new Error(`Only ${network} (chain ${activeChainId}) is supported by this worker deployment`)
  }
}

export function assertWorkerExecutionLimits(chainId: number, maxBlocks: number): void {
  assertWorkerChain(chainId)
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_WORKER_BLOCKS) {
    throw new Error(`maxBlocks must be an integer from 1 to ${MAX_WORKER_BLOCKS}`)
  }
}
