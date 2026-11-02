'use client'

import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from 'wagmi'
import { ACTIVE_NETWORK, ACTIVE_CHAIN, type ArcNetwork } from '@/lib/chain'
import { movyAddress } from '@/lib/contract'

/** The network is fixed at build time; it is never inferred from the wallet. */
export const ACTIVE_CHAIN_ID = ACTIVE_CHAIN.id

export function arcRpcUrl(network: ArcNetwork): string {
  if (network !== ACTIVE_NETWORK) throw new Error('RPC URLs cannot cross the selected MOVY network')
  return ACTIVE_CHAIN.rpcUrls.default.http[0]
}

export type DataState = 'disconnected' | 'wrongNetwork' | 'loading' | 'empty' | 'ready' | 'error'

export function useWallet({ readEnabled = true }: { readEnabled?: boolean } = {}) {
  const { address, chainId, isConnected, isConnecting: isAccountConnecting } = useAccount()
  const { connectors, connect, connectAsync, error: connectError, isPending: isConnectPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: isSwitchPending, error: switchError } = useSwitchChain()

  // Fixed to the active network rather than inferred from the wallet.
  const network: ArcNetwork = ACTIVE_NETWORK
  const expectedChain = ACTIVE_CHAIN

  // Wrong means "not the chain this build targets", never "mainnet".
  const isWrongNetwork = isConnected && chainId !== ACTIVE_CHAIN_ID

  const contract = movyAddress(network)
  const isDeployed = contract !== undefined

  /**
   * The single USDC balance. This reads the *native* balance, never the ERC-20
   * `balanceOf` at 0x3600â€¦0000: on Arc that view truncates sub-cent amounts, so a
   * funded wallet can report zero. Only one balance is ever displayed.
   */
  const balance = useBalance({
    address,
    chainId: expectedChain.id,
    query: { enabled: readEnabled && isConnected && !isWrongNetwork },
  })

  const nativeWei = balance.data?.value ?? 0n

  return {
    address,
    chainId,
    isConnected,
    network,
    expectedChain,
    isWrongNetwork,
    contract,
    isDeployed,
    nativeWei,
    isBalanceLoading: balance.isLoading && isConnected && !isWrongNetwork,
    isBalanceError: balance.isError,
    refetchBalance: balance.refetch,
    connectors,
    connect,
    connectAsync,
    connectError,
    isConnecting: isConnectPending || isAccountConnecting,
    isSwitching: isSwitchPending,
    switchChain: () => switchChain({ chainId: ACTIVE_CHAIN_ID }),
    switchChainError: (switchError as Error | null)?.message ?? null,
    disconnect,
  }
}

/** Derive the shared state label every data surface renders. */
export function dataState(opts: {
  isConnected: boolean
  isWrongNetwork: boolean
  isLoading: boolean
  isError: boolean
  isEmpty: boolean
}): DataState {
  if (!opts.isConnected) return 'disconnected'
  if (opts.isWrongNetwork) return 'wrongNetwork'
  if (opts.isLoading) return 'loading'
  if (opts.isError) return 'error'
  if (opts.isEmpty) return 'empty'
  return 'ready'
}
