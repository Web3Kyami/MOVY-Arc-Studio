import React from 'react'
import { cn } from '@/lib/utils'

export type GoalArtworkType = 'emergency' | 'travel' | 'tech' | 'home' | 'general'

interface GoalArtworkProps {
  type?: GoalArtworkType
  variant?: 'banner' | 'squircle'
  className?: string
  showCoverPhoto?: boolean
  coverSrc?: string
}

export function inferGoalType(title: string, category?: string): GoalArtworkType {
  const t = (title + ' ' + (category || '')).toLowerCase()
  if (t.includes('travel') || t.includes('trip') || t.includes('japan') || t.includes('vacation') || t.includes('flight')) return 'travel'
  if (t.includes('emergency') || t.includes('cushion') || t.includes('safety') || t.includes('rainy')) return 'emergency'
  if (t.includes('gadget') || t.includes('laptop') || t.includes('tech') || t.includes('phone') || t.includes('pc') || t.includes('screen')) return 'tech'
  if (t.includes('home') || t.includes('apartment') || t.includes('rent') || t.includes('house') || t.includes('furniture')) return 'home'
  return 'general'
}

/**
 * Cohesive original editorial artwork for MOVY savings goals.
 * Built with bespoke layered vector geometry and organic harmonies
 * reflecting the core palette: Deep Evergreen (#082E26), Rich Green (#087F5B),
 * Citrus Accent (#C5F47A), Warm Off-White, and contextual accents.
 */
