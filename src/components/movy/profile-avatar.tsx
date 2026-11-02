import Image from 'next/image'
import type { LocalProfile } from '@/hooks/use-local-profile'

export function ProfileAvatar({ profile, size = 112 }: { profile: LocalProfile; size?: number }) {
  const source = profile.photo || (profile.avatar === 'portrait' ? '/avatars/alex.png' : null)
  return source ? <Image src={source} unoptimized alt="" width={size} height={size} className="profile-avatar" /> : (
    <span className={`profile-avatar avatar-${profile.avatar}`} style={{ width: size, height: size }} aria-hidden="true">
      {profile.name.trim().slice(0, 1).toUpperCase() || 'M'}
    </span>
  )
}
