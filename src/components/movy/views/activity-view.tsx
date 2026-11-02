'use client'

import React, { useState, useRef } from 'react'
import Link from 'next/link'
import { useMovyModeData, type MovyModeData } from '@/hooks/use-movy-mode-data'
import { ACTIVE_NETWORK, txUrl } from '@/lib/chain'
import type { DemoActivityItem } from '@/context/demo-mode-context'
import { activityAmountLabel } from '@/lib/financial-presentation'
import { useDialogFocus } from '@/hooks/use-dialog-focus'
import { ConsumerActivityRow } from '../consumer-finance'
import {
  Coffee,
  ShoppingBag,
  Car,
  Utensils,
  Sparkles,
  ArrowUpRight,
  Plus,
  ExternalLink,
  X,
  Receipt,
  CheckCircle2,
  Clock,
  AlertCircle,
} from 'lucide-react'

function isTransactionHash(value: string | undefined): value is `0x${string}` {
  return !!value && /^0x[0-9a-fA-F]{64}$/.test(value)
}

// Contextual category styles mapped to DESIGN.md Section 2.B
function getCategoryVisual(category: string) {
  switch (category) {
    case 'coffee':
    case 'dining':
      return {
        bg: 'bg-rose-50 dark:bg-rose-950/30',
        text: 'text-rose-600 dark:text-rose-400',
        icon: category === 'coffee' ? Coffee : Utensils,
        label: category === 'coffee' ? 'Coffee' : 'Dining',
      }
    case 'grocery':
      return {
        bg: 'bg-amber-50 dark:bg-amber-950/30',
        text: 'text-amber-700 dark:text-amber-400',
        icon: ShoppingBag,
        label: 'Groceries',
      }
    case 'transport':
      return {
        bg: 'bg-blue-50 dark:bg-blue-950/30',
        text: 'text-blue-600 dark:text-blue-400',
        icon: Car,
        label: 'Transport',
      }
    case 'tech':
      return {
        bg: 'bg-orange-50 dark:bg-orange-950/30',
        text: 'text-orange-600 dark:text-orange-400',
        icon: Sparkles,
        label: 'Shopping',
      }
    case 'withdrawal':
      return {
        bg: 'bg-stone-100 dark:bg-stone-800',
        text: 'text-stone-600 dark:text-stone-400',
        icon: ArrowUpRight,
        label: 'Transfer',
      }
    case 'payment':
      return {
        bg: 'bg-stone-100 dark:bg-stone-800',
        text: 'text-stone-600 dark:text-stone-300',
        icon: Receipt,
        label: 'USDC Payment',
      }
    case 'deposit':
    default:
      return {
        bg: 'bg-emerald-50 dark:bg-emerald-950/30',
        text: 'text-emerald-600 dark:text-emerald-400',
        icon: Plus,
        label: 'Savings',
      }
  }
}

export function ActivityView() {
  const data = useMovyModeData()
  return (
    <ActivityScreen
      key={data.isDemoMode ? 'demo' : (data.account.address?.toLowerCase() ?? 'disconnected')}
      data={data}
    />
  )
}

