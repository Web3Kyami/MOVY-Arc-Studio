'use client'

import type { DemoGoal, DemoActivityItem } from '@/context/demo-mode-context'
import type { MovyModeData } from '@/hooks/use-movy-mode-data'
import Link from 'next/link'
import { savingsFigureText } from '@/lib/savings-accounting'
import {
  activityAmountLabel,
  formatGoalAmount,
  goalProgressPercent,
} from '@/lib/financial-presentation'
import { GoalArtwork, inferGoalType, type GoalArtworkType } from './goal-artwork'
import { SavingsNumberReveal } from './savings-number-reveal'
import {
  Coffee,
  ShoppingBag,
  Car,
  Utensils,
  Receipt,
  ArrowUpRight,
  Plus,
  Laptop,
  Target,
} from 'lucide-react'

export function SavingsTotal({
  data,
  animated = false,
}: {
  data: MovyModeData
  animated?: boolean
}) {
  const { isDemoMode, savings } = data
  const read = savings.confirmedRoundups
  return (
    <div className="savings-total" aria-live="polite">
      <p>{isDemoMode ? 'Total savings' : 'Lifetime confirmed round-ups'}</p>
      <div className="total-amount">
        {isDemoMode && animated ? (
          <SavingsNumberReveal value={Number(savings.totalSavedFormatted.replace(/,/g, ''))} />
        ) : (
          <strong>
            {isDemoMode
              ? `$${savings.totalSavedFormatted}`
              : read.status === 'loading'
                ? 'Loading…'
                : read.status === 'error'
                  ? 'Unavailable'
                  : read.status === 'unavailable'
                    ? '—'
                    : savingsFigureText(read)}
          </strong>
        )}
        {(isDemoMode || read.status === 'ready' || read.status === 'simulated') && (
          <span>USDC</span>
        )}
      </div>
    </div>
  )
}

export function GoalSummary({
  goal,
  mode,
  editHref,
}: {
  goal: DemoGoal
  mode: MovyModeData['goals']['progressMode']
  editHref?: string
}) {
  const percent = goalProgressPercent(mode, goal.current, goal.target)
  const cover = ['emergency', 'travel', 'tech', 'home', 'general'].includes(goal.category ?? '')
    ? goal.category as GoalArtworkType
    : inferGoalType(goal.title, goal.category)
  return (
    <article className="goal-summary" aria-label={goal.title}>
      <div className="goal-thumbnail" aria-hidden="true" data-cover={cover}>
        {goal.category === 'general' ? <span className="goal-neutral"><Target /></span> : <GoalArtwork type={cover} />}
      </div>
      <div className="goal-summary-body">
        <div className="goal-title">
          <h3>{goal.title}</h3>
          {percent !== null && <span>{percent}%</span>}
        </div>
        <p className="goal-amounts">
          {percent === null
            ? `Manual target: ${formatGoalAmount(goal.target)}`
            : `${formatGoalAmount(goal.current)} / ${formatGoalAmount(goal.target)}`}
        </p>
        {percent !== null && (
          <div
            className="goal-progress"
            role="progressbar"
            aria-label={`${goal.title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      {editHref && (
        <Link className="goal-edit-action" href={editHref} aria-label={`Edit ${goal.title}`}>
          Edit
        </Link>
      )}
    </article>
  )
}

function categoryVisual(item: DemoActivityItem) {
  if (item.type === 'withdrawal') return { icon: ArrowUpRight, tone: 'neutral' }
  if (item.type === 'deposit') return { icon: Plus, tone: 'green' }
  switch (item.category) {
    case 'coffee':
      return { icon: Coffee, tone: 'rose' }
    case 'dining':
      return { icon: Utensils, tone: 'rose' }
    case 'grocery':
      return { icon: ShoppingBag, tone: 'amber' }
    case 'transport':
      return { icon: Car, tone: 'sky' }
    case 'tech':
      return { icon: Laptop, tone: 'amber' }
    default:
      return { icon: Receipt, tone: 'neutral' }
  }
}

export function ConsumerActivityRow({
  item,
  onSelect,
  compact = false,
  exampleOnly = false,
}: {
  item: DemoActivityItem
  onSelect?: () => void
  compact?: boolean
  exampleOnly?: boolean
}) {
  const { icon: Icon, tone } = categoryVisual(item)
  const content = (
    <>
      <span className={`activity-icon activity-${tone}`}>
        <Icon aria-hidden="true" />
      </span>
      <span className="activity-description">
        <strong>{item.merchant}</strong>
        {exampleOnly && <span className="activity-time">Example only</span>}
        {compact ? (
          <span className="activity-time">
            {item.type === 'roundup' &&
              `${item.originalAmountText ?? `$${item.originalAmount.toFixed(2)}`} · `}
            {item.timestamp}
          </span>
        ) : (
          <>
            <span className="activity-payment">
              {item.type === 'roundup'
                ? `${item.originalAmountText ?? `$${item.originalAmount.toFixed(2)}`} USDC payment`
                : item.type === 'withdrawal'
                  ? 'Withdrawal'
                  : 'Deposit'}
            </span>
            <span className="activity-time">
              {item.timestamp}
            </span>
          </>
        )}
      </span>
      <span
        className={`activity-saved${(item.status && item.status !== 'confirmed') || item.savedAmount <= 0 ? ' activity-unconfirmed' : ''}`}
      >
        {activityAmountLabel(item)}
      </span>
    </>
  )
  return onSelect ? (
    <button
      type="button"
      className="consumer-activity-row"
      onClick={onSelect}
      aria-label={`View receipt for ${item.merchant}`}
    >
      {content}
    </button>
  ) : (
    <div className="consumer-activity-row">{content}</div>
  )
}
