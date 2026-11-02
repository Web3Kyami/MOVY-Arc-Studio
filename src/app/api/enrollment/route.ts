import { getEnrollment, upsertEnrollment } from '@/lib/server/db'
import { getAutoSaverAddress } from '@/lib/server/config'
import { getPublicClient, verifyMainnetRuntimeDeployment } from '@/lib/server/observer'
import { MOVY_AUTO_SAVER_ABI } from '@/lib/abi/movy-auto-saver'
import { handleEnrollmentGet, handleEnrollmentPost } from '@/lib/server/enrollment-api'
import { syncEnrollmentFromChain } from '@/lib/server/enrollment-sync'
import type { Address } from 'viem'
import { guardProductApiRequest } from '@/lib/server/api-origin-guard'

async function syncFromChain(chainId: number, wallet: string) {
  return syncEnrollmentFromChain(chainId, wallet, {
    readConfig: async (requestedChainId, requestedWallet) => {
      const client = getPublicClient(requestedChainId)
      await verifyMainnetRuntimeDeployment(client, requestedChainId)
      return client.readContract({
        address: getAutoSaverAddress(requestedChainId),
        abi: MOVY_AUTO_SAVER_ABI,
        functionName: 'getUserConfig',
        args: [requestedWallet as Address],
      })
    },
    getExisting: getEnrollment,
    upsert: upsertEnrollment,
  })
}

export async function GET(request: Request) {
  const blocked = guardProductApiRequest(request, { requireBrowserRequest: true })
  if (blocked) return blocked
  return handleEnrollmentGet(request, syncFromChain)
}

export async function POST(request: Request) {
  const blocked = guardProductApiRequest(request)
  if (blocked) return blocked
  return handleEnrollmentPost(request, syncFromChain)
}

export const runtime = 'nodejs'
