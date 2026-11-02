'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import { useState } from 'react'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import { createMovyQueryClient, demoWagmiConfig, wagmiConfig } from '@/lib/wagmi'

/**
 * `next-themes` is kept because shadcn-fintech already used it, but it is forced
 * to light-first: `DESIGN-SYSTEM.md` defines a warm light palette and a token
 * theme toggle is out of MVP scope. The FinKit provider was explicitly rejected
 * (see `references/UPSTREAM-MANIFEST.md` F8) because it writes inline styles over
 * `document.documentElement` and would fight this.
 */
import { DemoModeProvider } from '@/context/demo-mode-context'

export function Providers({ children, siteRole, browserTestFixturesEnabled = false }: {
  children: React.ReactNode
  siteRole: 'product' | 'demo'
  browserTestFixturesEnabled?: boolean
}) {
  const [queryClient] = useState(createMovyQueryClient)
  const walletConfig = siteRole === 'demo' ? demoWagmiConfig : wagmiConfig

  return (
    <WagmiProvider config={walletConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider><ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          <DemoModeProvider siteRole={siteRole} browserTestFixturesEnabled={browserTestFixturesEnabled}>
            {children}
          </DemoModeProvider>
        </ThemeProvider></RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
