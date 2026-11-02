import assert from 'node:assert/strict'
import { shouldQuoteWithdrawalFee } from '../src/lib/withdrawal-fee-policy.ts'

const fundedOpen = {
  enabled: true,
  canWrite: true,
  hasAddress: true,
  legacyVaultStatus: 'ready',
  legacyVaultWei: 1n,
}
assert.equal(shouldQuoteWithdrawalFee(fundedOpen), true, 'quote only for an open withdrawal backed by verified funds')
assert.equal(shouldQuoteWithdrawalFee({ ...fundedOpen, enabled: false }), false, 'closed withdrawal surfaces do not estimate a transaction')
assert.equal(shouldQuoteWithdrawalFee({ ...fundedOpen, canWrite: false }), false, 'disconnected or wrong-network wallets do not estimate a transaction')
assert.equal(shouldQuoteWithdrawalFee({ ...fundedOpen, hasAddress: false }), false, 'wallet identity is required')
assert.equal(shouldQuoteWithdrawalFee({ ...fundedOpen, legacyVaultStatus: 'loading' }), false, 'unknown balances do not estimate a transaction')
assert.equal(shouldQuoteWithdrawalFee({ ...fundedOpen, legacyVaultStatus: 'error' }), false, 'failed balance reads do not estimate a transaction')
assert.equal(shouldQuoteWithdrawalFee({ ...fundedOpen, legacyVaultStatus: 'simulated' }), false, 'simulated balances do not estimate a connected transaction')
assert.equal(shouldQuoteWithdrawalFee({ ...fundedOpen, legacyVaultWei: 0n }), false, 'empty legacy vaults do not call withdraw for gas estimation')
console.log('Withdrawal fee estimates require an open sheet and a verified positive legacy-vault balance')