export function GoalArtwork({
  type = 'emergency',
  variant = 'squircle',
  className,
  coverSrc,
}: GoalArtworkProps) {
  if (coverSrc) {
    return (
      <div
        className={cn(
          'relative flex items-center justify-center overflow-hidden rounded-2xl bg-[#082E26] border border-[#082E26]/20 shadow-2xs select-none',
          variant === 'banner' ? 'h-36 w-full' : 'size-16 md:size-20',
          className
        )}
      >
        <img
          src={coverSrc}
          alt="Savings goal artwork"
          className="size-full object-cover transition-transform duration-500 hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#082E26]/60 via-transparent to-transparent pointer-events-none" />
      </div>
    )
  }

  // 1. TRAVEL / JAPAN TRIP (Sky Blue & Citrus Sunrise)
  if (type === 'travel') {
    return (
      <div
        className={cn(
          'relative flex items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-sky-50 via-blue-50/70 to-slate-100 dark:from-sky-950/40 dark:via-blue-900/20 dark:to-stone-900/40 border border-sky-200/60 dark:border-sky-800/40 shadow-2xs select-none',
          variant === 'banner' ? 'h-32 w-full' : 'size-16 md:size-20',
          className
        )}
      >
        <svg
          viewBox="0 0 160 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="size-full"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          <rect width="160" height="120" fill="#F0F9FF" />
          {/* Subtle sky gradient */}
          <circle cx="80" cy="110" r="70" fill="#E0F2FE" />
          {/* Distant mountain silhouette */}
          <path d="M5 120L45 52L72 88L94 62L155 120H5Z" fill="#7DD3FC" fillOpacity="0.45" />
          {/* Foreground mountain peak in deep azure */}
          <path d="M28 120L68 64L94 92L116 72L158 120H28Z" fill="#0284C7" fillOpacity="0.75" />
          {/* Snow cap highlight */}
          <path d="M68 64L62 73L74 73L68 64Z" fill="#FFFFFF" fillOpacity="0.9" />
          {/* Citrus glowing sun at horizon */}
          <circle cx="128" cy="38" r="14" fill="#C5F47A" />
          <circle cx="128" cy="38" r="10" fill="#E2FBB1" />
          {/* Subtle flight trail */}
          <path d="M10 32C45 28 85 36 112 40" stroke="#0284C7" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.6" />
        </svg>
      </div>
    )
  }

  // 2. TECH / STUDIO (Deep Indigo, Muted Peach & Precision Chip)
  if (type === 'tech') {
    return (
      <div
        className={cn(
          'relative flex items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-orange-50 via-amber-50/60 to-stone-100 dark:from-orange-950/30 dark:via-amber-950/20 dark:to-stone-900/40 border border-orange-200/60 dark:border-orange-800/40 shadow-2xs select-none',
          variant === 'banner' ? 'h-32 w-full' : 'size-16 md:size-20',
          className
        )}
      >
        <svg
          viewBox="0 0 160 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="size-full"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          <rect width="160" height="120" fill="#FFF7ED" />
          <circle cx="80" cy="60" r="46" fill="#FFEDD5" fillOpacity="0.6" />
          {/* Minimalist device display canvas */}
          <rect x="46" y="30" width="68" height="60" rx="14" fill="#1E293B" />
          <rect x="52" y="36" width="56" height="48" rx="8" fill="#0F172A" />
          {/* Screen glow & architecture lines */}
          <rect x="58" y="44" width="20" height="14" rx="4" fill="#C5F47A" fillOpacity="0.85" />
          <rect x="82" y="44" width="20" height="6" rx="3" fill="#EA580C" />
          <rect x="82" y="54" width="14" height="4" rx="2" fill="#FDBA74" />
          <rect x="58" y="64" width="44" height="12" rx="4" fill="#334155" />
          {/* Stand */}
          <path d="M72 90H88L92 98H68L72 90Z" fill="#64748B" />
        </svg>
      </div>
    )
  }

  // 3. HOME / SANCTUARY (Terracotta, Warm Sand & Architectural Arch)
  if (type === 'home') {
    return (
      <div
        className={cn(
          'relative flex items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-rose-50 via-stone-100 to-amber-50 dark:from-rose-950/30 dark:via-stone-900/40 dark:to-amber-950/20 border border-rose-200/60 dark:border-rose-800/40 shadow-2xs select-none',
          variant === 'banner' ? 'h-32 w-full' : 'size-16 md:size-20',
          className
        )}
      >
        <svg
          viewBox="0 0 160 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="size-full"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          <rect width="160" height="120" fill="#FFF1F2" />
          <circle cx="80" cy="55" r="48" fill="#FFE4E6" fillOpacity="0.7" />
          {/* Exterior Architectural Archway */}
          <path
            d="M48 102V52C48 34.3 62.3 20 80 20C97.7 20 112 34.3 112 52V102H48Z"
            fill="#E11D48"
            fillOpacity="0.12"
            stroke="#BE123C"
            strokeWidth="2.5"
          />
          {/* Inner sanctuary portal */}
          <path
            d="M62 102V58C62 48 70 40 80 40C90 40 98 48 98 58V102H62Z"
            fill="#BE123C"
          />
          {/* Warm indoor light */}
          <circle cx="80" cy="70" r="10" fill="#FDE047" fillOpacity="0.9" />
          {/* Subtle botanic leaf silhouette */}
          <path
            d="M102 102C102 88 116 80 120 74C122 84 116 96 108 102H102Z"
            fill="#087F5B"
            fillOpacity="0.65"
          />
        </svg>
      </div>
    )
  }

  // 4. GENERAL / GROWTH (Deep Evergreen & Sprout Leaves)
  if (type === 'general') {
    return (
      <div
        className={cn(
          'relative flex items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-50 via-teal-50/60 to-stone-100 dark:from-emerald-950/30 dark:via-teal-950/20 dark:to-stone-900/40 border border-emerald-200/60 dark:border-emerald-800/40 shadow-2xs select-none',
          variant === 'banner' ? 'h-32 w-full' : 'size-16 md:size-20',
          className
        )}
      >
        <svg
          viewBox="0 0 160 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="size-full"
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          <rect width="160" height="120" fill="#ECFDF5" />
          <circle cx="80" cy="60" r="48" fill="#D1FAE5" />
          {/* Stepped growth terraces */}
          <path d="M30 110H130L120 85H40L30 110Z" fill="#082E26" fillOpacity="0.85" />
          <path d="M45 85H115L108 65H52L45 85Z" fill="#087F5B" />
          {/* Sprouting citrus leaf */}
          <path d="M80 65C70 50 72 35 80 25C88 35 90 50 80 65Z" fill="#C5F47A" />
          <circle cx="80" cy="30" r="3" fill="#082E26" />
        </svg>
      </div>
    )
  }

  // 5. EMERGENCY CUSHION (Default: Deep Evergreen, Rich Green & Golden Security Core)
  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-stone-50 via-emerald-50/50 to-amber-50/40 dark:from-stone-900/40 dark:via-emerald-950/20 dark:to-amber-950/20 border border-emerald-200/60 dark:border-emerald-800/40 shadow-2xs select-none',
        variant === 'banner' ? 'h-32 w-full' : 'size-16 md:size-20',
        className
      )}
    >
      <svg
        viewBox="0 0 160 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="size-full"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <rect width="160" height="120" fill="#F4F8F5" />
        {/* Soft geometric sanctuary backplate */}
        <circle cx="80" cy="60" r="46" fill="#E2EBE5" />
        <circle cx="80" cy="60" r="38" fill="#D6E4DB" />

        {/* Deep Evergreen Sanctuary Shield */}
        <path
          d="M80 22C64 22 52 32 52 52C52 74 68 94 80 98C92 94 108 74 108 52C108 32 96 22 80 22Z"
          fill="#082E26"
        />

        {/* Rich Green Inner Safety Vault */}
        <path
          d="M80 32C68 32 60 40 60 54C60 70 72 84 80 88C88 84 100 70 100 54C100 40 92 32 80 32Z"
          fill="#087F5B"
        />

        {/* Luminous Citrus Round-Up Core */}
        <circle cx="80" cy="56" r="13" fill="#C5F47A" />
        <circle cx="80" cy="56" r="5" fill="#082E26" />

        {/* Floating protective arc */}
        <path
          d="M62 44C68 38 74 36 80 36C86 36 92 38 98 44"
          stroke="#C5F47A"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}
