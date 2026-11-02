import assert from 'node:assert/strict'
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  padHex,
} from 'viem'
import { CANONICAL_ARC_USDC, SYSTEM_USDC_EMITTER } from '../src/lib/server/config.ts'
import { validateFinalizedPaymentEvidence } from '../src/lib/server/payment-evidence.ts'

const chainId = 5042002
const wallet = '0x1111111111111111111111111111111111111111'
const merchant = '0x2222222222222222222222222222222222222222'
const destination = '0x3333333333333333333333333333333333333333'
const txHash = `0x${'a'.repeat(64)}`
const blockHash = `0x${'b'.repeat(64)}`
const amount6 = 170_000n
const logIndex = 2
const paymentKey = keccak256(encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
  [BigInt(chainId), txHash, BigInt(logIndex), wallet],
))
const transferLog = {
  address: SYSTEM_USDC_EMITTER,
  topics: [
    keccak256(encodePacked(['string'], ['Transfer(address,address,uint256)'])),
    padHex(wallet, { size: 32 }),
    padHex(merchant, { size: 32 }),
  ],
  data: encodeAbiParameters([{ type: 'uint256' }], [amount6 * 1_000_000_000_000n]),
  logIndex,
  blockNumber: 100n,
  blockHash,
  transactionHash: txHash,
}
const job = {
  paymentKey,
  chainId,
  wallet,
  destination,
  roundupAmount6: '830000',
  paymentTxHash: txHash,
  canonicalLogIndex: logIndex,
  paymentAmount6: amount6.toString(),
  paymentRecipient: merchant,
  paymentBlockNumber: 100,
  paymentIsEligible: true,
}
const nativeTransaction = {
  hash: txHash,
  from: wallet,
  to: merchant,
  value: amount6 * 1_000_000_000_000n,
  input: '0x',
  blockNumber: 100n,
  blockHash,
}
const receipt = {
  status: 'success',
  transactionHash: txHash,
  blockNumber: 100n,
  blockHash,
  logs: [transferLog],
}
const validate = (overrides = {}) => validateFinalizedPaymentEvidence({
  chainId,
  finalizedBlockNumber: 110n,
  canonicalBlockHash: blockHash,
  job,
  transaction: nativeTransaction,
  receipt,
  ...overrides,
})

const valid = validate()
assert.equal(valid.status, 'valid')
if (valid.status === 'valid') assert.equal(valid.paymentAmount6, 170_000n)

assert.equal(validate({ finalizedBlockNumber: 99n }).status, 'deferred', 'Unfinalized payments remain retryable')
assert.equal(validate({ canonicalBlockHash: `0x${'c'.repeat(64)}` }).status, 'deferred', 'Reorg uncertainty remains retryable')
assert.equal(validate({ job: { ...job, roundupAmount6: '10000' } }).status, 'invalid', 'Database roundup tampering is rejected')
assert.equal(validate({ job: { ...job, paymentKey: `0x${'c'.repeat(64)}` } }).status, 'invalid', 'Payment key mismatch is rejected')
assert.equal(validate({ job: { ...job, paymentRecipient: destination } }).status, 'invalid', 'Recipient tampering is rejected')
assert.equal(validate({ transaction: { ...nativeTransaction, from: destination } }).status, 'invalid', 'Transaction sender mismatch is rejected')
assert.equal(validate({ transaction: { ...nativeTransaction, value: 1n } }).status, 'invalid', 'Transaction amount mismatch is rejected')
assert.equal(validate({ transaction: { ...nativeTransaction, hash: `0x${'d'.repeat(64)}` } }).status, 'invalid', 'Transaction hash mismatch is rejected')
assert.equal(validate({ transaction: { ...nativeTransaction, blockHash: `0x${'c'.repeat(64)}` } }).status, 'invalid', 'Transaction block mismatch is rejected')
assert.equal(validate({ receipt: { ...receipt, status: 'reverted' } }).status, 'invalid', 'Reverted payments are rejected')
assert.equal(validate({ receipt: { ...receipt, logs: [] } }).status, 'invalid', 'Missing system transfer event is rejected')

const erc20Transaction = {
  hash: txHash,
  from: wallet,
  to: CANONICAL_ARC_USDC,
  value: 0n,
  blockNumber: 100n,
  blockHash,
  input: encodeFunctionData({
    abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'transfer',
    args: [merchant, amount6],
  }),
}
assert.equal(validate({ transaction: erc20Transaction }).status, 'valid', 'Direct canonical ERC-20 transfers are accepted')
assert.equal(validate({ transaction: { ...erc20Transaction, to: destination } }).status, 'invalid', 'Other token contracts are rejected')

console.log('Finalized payment evidence and accounting checks passed (offline fixtures only)')
