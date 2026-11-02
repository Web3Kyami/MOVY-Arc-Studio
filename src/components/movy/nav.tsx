'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, PiggyBank, Receipt, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

export const DESTINATIONS = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/savings', label: 'Savings', icon: PiggyBank },
  { href: '/activity', label: 'Activity', icon: Receipt },
  { href: '/settings', label: 'Settings', icon: SlidersHorizontal },
] as const

export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[520px] md:hidden border-t border-border/80 bg-surface/95 backdrop-blur-xl"
      style={{ paddingBottom: 'calc(0.35rem + var(--nav-safe-bottom))' }}
    >
      <ul className="grid grid-cols-4 px-2 py-1.5">
        {DESTINATIONS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`)
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[52px] min-w-[44px] flex-col items-center justify-center gap-1 rounded-2xl px-1 py-1.5 text-[11px] font-semibold transition-all active:scale-95',
                  active
                    ? 'text-[#082E26] dark:text-[#C5F47A]'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <div
                  className={cn(
                    'flex h-7 px-3.5 items-center justify-center rounded-full transition-all duration-200',
                    active
                      ? 'text-[#087F5B]'
                      : 'text-muted-foreground'
                  )}
                >
                  <Icon className={cn('size-4 transition-transform', active && 'scale-105')} aria-hidden />
                </div>
                <span className={cn('tracking-tight font-medium text-[11px]', active && 'font-bold text-[#082E26] dark:text-[#C5F47A]')}>
                  {label}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function DesktopNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Desktop Main" className="flex flex-col gap-1 w-full">
      {DESTINATIONS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-11 items-center gap-3 rounded-[length:var(--radius-control)] px-3 py-2 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#087F5B] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-stone-900',
              active
                ? 'bg-accent-soft text-accent font-bold'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function MovyBrandMark({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('shrink-0 select-none transition-transform hover:scale-105', className)}
      aria-label="MOVY brand mark"
      role="img"
    >
      <rect width="36" height="36" rx="10" fill="#082E26" />
      <path
        d="M8 25V13.5C8 11.567 9.567 10 11.5 10H12.5C14.433 10 16 11.567 16 13.5V25"
        stroke="#087F5B"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path
        d="M16 25V13.5C16 11.567 17.567 10 19.5 10H20.5C22.433 10 24 11.567 24 13.5V25"
        stroke="#FFFFFF"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="27" cy="9" r="3.5" fill="#C5F47A" />
      <circle cx="27" cy="9" r="1.5" fill="#082E26" />
    </svg>
  )
}

export function Wordmark({
  className,
  markSize = 28,
  inverted = false,
}: {
  className?: string
  markSize?: number
  inverted?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2.5 font-extrabold tracking-tight select-none',
        inverted ? 'text-white' : 'text-foreground',
        className
      )}
    >
      <MovyBrandMark size={markSize} />
      <span className="flex items-center gap-1 tracking-tight font-black">
        <span>MOVY</span>
        <span className="size-1.5 rounded-full bg-[#C5F47A]" />
      </span>
    </span>
  )
}

export function WordmarkLink({ inverted = false }: { inverted?: boolean }) {
  return (
    <Link
      href="/home"
      className="inline-flex h-11 items-center gap-2 rounded-full pr-2 transition-transform active:scale-95"
    >
      <Wordmark className="text-xl" inverted={inverted} />
    </Link>
  )
}
