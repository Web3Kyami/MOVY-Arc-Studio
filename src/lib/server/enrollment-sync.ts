import { isAddress, type Address } from 'viem'
import { assertConfiguredChainId } from './config'
import type { EnrollmentRecord } from './db'

export interface OnchainEnrollmentConfig {
  destination: Address
  maxRoundup6: bigint
  dailyCap6: bigint
  configEpoch: number
  paused: boolean
  enrolled: boolean
}

export interface EnrollmentSyncDependencies {
  readConfig: (chainId: number, wallet: Address) => Promise<OnchainEnrollmentConfig>
  getExisting: (chainId: number, wallet: string) => Promise<EnrollmentRecord | null>
  upsert: (record: EnrollmentRecord) => Promise<void>
  now?: () => string
}

export async function syncEnrollmentFromChain(
  chainId: number,
  wallet: string,
  dependencies: EnrollmentSyncDependencies
) {
  assertConfiguredChainId(chainId)
  if (!isAddress(wallet, { strict: false })) {
    throw new Error('Invalid wallet address')
  }

  const normalizedWallet = wallet as Address
  const config = await dependencies.readConfig(chainId, normalizedWallet)
  const existing = await dependencies.getExisting(chainId, normalizedWallet)
  const now = (dependencies.now ?? (() => new Date().toISOString()))()

  let enrollment: EnrollmentRecord | null = null
  if (config.enrolled || existing) {
    enrollment = {
      chainId,
      wallet: normalizedWallet,
      destination: config.destination,
      maxRoundup6: config.maxRoundup6.toString(),
      dailyCap6: config.dailyCap6.toString(),
      configEpoch: config.configEpoch,
      status: config.enrolled ? (config.paused ? 'paused' : 'active') : 'revoked',
      enrolledAt: existing?.enrolledAt ?? now,
      updatedAt: now,
    }
    await dependencies.upsert(enrollment)
  }

  return {
    enrollment,
    onchainConfig: {
      destination: config.destination,
      maxRoundup6: config.maxRoundup6.toString(),
      dailyCap6: config.dailyCap6.toString(),
      configEpoch: config.configEpoch,
      paused: config.paused,
      enrolled: config.enrolled,
    },
  }
}
