import { ACTIVE_NETWORK_LABEL } from './chain'
import {
  CENTS_UNIT,
  formatCents,
  formatNative,
  formatUsdc6,
  usdc6ToCents,
  weiToCents,
  UNITS_6_PER_CENT,
} from './money'

export type MoneyRead<T> =
  | { status: 'ready'; value: T }
  | { status: 'simulated'; value: T }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'unavailable'
      // `not-configured`: an optional contract (the legacy MovySavings vault) has no address on
      // this network. It is unavailable, never a confirmed zero and never an RPC failure.
      reason: 'disconnected' | 'wrong-network' | 'not-enrolled' | 'no-destination' | 'preview-mode' | 'not-configured'
    }

export type DisplayMoneyRead<T> = MoneyRead<T> & { formatted: string | null }

export function resolveMoneyQuery<T>(input: {
  isConnected: boolean
  isWrongNetwork: boolean
  isLoading: boolean
  isError: boolean
  error: unknown
  data: T | undefined
  unavailableReason?: 'not-enrolled' | 'no-destination' | 'not-configured'
}): MoneyRead<T> {
  if (!input.isConnected) return { status: 'unavailable', reason: 'disconnected' }
  if (input.isWrongNetwork) return { status: 'unavailable', reason: 'wrong-network' }
  if (input.unavailableReason) return { status: 'unavailable', reason: input.unavailableReason }
  if (input.isError) {
    const message = input.error instanceof Error
      ? input.error.message
      : typeof input.error === 'string'
        ? input.error
        : `${ACTIVE_NETWORK_LABEL} RPC read failed.`
    return { status: 'error', message }
  }
  if (input.data !== undefined) return { status: 'ready', value: input.data }
  return { status: 'loading' }
}
export interface SavingsReadings {
  /** Historical confirmed AutoSaver transfers, in the ERC-20's 6-decimal units. */
  confirmedRoundups6: MoneyRead<bigint>
  /** Current balance held by the user's separately owned Arc USDC wallet. */
  destinationUsdc6: MoneyRead<bigint>
  /** Current balance owned by the user in the legacy MovySavings vault, in native 18-decimal units. */
  legacyVaultWei: MoneyRead<bigint>
}

export interface SavingsFigures {
  confirmedRoundups: DisplayMoneyRead<bigint>
  destinationWallet: DisplayMoneyRead<bigint>
  legacyVault: DisplayMoneyRead<bigint>
  /** A transfer may use only a balance that was successfully read from the vault. */
  maxWithdrawWei: bigint | null
  canTransferFromLegacyVault: boolean
}

export function savingsFigureText(reading: DisplayMoneyRead<bigint>): string {
  if (reading.status === 'ready') return reading.formatted ?? '—'
  if (reading.status === 'simulated') return `Mock fixture · ${reading.formatted ?? '—'}`
  if (reading.status === 'loading') return 'Loading…'
  if (reading.status === 'error') return `Unavailable · ${reading.message}`
  switch (reading.reason) {
    case 'disconnected': return 'Connect wallet to view'
    case 'wrong-network': return `Switch to ${ACTIVE_NETWORK_LABEL}`
    case 'not-enrolled': return 'Not enrolled'
    case 'no-destination': return 'No savings destination configured'
    case 'preview-mode': return 'Available in Connected Mode'
    case 'not-configured': return 'Legacy vault not configured'
  }
}

function formatUsdcBalance(units6: bigint): string {
  // Arc's ERC-20 balance may contain sub-cent units. Preserve those digits when
  // present; values that are cent-aligned use the familiar two-decimal display.
  const decimals = units6 % UNITS_6_PER_CENT === 0n ? 2 : 6
  return formatUsdc6(units6, decimals)
}

function formatLegacyVault(wei: bigint): string {
  // Legacy savings are normally cent-aligned, but keep every native decimal if
  // an unusual balance contains a fractional cent.
  if (wei % CENTS_UNIT === 0n) return formatCents(weiToCents(wei))
  return formatNative(wei, 18)
}

function display<T>(reading: MoneyRead<T>, formatter: (value: T) => string): DisplayMoneyRead<T> {
  return {
    ...reading,
    formatted: reading.status === 'ready' || reading.status === 'simulated'
      ? formatter(reading.value)
      : null,
  }
}

/** Keep historical activity, the user's wallet, and the legacy vault independent. */
export function buildSavingsFigures(readings: SavingsReadings): SavingsFigures {
  const legacyVault = display(readings.legacyVaultWei, formatLegacyVault)
  const maxWithdrawWei = readings.legacyVaultWei.status === 'ready'
    ? readings.legacyVaultWei.value
    : null

  return {
    confirmedRoundups: display(readings.confirmedRoundups6, formatUsdcBalance),
    destinationWallet: display(readings.destinationUsdc6, formatUsdcBalance),
    legacyVault,
    maxWithdrawWei,
    // Connected withdrawal inputs are cent-denominated. A sub-cent vault
    // remainder is a real balance, but this UI cannot request it accurately.
    canTransferFromLegacyVault: maxWithdrawWei !== null && maxWithdrawWei >= CENTS_UNIT,
  }
}

export function validateVaultWithdrawal(
  amountWei: bigint,
  vaultBalance: MoneyRead<bigint>,
): { ok: true } | { ok: false; reason: 'invalid-amount' | 'balance-unavailable' | 'exceeds-balance' } {
  if (amountWei <= 0n) return { ok: false, reason: 'invalid-amount' }
  if (vaultBalance.status !== 'ready') return { ok: false, reason: 'balance-unavailable' }
  if (amountWei > vaultBalance.value) return { ok: false, reason: 'exceeds-balance' }
  return { ok: true }
}

/**
 * Re-read the vault immediately before invoking a withdrawal writer. The injected
 * writer keeps boundary tests deterministic and never requires a wallet or RPC.
 */

export async function submitVaultWithdrawal<T>(
  amountWei: bigint,
  readBalance: () => Promise<MoneyRead<bigint>>,
  submit: (amountWei: bigint) => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; reason: 'invalid-amount' | 'balance-unavailable' | 'exceeds-balance' }> {
  if (amountWei <= 0n) return { ok: false, reason: 'invalid-amount' }
  const balance = await readBalance()
  const decision = validateVaultWithdrawal(amountWei, balance)
  if (!decision.ok) return decision
  return { ok: true, result: await submit(amountWei) }
}

/** Convert historical 6-decimal transfers to cents without floating-point math. */
export function confirmedRoundupsCents(roundups6: bigint): bigint {
  return usdc6ToCents(roundups6)
}
