import { getActiveChainId, getConfiguredNetwork } from './config'
import { networkLabel } from '../chain'

export type RequestedChainResult =
  | { ok: true; chainId: number }
  | { ok: false; expectedChainId: number; networkName: string }

/** API requests may omit chainId, but may never choose a different network. */
export function resolveRequestedChainId(rawChainId: string | null): RequestedChainResult {
  const expectedChainId = getActiveChainId()
  const requestedChainId = rawChainId === null
    ? expectedChainId
    : /^\d+$/.test(rawChainId) ? Number(rawChainId) : Number.NaN
  if (!Number.isSafeInteger(requestedChainId) || requestedChainId !== expectedChainId) {
    return {
      ok: false,
      expectedChainId,
      networkName: networkLabel(getConfiguredNetwork()),
    }
  }
  return { ok: true, chainId: requestedChainId }
}
