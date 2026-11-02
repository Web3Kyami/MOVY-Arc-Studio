import {
  releaseWorkerLock,
  renewWorkerLock,
  tryAcquireWorkerLock,
  workerLockIsActive,
  type WorkerLockToken,
} from './db'
import { getConfiguredNetwork } from './config'
import type { ArcNetwork } from '../chain'

const DEFAULT_LEASE_MS = 120_000
const DEFAULT_HEARTBEAT_MS = 30_000

export function getWorkerLockName(network: ArcNetwork = getConfiguredNetwork()): string {
  return `arc-${network}-worker`
}

export class WorkerAlreadyRunningError extends Error {
  constructor() {
    super('A worker cycle is already running')
    this.name = 'WorkerAlreadyRunningError'
  }
}

export class WorkerLockLostError extends Error {
  constructor() {
    super('Worker lock lease was lost before the cycle completed')
    this.name = 'WorkerLockLostError'
  }
}

export interface WorkerLockContext {
  token: WorkerLockToken
  assertActive: () => Promise<void>
}

export async function withWorkerLock<T>(
  run: (lock: WorkerLockContext) => Promise<T>,
  options: { lockName?: string; leaseDurationMs?: number; heartbeatMs?: number } = {}
): Promise<T> {
  const lockName = options.lockName ?? getWorkerLockName()
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseDurationMs) {
    throw new Error('Worker lock heartbeat must be positive and shorter than the lease')
  }

  const token = await tryAcquireWorkerLock(lockName, leaseDurationMs)
  if (!token) throw new WorkerAlreadyRunningError()

  let lost = false
  const heartbeat = setInterval(() => {
    void renewWorkerLock(token, leaseDurationMs).then((renewed) => {
      if (!renewed) lost = true
    }).catch(() => { lost = true })
  }, heartbeatMs)
  heartbeat.unref()

  const context: WorkerLockContext = {
    token,
    assertActive: async () => {
      if (lost || !(await workerLockIsActive(token))) throw new WorkerLockLostError()
    },
  }

  try {
    await context.assertActive()
    const result = await run(context)
    await context.assertActive()
    return result
  } catch (error) {
    if (!(await workerLockIsActive(token))) throw new WorkerLockLostError()
    throw error
  } finally {
    clearInterval(heartbeat)
    await releaseWorkerLock(token)
  }
}
