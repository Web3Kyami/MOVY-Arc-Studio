'use client'

import React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { DesktopNav, MobileNav, WordmarkLink } from '@/components/movy/nav'
import { useMovyModeData } from '@/hooks/use-movy-mode-data'
import { useLocalProfile } from '@/hooks/use-local-profile'
import { ProfileAvatar } from './profile-avatar'
import './consumer.css'

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { isDemoMode, account } = useMovyModeData()
  const { profile, displayName } = useLocalProfile()
  const editing = pathname === '/settings/profile' || pathname === '/savings/new' || pathname.startsWith('/savings/') && pathname.endsWith('/edit')
  const hasPageWalletAction = ['/home', '/savings', '/activity', '/settings'].includes(pathname)
  return (
    <div className={`consumer-shell${pathname.startsWith('/settings') ? ' consumer-settings-shell' : ''}${pathname === '/settings' && !account.isConnected ? ' consumer-settings-needs-wallet' : ''}`}>
      <a href="#main" className="consumer-skip">Skip to content</a>
      <aside className="consumer-sidebar">
        <WordmarkLink />
        {isDemoMode && <span className="consumer-demo">Demo</span>}
        <DesktopNav />
        <Link href="/settings/profile" className="consumer-identity" aria-label={`Edit ${displayName}'s profile`}>
          <ProfileAvatar profile={profile} size={36} />
          <span><strong>{displayName}</strong></span>
        </Link>
      </aside>
      <div className="consumer-canvas">
        <header className="consumer-header">
          <WordmarkLink />
          {isDemoMode ? <span className="consumer-demo">Demo</span> : (
            account.isConnected ? (
              <Link href="/settings" className="consumer-wallet-link">
                {account.isWrongNetwork ? 'Switch network' : account.displayAddress}
              </Link>
            ) : !hasPageWalletAction ? (
              <Link href="/onboarding" className="consumer-wallet-link">Connect wallet</Link>
            ) : null
          )}
        </header>
        <main id="main" tabIndex={-1} className={`consumer-main${pathname === '/home' ? ' consumer-home' : ''}`}>
          {children}
        </main>
      </div>
      {!editing && <MobileNav />}
    </div>
  )
}

export function Stack({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>
}
