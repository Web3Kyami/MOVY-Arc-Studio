import type { Chain } from 'viem'

export type ArcNetwork = 'mainnet' | 'testnet'

/**
 * Arc network configuration.
 *
 * Chain IDs, RPC URLs, explorers, and USDC behavior are sourced from official
 * Arc documentation. A read-only comparison of the official and independent
 * Mainnet RPCs passed in GitHub Actions run 38667137333 (chain ID 5042 and
 * canonical USDC code and decimals). This verifies network configuration only,
 * not a MOVY deployment or a Mainnet financial transaction.
 *
 * Sources:
 *   https://docs.arc.io/arc/references/connect-to-arc
 *   https://docs.arc.io/arc/references/contract-addresses
 *   https://docs.arc.io/arc/references/gas-and-fees
 *   https://docs.arc.io/arc/references/evm-differences
 */

export const ARC_MAINNET_ID = 5042
export const ARC_TESTNET_ID = 5042002
export const ARC_MAINNET_RPC_URL = 'https://rpc.mainnet.arc.io'

const selectedNetwork = process.env.NEXT_PUBLIC_MOVY_TARGET_NETWORK
if (selectedNetwork !== undefined && selectedNetwork !== 'mainnet' && selectedNetwork !== 'testnet') {
  throw new Error('NEXT_PUBLIC_MOVY_TARGET_NETWORK must be mainnet or testnet')
}
const declaredChainId = process.env.NEXT_PUBLIC_MOVY_CHAIN_ID
const expectedDeclaredChainId = selectedNetwork === 'mainnet' ? String(ARC_MAINNET_ID) : String(ARC_TESTNET_ID)
if (declaredChainId !== undefined && declaredChainId !== expectedDeclaredChainId) {
  throw new Error(`NEXT_PUBLIC_MOVY_CHAIN_ID must match the selected Arc network (${expectedDeclaredChainId})`)
}
if (process.env.NODE_ENV === 'production' && (!selectedNetwork || !declaredChainId)) {
  throw new Error('Production requires an explicit Arc target network and chain ID')
}

/** One build targets one Arc network. Wallets cannot switch between app environments. */
export const ACTIVE_NETWORK: ArcNetwork = selectedNetwork === 'mainnet' ? 'mainnet' : 'testnet'
export const ACTIVE_CHAIN_ID = ACTIVE_NETWORK === 'mainnet' ? ARC_MAINNET_ID : ARC_TESTNET_ID
export const ACTIVE_NETWORK_LABEL = ACTIVE_NETWORK === 'mainnet' ? 'Arc' : 'Arc Testnet'

const arcMainnet = {
  id: ARC_MAINNET_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL || ARC_MAINNET_RPC_URL] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL || 'https://explorer.arc.io' } },
} as const satisfies Chain

const arcTestnet = {
  id: ARC_TESTNET_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL || ''] } },
  blockExplorers: { default: { name: 'Arc Testnet Explorer', url: process.env.NEXT_PUBLIC_ARC_TESTNET_EXPLORER_URL || '' } },
} as const satisfies Chain

/** The sole chain compiled into this product deployment. */
export const ACTIVE_CHAIN = ACTIVE_NETWORK === 'mainnet' ? arcMainnet : arcTestnet

/**
 * The 6-decimal ERC-20 interface for the same underlying USDC balance.
 * AutoSaver uses this view for allowances and transfers; MovySavings uses the
 * 18-decimal native view for `msg.value`, gas, and withdrawable vault accounting.
 * Never add these views together or pass an amount between them without the
 * explicit 10^12 unit conversion.
 */
export const USDC_ERC20_INTERFACE = '0x3600000000000000000000000000000000000000' as const
export const CANONICAL_ARC_USDC = '0x3600000000000000000000000000000000000000' as const

export function explorerFor(network: ArcNetwork) {
  if (network !== ACTIVE_NETWORK) throw new Error('Explorer links cannot cross the selected MOVY network')
  const url = ACTIVE_CHAIN.blockExplorers?.default?.url
  if (!url) throw new Error('Arc explorer is not configured')
  return url
}

export function addressUrl(network: ArcNetwork, address: string): string {
  return `${explorerFor(network)}/address/${address}`
}

export function txUrl(network: ArcNetwork, hash: string): string {
  return `${explorerFor(network)}/tx/${hash}`
}

export function networkLabel(network: ArcNetwork): string {
  if (network !== ACTIVE_NETWORK) throw new Error('Network labels cannot cross the selected MOVY deployment')
  return ACTIVE_NETWORK_LABEL
}

/** Native Arc USDC uses 18 decimals; the ERC-20 allowance/transfer view uses 6. */
export const DISPLAY_DECIMALS = 2
