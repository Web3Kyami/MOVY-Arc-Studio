import type { DemoActivityItem } from '@/context/demo-mode-context'
import { formatCents, parseCents } from '@/lib/money'

export type GoalProgressMode = 'simulated' | 'manual-plan'

/** Format a goal amount without rounding through a floating-point formatter. */
export function formatGoalAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return 'Amount unavailable'
  if (amount === 0) return formatCents(0n)
  const cents = parseCents(String(amount))
  return cents === null ? 'Amount unavailable' : formatCents(cents)
}

/** A manual connected target has no source-linked progress, so expose none. */
export function goalProgressPercent(
  mode: GoalProgressMode,
  current: number,
  target: number,
): number | null {
  if (mode !== 'simulated' || target <= 0) return null
  return Math.min(100, Math.max(0, Math.round((current / target) * 100)))
}

/** Display a saved amount only after confirmation; pending and failures are states. */
export function activityAmountLabel(item: DemoActivityItem): string {
  if (item.status === 'pending') return 'Pending'
  if (item.status === 'failed') return 'Failed'
  if (item.status === 'skipped') return 'Skipped'
  if (item.type === 'withdrawal') {
    return item.savedAmountText ?? `-$${Math.abs(item.savedAmount).toFixed(2)}`
  }
  if (item.savedAmount <= 0) return 'No round-up'
  return `+${item.savedAmountText ?? `$${item.savedAmount.toFixed(2)}`}`
}
