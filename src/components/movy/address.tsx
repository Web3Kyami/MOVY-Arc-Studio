'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Address display.
 *
 * `PAGE-SPECS.md`: at 320px a long address must truncate with a copy action, and
 * the full value stays available in the detail sheet. So the visible text is
 * always shortened, `title` carries the full value for pointer users, and the
 * copy button has an accessible name that includes the address.
 */
export function AddressChip({
  address,
  label,
  copyable = true,
  className,
}: {
  address: string
  label?: string
  copyable?: boolean
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* Clipboard can be denied; the value is still on screen and in the title. */
    }
  }

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      {label ? <span className="shrink-0 text-muted-foreground">{label}</span> : null}
      <span className="address-truncate font-mono text-xs" title={address}>
        {short}
      </span>
      {copyable ? (
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy address ${address}`}
          // 44px, not the visually-tighter 28px: this is a touch target on a
          // payment screen, and the accessibility audit measures the box.
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-[length:var(--radius-control)] text-muted-foreground transition-colors hover:bg-accent-soft hover:text-accent"
        >
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        </button>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Address copied' : ''}
      </span>
    </span>
  )
}

/** Full address on its own line, for the detail sheet. */
export function AddressFull({ address }: { address: string }) {
  return (
    <span className="money-wrap block font-mono text-xs leading-relaxed break-all">{address}</span>
  )
}
