'use client'

import { ExternalLink } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { AddressFull } from './address'
import { useIsMobile } from '@/hooks/use-mobile'
import { formatCents, formatFee, formatNative } from '@/lib/money'
import type { Purchase } from '@/lib/events'
import { txUrl, type ArcNetwork } from '@/lib/chain'

/**
 * Purchase detail.
 *
 * Layout adapted from FinKit UI
 * `src/components/fintech/TransactionDetailDrawer.tsx`
 * (commit e52bbc981ac8f78264aa41ae52b6a195b705cd40, MIT, (c) 2024 Fintech-Kit).
 * Its responsive geometry is the part worth keeping: a full-width bottom sheet
 * on mobile that becomes a right-hand drawer from the `md` breakpoint.
 *
 * Deliberate departures, each recorded in `references/UPSTREAM-MANIFEST.md`:
 *
 *  - The donor imports `@radix-ui/react-dialog` directly. This app's shadcn
 *    primitives are built on `@base-ui/react`, and `@base-ui/react` is not a
 *    dependency of the donor. Importing the file as-is would register a second
 *    dialog implementation with its own focus trap and portal. This uses the
 *    existing `Sheet` primitive instead, so there is one dialog system.
 *  - The donor's motion wrapper animates `x: '100%' -> 0` at every breakpoint, so
 *    the mobile "bottom sheet" slid in sideways. Here the sheet animates on the
 *    axis it is anchored to, and the motion is CSS so `prefers-reduced-motion` is
 *    honoured from `globals.css`.
 *  - The donor hardcoded `paymentMethod ?? 'Visa •••• 1234'`, a "Download PDF
 *    Receipt" button and a "Dispute Transaction" button. None of those may appear:
 *    MOVY has no card, no receipts to download and no disputes.
 *  - The donor's `StatusTimeline` rendered hardcoded clock times ("2:30 PM",
 *    "2:31 PM", "2:32 PM"). MOVY shows the real block timestamp, or an explicit
 *    pending state with a refresh, so a submitted transaction is never narrated
 *    as confirmed.
 */
export function ActivityDetail({
  purchase,
  network,
  open,
  onOpenChange,
  onRefresh,
}: {
  purchase: Purchase | null
  network: ArcNetwork
  open: boolean
  onOpenChange: (open: boolean) => void
  onRefresh?: () => void
}) {
  // Called before any early return: hooks must run in the same order every render.
  //
  // The base `Sheet` animates along the axis named by `side`, so the side has to
  // change with the viewport: a bottom sheet slides up on a phone, and a right
  // drawer slides in on a desktop. Overriding only the CSS position would leave
  // the desktop drawer animating vertically.
  const isMobile = useIsMobile()
  const side = isMobile ? 'bottom' : 'right'

  if (!purchase) return null

  const time = new Date(purchase.timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className="max-h-[88dvh] overflow-y-auto border-border bg-surface md:w-[26rem] md:max-w-[26rem] md:rounded-l-[length:var(--radius-card)] md:rounded-tr-none"
      >
        <SheetHeader className="px-5 pt-5 pb-0">
          <SheetDescription className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            Purchase detail
          </SheetDescription>
          <SheetTitle className="text-xl font-bold">{purchase.label}</SheetTitle>
          <div className="mt-2">
            {purchase.status === 'confirmed' ? (
              <span className="rounded-full bg-success-soft px-2.5 py-1 text-xs font-semibold text-success">
                Confirmed
              </span>
            ) : purchase.status === 'pending' ? (
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                Pending
              </span>
            ) : (
              <span className="rounded-full bg-error-soft px-2.5 py-1 text-xs font-semibold text-error">
                Failed
              </span>
            )}
          </div>
        </SheetHeader>

        <div className="space-y-6 px-5 py-5">
          {purchase.status === 'pending' ? (
            <div className="space-y-2 rounded-[length:var(--radius-control)] border border-dashed p-3">
              <p className="text-sm font-medium">Submitted, not yet confirmed</p>
              <p className="text-sm text-muted-foreground">
                It counts toward savings after confirmation.
              </p>
              {onRefresh ? (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="inline-flex min-h-9 items-center rounded-[length:var(--radius-control)] border px-3 text-sm font-medium transition-colors hover:bg-muted"
                >
                  Refresh status
                </button>
              ) : null}
            </div>
          ) : null}

          <dl className="space-y-3">
            <Row label="Purchase" value={formatCents(purchase.purchaseCents)} />
            <Row
              label="Roundup saved"
              value={purchase.roundupCents === 0n ? '$0.00' : `+${formatCents(purchase.roundupCents)}`}
              emphasis
            />
            <div className="border-t pt-3">
              <Row label="Total" value={formatCents(purchase.totalCents)} strong />
            </div>
            <Row
              label="Network fee"
              value={
                purchase.feeWei === null
                  ? 'Not shown'
                  : `${formatFee(purchase.feeWei)} USDC · separate from the total`
              }
              muted
            />
            <Row label="Savings destination" value="This wallet" />
            <Row label="When" value={time} />
          </dl>

          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
              Recipient
            </p>
            <AddressFull address={purchase.merchant} />
            <p className="text-xs text-muted-foreground">
              {purchase.merchant === purchase.payer
                ? 'Paid to your own address.'
                : 'Merchant received the purchase amount only.'}
            </p>
          </div>

          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
              Transaction
            </p>
            <AddressFull address={purchase.txHash} />
            <a
              href={txUrl(network, purchase.txHash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-[length:var(--radius-control)] border px-3 text-sm font-medium text-accent transition-colors hover:bg-accent-soft"
            >
              View receipt on explorer
              <ExternalLink className="size-3.5" aria-hidden />
              <span className="sr-only">
                for transaction {purchase.txHash}
              </span>
            </a>
            <p className="text-xs text-muted-foreground">
              Block {purchase.blockNumber.toString()} · {formatNative(purchase.purchaseWei + purchase.roundupWei, 6)} USDC
              moved in one transaction
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Row({
  label,
  value,
  strong,
  emphasis,
  muted,
}: {
  label: string
  value: string
  strong?: boolean
  emphasis?: boolean
  muted?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={muted ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}>{label}</dt>
      <dd
        className={[
          'money money-wrap text-right',
          strong ? 'text-lg font-bold' : 'text-sm font-semibold',
          emphasis ? 'text-accent' : '',
          muted ? 'text-xs font-normal text-muted-foreground' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {value}
      </dd>
    </div>
  )
}
