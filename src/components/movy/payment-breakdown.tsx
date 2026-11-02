'use client'

import { Card, CardContent } from '@/components/ui/card'
import { AddressChip } from './address'
import { formatCents, formatFee, type PaymentBreakdown } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * The arithmetic a user approves before signing.
 *
 * New composition, not a donor component: the base repository's card and
 * separator primitives, wired to the contract's own numbers. Both the review
 * sheet and the post-confirmation receipt render this same component, so the two
 * cannot drift apart.
 *
 * The network fee is deliberately a separate line and is explicitly labelled as
 * not part of the total, because `PAGE-SPECS.md` requires distinguishing fee paid
 * from purchase total.
 */
export function PaymentBreakdownView({
  quote,
  feeWei,
  feeLoading,
  recipient,
  recipientLabel = 'Paid to',
  showRecipient = true,
  className,
}: {
  quote: PaymentBreakdown
  feeWei: bigint | null
  feeLoading?: boolean
  recipient?: string
  recipientLabel?: string
  showRecipient?: boolean
  className?: string
}) {
  return (
    <Card className={cn('border-border bg-surface', className)}>
      <CardContent className="p-5">
        <dl className="space-y-3">
          <Line label="Purchase" value={formatCents(quote.purchaseCents)} />

          <Line
            label="Roundup saved"
            value={quote.roundupCents === 0n ? '$0.00' : `+${formatCents(quote.roundupCents)}`}
            tone="accent"
            note={quote.isExactDollar ? 'exact dollar' : undefined}
          />

          <div className="border-t-2 border-border pt-3">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-sm font-semibold">Total</dt>
              <dd className="money text-2xl font-bold">{formatCents(quote.totalCents)}</dd>
            </div>
          </div>

          <div className="border-t pt-3">
            <Line
              label="Network fee"
              value={
                feeLoading
                  ? 'Estimating…'
                  : feeWei === null
                    ? 'Estimating…'
                    : `${formatFee(feeWei)} USDC`
              }
              note="paid by your wallet, not part of the total"
              muted
            />
          </div>

          {showRecipient && recipient ? (
            <div className="flex items-baseline justify-between gap-4 border-t pt-3">
              <dt className="text-sm text-muted-foreground">{recipientLabel}</dt>
              <dd className="min-w-0">
                <AddressChip address={recipient} />
              </dd>
            </div>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  )
}

function Line({
  label,
  value,
  note,
  tone,
  muted,
}: {
  label: string
  value: string
  note?: string
  tone?: 'accent'
  muted?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={muted ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}>{label}</dt>
      <dd className="min-w-0 text-right">
        <span
          className={[
            'money money-wrap font-semibold',
            tone === 'accent' ? 'text-accent' : '',
            muted ? 'text-xs font-normal text-muted-foreground' : 'text-base',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {value}
        </span>
        {note ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  )
}
