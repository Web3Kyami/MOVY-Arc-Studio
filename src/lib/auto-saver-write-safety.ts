import type { ArcNetwork } from './chain'

/**
 * This public Testnet AutoSaver was deployed with the same compromised
 * development account as owner and relayer. Keep it available for read-only
 * inspection, but never let the connected product activate new spending.
 *
 * `process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK` is inlined at build time. A Mainnet build does
 * not bundle this Testnet contract address; it refuses any Testnet selection instead (see
 * isUnsafeAutoSaverAddress), so dropping the denylist cannot allow a Testnet write.
 */
export const UNSAFE_TESTNET_AUTO_SAVER_ADDRESSES: ReadonlySet<string> =
  process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet'
    ? new Set<string>()
    : new Set<string>(['0xd4a54e8315331a3ecd7e27a0bc4ff007a932332d'])

export type AutoSaverWriteAction =
  | 'enroll'
  | 'update-config'
  | 'increase-allowance'
  | 'clear-allowance'
  | 'pause'
  | 'resume'
  | 'revoke'

export class AutoSaverWriteSafetyError extends Error {
  constructor() {
    super('This automatic saving setup is unavailable right now. No wallet approval prompt will open.')
    this.name = 'AutoSaverWriteSafetyError'
  }
}

export function isUnsafeAutoSaverAddress(network: ArcNetwork, address?: string): boolean {
  if (process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet') {
    // Compiled for Mainnet: every Testnet selection is unsafe, whatever the address.
    return network !== 'mainnet'
  }
  return network === 'testnet' && Boolean(address) &&
    UNSAFE_TESTNET_AUTO_SAVER_ADDRESSES.has(address!.toLowerCase())
}

/**
 * Fail closed for financial activation and configuration writes to the unsafe
 * Testnet deployment. Protective actions remain available: pausing, revoking,
 * and clearing a token allowance.
 */
export function assertAutoSaverWriteAllowed(
  network: ArcNetwork,
  address: string | undefined,
  action: AutoSaverWriteAction,
): void {
  if (!isUnsafeAutoSaverAddress(network, address)) return
  if (action === 'pause' || action === 'revoke' || action === 'clear-allowance') return
  throw new AutoSaverWriteSafetyError()
}
