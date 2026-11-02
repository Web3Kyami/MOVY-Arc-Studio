export const AVATARS = ['portrait', 'sage', 'sand', 'clay'] as const
export type Avatar = typeof AVATARS[number]
export interface LocalProfile { name: string; avatar: Avatar; photo: string | null }

export function validProfile(value: unknown): value is LocalProfile {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return typeof p.name === 'string' && p.name.trim() === p.name && p.name.length >= 1 && p.name.length <= 60 &&
    typeof p.avatar === 'string' && AVATARS.includes(p.avatar as Avatar) &&
    (p.photo === null || typeof p.photo === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(p.photo) && p.photo.length < 500_000)
}

export function profileMessage(wallet: string, nonce: string, digest: string) {
  return `MOVY profile update\nWallet: ${wallet.toLowerCase()}\nNonce: ${nonce}\nProfile SHA-256: ${digest}`
}
