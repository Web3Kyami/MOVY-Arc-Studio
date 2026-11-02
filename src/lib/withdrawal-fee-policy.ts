export function shouldQuoteWithdrawalFee(input: {
  enabled: boolean
  canWrite: boolean
  hasAddress: boolean
  legacyVaultStatus: 'loading' | 'ready' | 'unavailable' | 'error' | 'simulated'
  legacyVaultWei: bigint
}): boolean {
  return input.enabled &&
    input.canWrite &&
    input.hasAddress &&
    input.legacyVaultStatus === 'ready' &&
    input.legacyVaultWei > 0n
}
