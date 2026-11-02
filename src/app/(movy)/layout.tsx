import { AppShell } from '@/components/movy/app-shell'

import { WalletAccessGate } from '@/components/movy/wallet-access-gate'

/**
 * The four destinations live in one route group so they share
 * the mobile-first shell and bottom navigation. `/` sits outside it as the
 * landing page, which has its own minimal layout.
 *
 * The shell lives here and only here. Views must not render their own
 * `AppShell`: doing so nests two headers and two bottom bars, which is exactly
 * what the first screenshot pass caught.
 */
export default function MovyLayout({ children }: { children: React.ReactNode }) {
  return (
    <WalletAccessGate>
      <AppShell>{children}</AppShell>
    </WalletAccessGate>
  )
}
