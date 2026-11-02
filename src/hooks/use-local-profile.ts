'use client'

import { useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSignMessage } from 'wagmi'
import { useDemoMode } from '@/context/demo-mode-context'
import { useWallet } from '@/hooks/use-wallet'
import { profileMessage, validProfile, type LocalProfile } from '@/lib/profile-contract'
export { AVATARS, type Avatar, type LocalProfile } from '@/lib/profile-contract'
const EVENT = 'movy:profile-change'

export function profileStorageKey(isDemo: boolean, address?: string) {
  return isDemo ? 'movy:profile:v1:demo' : address ? `movy:profile:v1:wallet:${address.toLowerCase()}` : null
}
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener)
  window.addEventListener(EVENT, listener)
  return () => { window.removeEventListener('storage', listener); window.removeEventListener(EVENT, listener) }
}
export function useLocalProfile() {
  const { isDemoMode, profile: demo } = useDemoMode()
  const { address, isConnected } = useWallet({ readEnabled: false })
  const { signMessageAsync } = useSignMessage()
  const queryClient = useQueryClient()
  const wallet = !isDemoMode && isConnected ? address?.toLowerCase() : undefined
  const key = profileStorageKey(isDemoMode, wallet)
  const raw = useSyncExternalStore(subscribe, () => {
    try { return key ? localStorage.getItem(key) : null } catch { return null }
  }, () => null)
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false)
  const remote = useQuery({
    queryKey: ['wallet-profile', wallet], enabled: !!wallet,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/profile?wallet=${encodeURIComponent(wallet!)}`, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Profile unavailable')
      const data = await response.json()
      if (data.profile !== null && !validProfile(data.profile)) throw new Error('Invalid profile')
      return data.profile as LocalProfile | null
    },
    retry: false,
  })
  const fallback: LocalProfile = { name: isDemoMode ? demo.name : '', avatar: isDemoMode ? 'portrait' : 'sage', photo: null }
  let local: LocalProfile | null = null
  try { const stored = raw ? JSON.parse(raw) : null; if (validProfile(stored)) local = stored } catch { /* Ignore invalid local data. */ }
  const profile = wallet ? remote.data ?? (remote.isSuccess ? local : null) ?? fallback : local ?? fallback
  async function save(next: LocalProfile) {
    if (!key) throw new Error('Connect a wallet to save its profile.')
    if (isDemoMode) {
      localStorage.setItem(key, JSON.stringify(next))
      window.dispatchEvent(new Event(EVENT))
      return
    }
    if (!wallet) throw new Error('Connect a wallet to save its profile.')
    const challenge = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet }) })
    if (!challenge.ok) throw new Error('Profile unavailable')
    const { nonce } = await challenge.json()
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(next)))
    const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
    const signature = await signMessageAsync({ account: address, message: profileMessage(wallet, nonce, digest) })
    const response = await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet, nonce, signature, profile: next }) })
    if (!response.ok) throw new Error('Profile unavailable')
    queryClient.setQueryData(['wallet-profile', wallet], next)
  }
  return { profile, remoteProfile: wallet ? remote.data ?? null : null, ready: hydrated && (!wallet || !remote.isPending), error: !!wallet && remote.isError, refetch: remote.refetch, identity: key, save, displayName: profile.name || (isConnected && address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Your profile') }
}
