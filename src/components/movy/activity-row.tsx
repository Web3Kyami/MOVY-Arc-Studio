'use client'

import { Card } from '@/components/ui/card'
import { formatCents } from '@/lib/money'
import { cn } from '@/lib/utils'
import { ItemMark } from './marks'

/**
 * One activity row.
 *
 * Adapted from FinKit UI `src/components/fintech/TransactionRow.tsx`
 * (commit e52bbc981ac8f78264aa41ae52b6a195b705cd40, MIT, (c) 2024 Fintech-Kit).
 * The two-column icon+info / amount layout is kept. Changes:
 *
 *  - TWO money values are shown, because that is the whole product: the purchase
 *    the merchant received, and the roundup that became savings. The donor's
 *    single signed `amount` cannot express this.
 *  - The donor coloured the amount green when `value >= 0`. A purchase is an
 *    outflow, not a signed ledger delta, so no colour implies gain or loss; the
 *    roundup gets the accent treatment instead.
 *  - The donor's `isSubscription` "Sub" chip is dropped; there are no
 *    subscriptions in the MVP.
 *  - The root is a `<button>` so the row is reachable and activatable by keyboard,
 *    which the donor's `motion.div` with `onClick` was not.
 *  - No fixed widths and no `min-w-[600px]`, which is why the upstream
 *    `dashboard/recent-transactions.tsx` table was rejected in the first place.
 *  - Status appears only when it is pending or failed, per the audit: a cleared
 *    row needs no badge.
 */
export function ActivityRow({
  label,
  purchaseCents,
  roundupCents,
  status,
  timeLabel,
  mark,
  onSelect,
  className,
}: {
  label: string
  purchaseCents: bigint
  roundupCents: bigint
  status: 'confirmed' | 'pending' | 'failed'
  timeLabel: string
  mark?: 'coffee' | 'sticker' | 'cookie'
  onSelect?: () => void
  className?: string
}) {
  return (
    <Card className={cn('border-border bg-surface', className)}>
      <button
        type="button"
        onClick={onSelect}
        disabled={!onSelect}
        aria-label={`${label}, paid ${formatCents(purchaseCents)}, saved ${formatCents(roundupCents)}. Open details.`}
        className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
      >
        {mark ? <ItemMark mark={mark} className="size-10 shrink-0" /> : null}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{label}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="money text-xs text-muted-foreground">{timeLabel}</span>
            {status === 'pending' ? <StatusPill tone="pending">Pending</StatusPill> : null}
            {status === 'failed' ? <StatusPill tone="failed">Failed</StatusPill> : null}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="money block text-sm font-semibold">{formatCents(purchaseCents)}</span>
          <span className="money block text-xs font-semibold text-accent">
            {roundupCents === 0n ? (
              <span className="font-normal text-muted-foreground">no roundup</span>
            ) : (
              `+${formatCents(roundupCents)} saved`
            )}
          </span>
        </span>
      </button>
    </Card>
  )
}

function StatusPill({ tone, children }: { tone: 'pending' | 'failed'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-semibold',
        tone === 'pending' ? 'bg-muted text-muted-foreground' : 'bg-error-soft text-error',
      )}
    >
      {children}
    </span>
  )
}
