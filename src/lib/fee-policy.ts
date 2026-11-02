import type { ArcNetwork } from './chain'

/**
 * Arc documents a 20 Gwei base fee floor on both Testnet and Mainnet
 * (https://docs.arc.io/arc/references/gas-and-fees). The Testnet policy below is
 * fixed. Mainnet values are never hardcoded: they come from the owner-verified
 * manifest through the Mainnet-only public build variables, and the minimum base
 * fee must be at least the documented floor.
 */
export const ARC_MAINNET_MIN_BASE_FEE_FLOOR_WEI = 20_000_000_000n

const TESTNET_FEE_POLICY = {
  minBaseFeePerGasWei: 20_000_000_000n,
  maxFeePerGasWei: 25_000_000_000n,
  priorityFeePerGasWei: 1_000_000_000n,
  maxTransactionFeeWei: null,
} as const

export interface ArcFeePolicy {
  minBaseFeePerGasWei: bigint
  maxFeePerGasWei: bigint
  priorityFeePerGasWei: bigint
  maxTransactionFeeWei: bigint | null
}

function readPositiveUint(env: NodeJS.ProcessEnv, key: string): bigint {
  const value = env[key]
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Verified Arc Mainnet fee policy is missing ${key}`)
  }
  const parsed = BigInt(value)
  if (parsed >= 2n ** 256n) throw new Error(`${key} is outside the supported uint256 range`)
  return parsed
}

export function getArcFeePolicy(network: ArcNetwork, env: NodeJS.ProcessEnv = process.env): ArcFeePolicy {
  if (network === 'testnet') return TESTNET_FEE_POLICY

  const policy = {
    minBaseFeePerGasWei: readPositiveUint(env, 'NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET'),
    maxFeePerGasWei: readPositiveUint(env, 'NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET'),
    priorityFeePerGasWei: readPositiveUint(env, 'NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET'),
    maxTransactionFeeWei: readPositiveUint(env, 'NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET'),
  }
  if (policy.minBaseFeePerGasWei < ARC_MAINNET_MIN_BASE_FEE_FLOOR_WEI) {
    throw new Error('Mainnet minimum base fee per gas is below the 20 Gwei Arc floor')
  }
  if (policy.maxFeePerGasWei < policy.minBaseFeePerGasWei) {
    throw new Error('Mainnet maximum fee per gas is below its verified minimum base fee')
  }
  if (policy.priorityFeePerGasWei > policy.maxFeePerGasWei) {
    throw new Error('Mainnet priority fee per gas exceeds its verified maximum fee')
  }
  if (env.MOVY_RELAYER_MAX_TX_FEE_WEI !== undefined && env.MOVY_RELAYER_MAX_TX_FEE_WEI !== policy.maxTransactionFeeWei.toString()) {
    throw new Error('Mainnet relayer transaction fee ceiling does not match the owner-verified fee policy')
  }
  return policy
}