function ActivityScreen({ data }: { data: MovyModeData }) {
  const { isDemoMode, account, activities: activitiesData } = data
  const [filterType, setFilterType] = useState<'all' | 'roundup' | 'other'>('all')
  const [selectedItem, setSelectedItem] = useState<DemoActivityItem | null>(null)
  const receiptDialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(Boolean(selectedItem), receiptDialogRef, () => setSelectedItem(null))
  const maskedAccount = account.maskedAccount
  const filters = [
    { id: 'all', label: 'All' },
    { id: 'roundup', label: 'Savings' },
    { id: 'other', label: 'Other' },
  ] as const
  const filteredItems = activitiesData.items.filter(
    (item) =>
      filterType === 'all' ||
      (filterType === 'roundup' ? item.type === 'roundup' : item.type !== 'roundup'),
  )
  const isEmptyFilter = filterType !== 'all' && activitiesData.items.length > 0
  return (
    <div className="consumer-page activity-page">
      <h1>Activity</h1>
      <div role="tablist" aria-label="Activity filters" className="activity-filters">
        {filters.map((filter, index) => (
          <button
            type="button"
            key={filter.id}
            id={`activity-tab-${filter.id}`}
            role="tab"
            aria-selected={filterType === filter.id}
            aria-controls="activity-ledger"
            tabIndex={filterType === filter.id ? 0 : -1}
            onClick={() => setFilterType(filter.id)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % filters.length
                  : event.key === 'ArrowLeft'
                    ? (index + filters.length - 1) % filters.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? filters.length - 1
                        : null
              if (next !== null) {
                event.preventDefault()
                setFilterType(filters[next].id)
                document.getElementById(`activity-tab-${filters[next].id}`)?.focus()
              }
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <section id="activity-ledger" role="tabpanel" aria-labelledby={`activity-tab-${filterType}`}>
        {activitiesData.isLoading ? (
          <p role="status" className="consumer-empty">
            Loading activity…
          </p>
        ) : activitiesData.isError ? (
          <ActivityLoadError
            message={activitiesData.errorMessage || 'Activity could not be loaded.'}
            onRetry={activitiesData.refetch}
          />
        ) : !account.isConnected && !isDemoMode ? (
          <div className="consumer-status"><Link href="/onboarding">Connect wallet</Link></div>
        ) : account.isWrongNetwork && !isDemoMode ? (
          <div role="alert" className="consumer-status"><Link href="/settings">Switch network</Link></div>
        ) : filteredItems.length ? (
          <div className="consumer-activity-list">
            {filteredItems.map((item) => (
              <ConsumerActivityRow
                key={item.id}
                item={item}
                exampleOnly={isDemoMode}
                onSelect={() => setSelectedItem(item)}
              />
            ))}
          </div>
        ) : (
          <div className="consumer-empty">
            <h2>
              {isEmptyFilter
                ? filterType === 'roundup'
                  ? 'No savings activity yet'
                  : 'No other activity yet'
                : 'No activity yet'}
            </h2>
          </div>
        )}
      </section>
      {selectedItem && (
        <div className="consumer-overlay activity-receipt-overlay">
          {/* Backdrop Overlay (closes drawer/sheet on click) */}
          <div
            onClick={() => setSelectedItem(null)}
            className="fixed inset-0 bg-black/40 backdrop-blur-2xs animate-in fade-in duration-200"
            aria-hidden="true"
          />

          {/* Container:
              On Mobile: Bottom Sheet sliding up from bottom (rounded-t-3xl)
              On Desktop: Right-Side Drawer sliding in from right (w-[400px], h-full, border-l)
          */}
          <div
            ref={receiptDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-title"
            tabIndex={-1}
            className="consumer-dialog activity-receipt"
            style={{ paddingBottom: 'calc(1.5rem + var(--nav-safe-bottom))' }}
          >
            {/* Mobile Sheet Drag Handle */}
            <div className="md:hidden mx-auto h-1 w-10 rounded-full bg-border/80 mb-2 shrink-0" />

            <div className="space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between pb-3 border-b border-border/60">
                <div className="flex items-center gap-2">
                  <Receipt className="size-4 text-primary" />
                  <h2 id="receipt-title" className="text-sm font-extrabold text-foreground">
                    {isDemoMode ? 'Demo receipt' : 'Transaction Receipt'}
                  </h2>
                </div>
                <button
                  type="button"
                  data-dialog-autofocus
                  onClick={() => setSelectedItem(null)}
                  aria-label="Close transaction details"
                  className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  <X className="size-4" />
                </button>
              </div>

              {/* Hero Saved Amount */}
              <div className="text-center py-1 space-y-1">
                <div
                  className={`mx-auto flex size-12 items-center justify-center rounded-2xl shadow-xs ${
                    getCategoryVisual(selectedItem.category).bg
                  } ${getCategoryVisual(selectedItem.category).text}`}
                >
                  {React.createElement(getCategoryVisual(selectedItem.category).icon, {
                    className: 'size-6',
                  })}
                </div>
                <p className="text-xs font-semibold text-muted-foreground pt-1">
                  {selectedItem.merchant}
                </p>
                {isDemoMode ? (
                  <p className="text-xs font-medium text-muted-foreground">Example round-up</p>
                ) : selectedItem.status === 'pending' ||
                selectedItem.status === 'failed' ||
                selectedItem.status === 'skipped' ? (
                  <p className="text-xl font-extrabold text-foreground tracking-tight">
                    {selectedItem.status === 'pending'
                      ? 'Round-up pending'
                      : selectedItem.status === 'failed'
                        ? 'Round-up failed'
                        : 'Round-up skipped'}
                  </p>
                ) : (
                  <p className="text-3xl font-extrabold text-foreground money tracking-tight">
                    {activityAmountLabel(selectedItem)}
                  </p>
                )}
                {isDemoMode ? (
                  <div className="inline-flex items-center rounded-full bg-surface-subtle px-3 py-1 text-xs font-semibold text-muted-foreground">
                    <span>Example only — no money moved.</span>
                  </div>
                ) : selectedItem.status === 'failed' ? (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 dark:bg-rose-950/40 px-3 py-1 text-xs font-bold text-rose-600 dark:text-rose-400">
                    <AlertCircle className="size-3.5" />
                    <span>Round-up transfer failed</span>
                  </div>
                ) : selectedItem.status === 'pending' ? (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 dark:bg-amber-950/40 px-3 py-1 text-xs font-bold text-amber-600 dark:text-amber-400">
                    <Clock className="size-3.5" />
                    <span>Round-up pending confirmation</span>
                  </div>
                ) : selectedItem.status === 'skipped' ? (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 dark:bg-stone-800 px-3 py-1 text-xs font-bold text-stone-600 dark:text-stone-400">
                    <Clock className="size-3.5" />
                    <span>{selectedItem.skipReason || 'Roundup Skipped'}</span>
                  </div>
                ) : selectedItem.type === 'withdrawal' ? (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 dark:bg-stone-800 px-3 py-1 text-xs font-bold text-stone-600 dark:text-stone-400">
                    <ArrowUpRight className="size-3.5" />
                    <span>Withdrawn to Wallet</span>
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-xs font-bold text-accent">
                    <CheckCircle2 className="size-3.5" />
                    <span>
                      {selectedItem.savedAmount > 0
                        ? `Saved to ${maskedAccount}`
                        : 'No round-up transferred'}
                    </span>
                  </div>
                )}
              </div>

              {/* Payment Breakdown Card (Clean consumer information) */}
              <div className="rounded-2xl border border-border/80 bg-surface-subtle/50 p-4 space-y-3 text-xs">
                {selectedItem.type === 'roundup' && (
                  <>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">
                        {isDemoMode ? 'Original Purchase' : 'Payment Amount'}
                      </span>
                      <span className="font-bold money text-foreground">
                        {selectedItem.originalAmountText ??
                          `$${selectedItem.originalAmount.toFixed(2)}`}{' '}
                        USDC
                      </span>
                    </div>

                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Rounded to Nearest Dollar</span>
                      <span className="font-bold money text-foreground">
                        {selectedItem.roundedAmountText ??
                          `$${selectedItem.roundedAmount.toFixed(2)}`}{' '}
                        USDC
                      </span>
                    </div>

                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">
                        {isDemoMode
                          ? 'Example round-up'
                          : selectedItem.status === 'pending'
                          ? 'Potential round-up'
                          : selectedItem.status === 'failed' || selectedItem.status === 'skipped'
                            ? 'Round-up not transferred'
                            : 'Spare change transferred'}
                      </span>
                      <span className="font-extrabold money text-accent">
                        {selectedItem.status === 'pending' ||
                        selectedItem.status === 'failed' ||
                        selectedItem.status === 'skipped'
                          ? selectedItem.status[0].toUpperCase() + selectedItem.status.slice(1)
                          : `${activityAmountLabel(selectedItem)}${selectedItem.savedAmount > 0 ? ' USDC' : ''}`}
                      </span>
                    </div>

                    {selectedItem.skipReason && (
                      <div className="flex justify-between items-center text-muted-foreground pt-1 border-t border-border/40">
                        <span>Automation Notice</span>
                        <span className="font-medium text-foreground text-right">
                          {selectedItem.skipReason}
                        </span>
                      </div>
                    )}
                  </>
                )}

                {selectedItem.type === 'withdrawal' && (
                  <>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Withdrawal Amount</span>
                      <span className="font-bold money text-foreground">
                        {selectedItem.savedAmountText ??
                          `-$${Math.abs(selectedItem.savedAmount).toFixed(2)}`}{' '}
                        USDC
                      </span>
                    </div>

                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Destination Wallet</span>
                      <span className="font-bold text-foreground">
                        {account.displayAddress || 'Connected Account'}
                      </span>
                    </div>
                  </>
                )}

                <div className="border-t border-border/60 pt-2 flex justify-between items-center">
                  <span className="text-muted-foreground">Date & Time</span>
                  <span className="font-medium text-foreground text-right">
                    {selectedItem.timestamp}
                  </span>
                </div>

                {!isDemoMode && <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Status</span>
                  {selectedItem.status === 'failed' ? (
                    <span className="font-bold text-rose-600 dark:text-rose-400 flex items-center gap-1">
                      <AlertCircle className="size-3" />
                      <span>Failed</span>
                    </span>
                  ) : selectedItem.status === 'pending' ? (
                    <span className="font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <Clock className="size-3" />
                      <span>Pending</span>
                    </span>
                  ) : selectedItem.status === 'skipped' ? (
                    <span className="font-bold text-stone-600 dark:text-stone-400 flex items-center gap-1">
                      <Clock className="size-3" />
                      <span>Skipped</span>
                    </span>
                  ) : (
                    <span className="font-bold text-accent flex items-center gap-1">
                      <CheckCircle2 className="size-3" />
                      <span>Completed</span>
                    </span>
                  )}
                </div>}

                {!isDemoMode && <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Network Fee</span>
                  <span className="font-bold text-foreground text-right">{selectedItem.feeText ?? 'Network fee not recorded'}</span>
                </div>}
              </div>

              {/* Secondary Verification (Clean, no raw hex strings) */}
              <div className="pt-0.5 space-y-1.5">
                {!isDemoMode && (
                  isTransactionHash(selectedItem.paymentTxHash) && (
                    <div>
                      <a
                        href={txUrl(ACTIVE_NETWORK, selectedItem.paymentTxHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:underline"
                      >
                        <span>
                          {selectedItem.type === 'withdrawal'
                            ? 'View withdrawal transaction'
                            : 'View payment transaction'}
                        </span>
                        <ExternalLink className="size-3.5" />
                      </a>
                    </div>
                  )
                )}
                {!isDemoMode &&
                  isTransactionHash(selectedItem.relayerTxHash) &&
                  selectedItem.relayerTxHash !== selectedItem.paymentTxHash && (
                    <div>
                      <a
                        href={txUrl(ACTIVE_NETWORK, selectedItem.relayerTxHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-accent hover:underline"
                      >
                        <span>View automated round-up transaction</span>
                        <ExternalLink className="size-3.5" />
                      </a>
                    </div>
                  )}
                {!isDemoMode &&
                  !selectedItem.paymentTxHash &&
                  isTransactionHash(selectedItem.txHash) && (
                    <div>
                      <a
                        href={txUrl(ACTIVE_NETWORK, selectedItem.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:underline"
                      >
                        <span>View transaction details</span>
                        <ExternalLink className="size-3.5" />
                      </a>
                    </div>
                  )}
              </div>
            </div>

            {/* Bottom Dismiss */}
            <div className="pt-4 mt-auto">
              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                className="w-full min-h-11 rounded-2xl bg-surface-subtle hover:bg-muted text-xs font-bold text-foreground active:scale-[0.98] transition-all"
              >
                Close Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function ActivityLoadError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void | Promise<unknown>
}) {
  return (
    <div role="alert" className="consumer-status">
      <h2>Unable to load activity</h2>
      <p>{message}</p>
      <button type="button" className="min-h-11" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}
