import assert from 'node:assert/strict'
import { getRelayerFeeBudget } from '../src/lib/server/relayer.ts'

const testnetBase = {
  MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: '25000000000',
  MOVY_RELAYER_MAX_TX_FEE_WEI: '50000000000000',
}
assert.deepEqual(getRelayerFeeBudget('testnet', testnetBase), {
  maxFeePerGas: 25_000_000_000n,
  priorityFeePerGas: 1_000_000_000n,
  maxTxFee: 50_000_000_000_000n,
})
assert.equal(getRelayerFeeBudget('testnet', { ...testnetBase, MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: '19000000000' }), null)
assert.equal(getRelayerFeeBudget('testnet', { ...testnetBase, MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: '26000000000' }), null)

const mainnet = {
  NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: '20000000000',
  NEXT_PUBLIC_MOVY_MAX_FEE_PER_GAS_WEI_MAINNET: '30000000000',
  NEXT_PUBLIC_MOVY_PRIORITY_FEE_PER_GAS_WEI_MAINNET: '1000000000',
  NEXT_PUBLIC_MOVY_MAX_TRANSACTION_FEE_WEI_MAINNET: '50000000000000000',
  MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: '30000000000',
  MOVY_RELAYER_MAX_TX_FEE_WEI: '50000000000000000',
}
assert.deepEqual(getRelayerFeeBudget('mainnet', mainnet), {
  maxFeePerGas: 30_000_000_000n,
  priorityFeePerGas: 1_000_000_000n,
  maxTxFee: 50_000_000_000_000_000n,
})
assert.equal(getRelayerFeeBudget('mainnet', { ...mainnet, MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: '30000000001' }), null)
assert.equal(getRelayerFeeBudget('mainnet', { ...mainnet, MOVY_RELAYER_MAX_TX_FEE_WEI: '50000000000000001' }), null)
// A relayer ceiling below the 20 Gwei Arc floor, or a policy whose minimum is below it, yields no budget.
assert.equal(getRelayerFeeBudget('mainnet', { ...mainnet, MOVY_RELAYER_MAX_FEE_PER_GAS_WEI: '19999999999' }), null)
assert.equal(getRelayerFeeBudget('mainnet', {
  ...mainnet,
  NEXT_PUBLIC_MOVY_MIN_BASE_FEE_PER_GAS_WEI_MAINNET: '5000000000',
}), null)
console.log('PASS: relayer fee budgets enforce separate Testnet and manifest-bounded Mainnet gas and transaction ceilings')
