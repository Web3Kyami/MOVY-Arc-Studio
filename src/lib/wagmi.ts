'use client'

import { createConfig, http } from 'wagmi'
import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { injected, walletConnect } from 'wagmi/connectors'
import { ACTIVE_CHAIN } from './chain'
import { QueryClient } from '@tanstack/react-query'

/**
 * Wallet layer.
 *
 * Deliberate choices:
 *  - `ssr: true` because every data surface depends on a client wallet, and the
 *    landing page must not flash a hydration mismatch.
 *  - Arc's chains are defined locally rather than imported from `viem/chains`,
 *    because MOVY must not silently follow a library's idea of Arc's RPC or
 *    explorer. `chain.ts` carries the values verified against the live RPC.
 *  - Exactly one Arc chain is registered per build. A Testnet deployment cannot
 *    switch wallet writes onto Mainnet, and a Mainnet build contains no Testnet
 *    transport. Changing the build target requires the guarded release build.
 *  - The product wallet choices are MetaMask, Rabby and WalletConnect, in that
 *    order. WalletConnect uses a public app identifier, not a signing key.
 *  - Injected connectors target MetaMask and Rabby explicitly; no generic
 *    injected or Coinbase option is exposed.
 */
const activeChain = ACTIVE_CHAIN
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim()
export const hasWalletConnectProjectId = Boolean(walletConnectProjectId)
const productConnectors = [
  injected({ target: 'metaMask' }),
  injected({ target: 'rabby' }),
  ...(walletConnectProjectId
    ? [walletConnect({ projectId: walletConnectProjectId, showQrModal: true })]
    : []),
]

export const wagmiConfig = walletConnectProjectId ? getDefaultConfig({
  appName: 'MOVY', projectId: walletConnectProjectId, chains: [activeChain], ssr: true,
  transports: { [activeChain.id]: http(activeChain.rpcUrls.default.http[0]) } as never,
}) : createConfig({
  chains: [activeChain],
  connectors: productConnectors,
  ssr: true,
  transports: {
    [activeChain.id]: http(activeChain.rpcUrls.default.http[0]),
  } as never,
})

// The isolated Demo origin deliberately has no wallet connectors. This keeps
// injected providers and persisted wallet sessions unavailable to Demo screens.
export const demoWagmiConfig = createConfig({
  multiInjectedProviderDiscovery: false,
  chains: [activeChain],
  connectors: [],
  ssr: true,
  transports: {
    [activeChain.id]: http(activeChain.rpcUrls.default.http[0]),
  } as never,
}) as unknown as typeof wagmiConfig

export function createMovyQueryClient() {
  return new QueryClient({
  defaultOptions: {
    queries: {
      // Arc finalises on inclusion, so a short stale window is enough and keeps
      // the balance honest without a websocket.
      staleTime: 4_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
  })
}

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
