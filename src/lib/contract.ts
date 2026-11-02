import type { Address } from 'viem'
import { ACTIVE_NETWORK, type ArcNetwork } from './chain'

/**
 * MovySavings ABI — the exact surface of `contracts/src/MovySavings.sol`.
 *
 * Only native USDC is ever sent. The 6-decimal ERC-20 interface at
 * `0x3600000000000000000000000000000000000000` is deliberately absent from this
 * ABI so there is no code path that could send an amount in the wrong units.
 */
export const MOVY_ABI = [
  {
    type: 'function',
    name: 'payAndSave',
    stateMutability: 'payable',
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'purchaseCents', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amountWei', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'savingsOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalLiabilities',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'quotePurchase',
    stateMutability: 'pure',
    inputs: [{ name: 'purchaseCents', type: 'uint256' }],
    outputs: [
      { name: 'roundupCents', type: 'uint256' },
      { name: 'purchaseWei', type: 'uint256' },
      { name: 'roundupWei', type: 'uint256' },
      { name: 'totalWei', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'MAX_PURCHASE_CENTS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'PurchaseRounded',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'purchaseWei', type: 'uint256', indexed: false },
      { name: 'roundupWei', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SavingsWithdrawn',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'amountWei', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'error',
    name: 'MovyZeroPurchase',
    inputs: [],
  },
  { type: 'error', name: 'MovyPurchaseTooLarge', inputs: [
    { name: 'purchaseCents', type: 'uint256' },
    { name: 'maxCents', type: 'uint256' },
  ] },
  { type: 'error', name: 'MovyZeroMerchant', inputs: [] },
  { type: 'error', name: 'MovySelfMerchant', inputs: [] },
  { type: 'error', name: 'MovyValueMismatch', inputs: [
    { name: 'sentWei', type: 'uint256' },
    { name: 'requiredWei', type: 'uint256' },
  ] },
  { type: 'error', name: 'MovyInsufficientSavings', inputs: [
    { name: 'requestedWei', type: 'uint256' },
    { name: 'availableWei', type: 'uint256' },
  ] },
  { type: 'error', name: 'MovyZeroWithdrawal', inputs: [] },
  { type: 'error', name: 'MovyReentrancy', inputs: [] },
  { type: 'error', name: 'MovyMerchantTransferFailed', inputs: [] },
] as const

/**
 * Deployment addresses per network, set at deploy time and recorded in STATE.md.
 *
 * `undefined` means "not deployed on this network yet". The UI must refuse to
 * write in that case rather than falling back to a placeholder or a mock, because
 * `AGENT-INSTRUCTIONS.md` forbids showing fabricated data when connected.
 *
 * Every read is a *static* `process.env.NEXT_PUBLIC_FOO` member expression on
 * purpose. A computed `process.env[someExpression]` is not statically analysable,
 * so the bundler leaves it as a runtime lookup and it silently evaluates to
 * `undefined` in the browser. That bug shipped once already and is why the values
 * are written out longhand.
 */
const ACTIVE_MOVY_ADDRESS = process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet'
  ? process.env.NEXT_PUBLIC_MOVY_ADDRESS_MAINNET as Address | undefined
  : process.env.NEXT_PUBLIC_MOVY_ADDRESS_TESTNET as Address | undefined
const ACTIVE_AUTO_SAVER_ADDRESS = process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet'
  ? process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_MAINNET as Address | undefined
  : process.env.NEXT_PUBLIC_MOVY_AUTO_SAVER_TESTNET as Address | undefined
const ACTIVE_STORE_ADDRESS = process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK === 'mainnet'
  ? process.env.NEXT_PUBLIC_DEMO_STORE_MAINNET as Address | undefined
  : process.env.NEXT_PUBLIC_DEMO_STORE_TESTNET as Address | undefined

function assertActiveNetwork(network: ArcNetwork): void {
  if (network !== ACTIVE_NETWORK) throw new Error('Contract addresses cannot cross the selected MOVY network')
}

export function movyAddress(network: ArcNetwork): Address | undefined {
  assertActiveNetwork(network)
  return ACTIVE_MOVY_ADDRESS
}

export function movyAutoSaverAddress(network: ArcNetwork): Address | undefined {
  assertActiveNetwork(network)
  return ACTIVE_AUTO_SAVER_ADDRESS
}

export function isDeployed(network: ArcNetwork): boolean {
  return movyAddress(network) !== undefined
}

/** The controlled Demo Store recipient for a network. */
export function demoStore(network: ArcNetwork): Address | undefined {
  assertActiveNetwork(network)
  return ACTIVE_STORE_ADDRESS
}
