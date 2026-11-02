import { parseAbiItem, type Address } from 'viem'
import { MOVY_AUTO_SAVER_ABI } from '../abi/movy-auto-saver'
import { getAutoSaverAddress, getDeployBlock } from './config'
import { assertWorkerChain } from './worker-limits'
import {
  getEnrollment,
  getEnrollmentHistoryCursor,
  setEnrollmentEventCursor,
  setEnrollmentHistoryCursor,
  upsertEnrollmentHistoryState,
  getEnrollmentHistoryAtPosition,
  upsertEnrollment,
  type WorkerLockToken,
} from './db'
import { getFinalizedBlockNumber, getPublicClient, verifyMainnetRuntimeDeployment } from './observer'
import { syncEnrollmentFromChain } from './enrollment-sync'
import { processEnrollmentHistoryWindow, type EnrollmentHistoryEvent } from './enrollment-history'

const ENROLLMENT_EVENTS = [
  parseAbiItem('event UserEnrolled(address indexed wallet, address indexed destination, uint64 maxRoundup6, uint64 dailyCap6, uint32 configEpoch)'),
  parseAbiItem('event UserConfigUpdated(address indexed wallet, address indexed destination, uint64 maxRoundup6, uint64 dailyCap6, uint32 configEpoch)'),
  parseAbiItem('event UserPauseToggled(address indexed wallet, bool paused)'),
  parseAbiItem('event UserRevoked(address indexed wallet, uint32 finalEpoch)'),
]

export async function processEnrollmentEvents(
  chainId: number,
  maxBlocks: number,
  options?: { assertLockActive?: () => Promise<void>; workerLock?: WorkerLockToken }
) {
  assertWorkerChain(chainId)
  const client = getPublicClient(chainId)
  const contractAddress = getAutoSaverAddress(chainId)
  if (await client.getChainId() !== chainId) throw new Error('Enrollment indexer RPC chain ID does not match the requested network')
  await verifyMainnetRuntimeDeployment(client, chainId)

  return processEnrollmentHistoryWindow(chainId, maxBlocks, {
    getCurrentBlock: async () => getFinalizedBlockNumber(client),
    getCursor: getEnrollmentHistoryCursor,
    getDeployBlock,
    getEvents: async (_requestedChainId, fromBlock, toBlock) => {
      const logGroups = await Promise.all(ENROLLMENT_EVENTS.map((event) => client.getLogs({
        address: contractAddress,
        event,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      })))
      const events: EnrollmentHistoryEvent[] = []
      for (const [index, logs] of logGroups.entries()) {
        for (const log of logs) {
          const args = log.args as {
            wallet?: Address
            destination?: Address
            maxRoundup6?: bigint
            dailyCap6?: bigint
            configEpoch?: number | bigint
            paused?: boolean
            finalEpoch?: number | bigint
          }
          if (!args.wallet || log.blockNumber === null) continue
          const position = {
            wallet: args.wallet,
            blockNumber: Number(log.blockNumber),
            logIndex: Number(log.logIndex ?? 0),
          }
          if (index < 2) {
            if (!args.destination || args.maxRoundup6 === undefined || args.dailyCap6 === undefined || args.configEpoch === undefined) {
              throw new Error('Enrollment configuration event is missing required fields')
            }
            events.push({
              ...position,
              kind: index === 0 ? 'enrolled' : 'config-updated',
              destination: args.destination,
              maxRoundup6: BigInt(args.maxRoundup6).toString(),
              dailyCap6: BigInt(args.dailyCap6).toString(),
              configEpoch: Number(args.configEpoch),
            })
          } else if (index === 2) {
            if (typeof args.paused !== 'boolean') throw new Error('Pause event is missing its state')
            events.push({ ...position, kind: 'pause-toggled', paused: args.paused })
          } else {
            if (args.finalEpoch === undefined) throw new Error('Revocation event is missing its final epoch')
            events.push({ ...position, kind: 'revoked', finalEpoch: Number(args.finalEpoch) })
          }
        }
      }
      return events
    },
    getStateBeforePosition: getEnrollmentHistoryAtPosition,
    saveState: (state) => upsertEnrollmentHistoryState(state, options?.workerLock),
    syncWallet: async (requestedChainId, wallet) => {
      await syncEnrollmentFromChain(requestedChainId, wallet, {
        readConfig: async (_readChainId, requestedWallet) => client.readContract({
          address: contractAddress,
          abi: MOVY_AUTO_SAVER_ABI,
          functionName: 'getUserConfig',
          args: [requestedWallet],
        }),
        getExisting: getEnrollment,
        upsert: (record) => upsertEnrollment(record, options?.workerLock),
      })
    },
    setCursor: async (requestedChainId, blockNumber) => {
      await setEnrollmentHistoryCursor(requestedChainId, blockNumber, options?.workerLock)
      await setEnrollmentEventCursor(requestedChainId, blockNumber, options?.workerLock)
    },
    assertLockActive: options?.assertLockActive,
  })
}
