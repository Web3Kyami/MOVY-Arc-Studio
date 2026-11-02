'use client'

import { Link } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { formatCents, formatNative } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * Savings hero for the Home and Savings destinations.
 *
 * Adapted from FinKit UI `src/components/fintech/HeroBalanceCard.tsx`
 * (commit e52bbc981ac8f78264aa41ae52b6a195b705cd40, MIT, (c) 2024 Fintech-Kit).
 * The compound `Object.assign` slot structure is kept; everything else is MOVY:
 *
 *  - The donor's hardcoded "Total Balance" label became the prop `label`, so this
 *    reads "Saved with roundups" and never implies a spendable wallet balance.
 *  - The donor's `trend` chip, which coloured a +/- direction and pointed at a
 *    generic balance trend, became `weekLabel`/`weekValue` showing real roundup
 *    facts. There is no up/down arrow, because savings only go one way here.
 *  - The donor formatted money with `formatCurrency(number)`, which routes a
 *    float through `Intl`. This takes integer cents and native `bigint` only.
 *  - The donor's `bg-gradient-to-br` wash is removed; `DESIGN-SYSTEM.md` rules
 *    out excessive gradients.
 *  - The donor's unread `showVisibilityToggle` prop and its never-attached
 *    `BalanceCardChart` sub-component are dropped.
 */
export function SavingsHero({
  savingsCents,
  savedThisWeekCents,
  roundupCountThisWeek,
  onWithdraw,
  withdrawDisabled,
  className,
}: {
  savingsCents: bigint
  savedThisWeekCents: bigint
  roundupCountThisWeek: number
  onWithdraw?: () => void
  withdrawDisabled?: boolean
  className?: string
}) {
  const isEmpty = savingsCents === 0n

  return (
    <Card className={cn('border-border bg-surface', className)}>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">Saved with roundups</p>
          <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">
            Withdrawable
          </span>
        </div>

        <p
          className="money money-wrap text-[2.25rem] leading-none font-bold sm:text-[2.5rem]"
          aria-describedby="movy-savings-what"
        >
          {formatCents(savingsCents)}
        </p>
        <p id="movy-savings-what" className="text-sm text-muted-foreground">
          USDC you can withdraw any time. It is yours, not a bonus.
        </p>

        <dl className="grid grid-cols-2 gap-3 border-t pt-4">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">This week</dt>
            <dd className="money mt-0.5 text-lg font-semibold">
              {savedThisWeekCents === 0n ? (
                <span className="text-muted-foreground">{formatCents(0n)}</span>
              ) : (
                `+${formatCents(savedThisWeekCents)}`
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Roundups</dt>
            <dd className="money mt-0.5 text-lg font-semibold">
              {roundupCountThisWeek}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {roundupCountThisWeek === 1 ? 'purchase' : 'purchases'}
              </span>
            </dd>
          </div>
        </dl>

        {onWithdraw ? (
          <button
            type="button"
            onClick={onWithdraw}
            disabled={withdrawDisabled}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[length:var(--radius-control)] bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Link className="size-4" aria-hidden />
            {isEmpty ? 'Nothing to withdraw yet' : 'Withdraw savings'}
          </button>
        ) : null}
      </CardContent>
    </Card>
  )
}

/**
 * Small balance surface for the wallet strip. Kept separate from the hero so the
 * two numbers can never be confused: one is the spendable USDC balance, the other
 * is savings. Only the native balance is ever read, never the ERC-20 view.
 */
export function BalanceStrip({ nativeWei, className }: { nativeWei: bigint; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3', className)}>
      <span className="text-sm text-muted-foreground">USDC balance</span>
      <span className="money money-wrap text-sm font-semibold">{formatNative(nativeWei, 2)}</span>
    </div>
  )
}
