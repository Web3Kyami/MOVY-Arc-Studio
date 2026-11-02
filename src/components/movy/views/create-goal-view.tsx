'use client'

import React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMovyModeData, type MovyModeData } from '@/hooks/use-movy-mode-data'
import { parseCents } from '@/lib/money'
import { GoalArtwork, type GoalArtworkType } from '../goal-artwork'
import { ArrowLeft, ImageIcon } from 'lucide-react'

const COVERS: { id: GoalArtworkType; label: string }[] = [
  { id: 'general', label: 'No cover' },
  { id: 'emergency', label: 'Safety' },
  { id: 'travel', label: 'Travel' },
  { id: 'tech', label: 'Tech' },
  { id: 'home', label: 'Home' },
]

export function CreateGoalView({ goalId }: { goalId?: string } = {}) {
  const data = useMovyModeData()
  return (
    <GoalEditor
      key={`${data.isDemoMode ? 'demo' : (data.account.address?.toLowerCase() ?? 'disconnected')}:${goalId ?? 'new'}`}
      data={data}
      goalId={goalId}
    />
  )
}

function GoalEditor({ data, goalId }: { data: MovyModeData; goalId?: string }) {
  const router = useRouter()
  const initialGoal = goalId ? data.goals.items.find((goal) => goal.id === goalId) : undefined
  const [name, setName] = React.useState(initialGoal?.title ?? '')
  const [target, setTarget] = React.useState(initialGoal ? initialGoal.target.toFixed(2) : '')
  const [cover, setCover] = React.useState<GoalArtworkType>(
    initialGoal && COVERS.some((item) => item.id === initialGoal.category)
      ? initialGoal.category as GoalArtworkType
      : 'general',
  )
  const [errors, setErrors] = React.useState<{ name?: string; target?: string; save?: string }>({})
  const [saving, setSaving] = React.useState(false)
  const submitted = React.useRef(false)
  const nameInput = React.useRef<HTMLInputElement>(null)
  const targetInput = React.useRef<HTMLInputElement>(null)
  if (goalId && !initialGoal) {
    return (
      <div className="consumer-page create-goal-page">
        <p role="alert" className="consumer-error">This goal is not available for the connected wallet.</p>
        <Link href="/savings">Back to Savings</Link>
      </div>
    )
  }
  function create(event: React.FormEvent) {
    event.preventDefault()
    if (submitted.current) return
    const next: typeof errors = {}
    const title = name.trim()
    const cents = parseCents(target)
    if (!title || title.length > 60) next.name = 'Enter a goal name of 1 to 60 characters.'
    else if (
      data.goals.items.some(
        (goal) => goal.id !== initialGoal?.id && goal.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase(),
      )
    )
      next.name = 'A goal with this name already exists. Choose another name.'
    if (cents === null)
      next.target =
        'Enter a positive USDC target up to 10,000 with no more than two decimal places.'
    if (!data.isDemoMode && !data.account.isConnected)
      next.save = 'Connect a wallet in Settings to save a goal for that profile.'
    setErrors(next)
    if (next.name || next.target || next.save) {
      if (next.name) nameInput.current?.focus()
      else if (next.target) targetInput.current?.focus()
      return
    }
    submitted.current = true
    setSaving(true)
    try {
      if (initialGoal) {
        data.goals.updateGoal(initialGoal.id, {
          title,
          target: Number(cents) / 100,
          icon: cover,
          category: cover,
        })
      } else {
        data.goals.addGoal({ title, target: Number(cents) / 100, icon: cover, category: cover })
      }
      router.push('/savings')
    } catch {
      submitted.current = false
      setSaving(false)
      setErrors({
        save: 'Your goal could not be saved in this browser. Free some storage or enable local storage, then try again.',
      })
    }
  }
  return (
    <form className="consumer-page create-goal-page" onSubmit={create} noValidate>
      <div className="editor-heading">
        <Link href="/savings" aria-label="Back to Savings">
          <ArrowLeft size={20} />
        </Link>
        <h1>{initialGoal ? 'Edit goal' : 'Create a goal'}</h1>
        <span />
      </div>
      <label className="editor-field" htmlFor="goal-name">
        Goal name
        <input
          ref={nameInput}
          id="goal-name"
          autoComplete="off"
          placeholder="e.g. Japan Adventure"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'goal-name-error' : undefined}
        />
      </label>
      {errors.name && (
        <p id="goal-name-error" role="alert" className="consumer-error">
          {errors.name}
        </p>
      )}
      <label className="editor-field" htmlFor="goal-target">
        Target amount (USDC)
        <input
          ref={targetInput}
          id="goal-target"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          aria-invalid={!!errors.target}
          aria-describedby={errors.target ? 'goal-target-error' : undefined}
        />
      </label>
      {errors.target && (
        <p id="goal-target-error" role="alert" className="consumer-error">
          {errors.target}
        </p>
      )}
      <fieldset className="goal-cover-field">
        <legend>
          Choose a cover <span>(optional)</span>
        </legend>
        <div className="goal-cover-options">
          {COVERS.map((item) => (
            <label key={item.id} className="goal-cover-option">
              <input
                type="radio"
                aria-label={item.label}
                name="goal-cover"
                value={item.id}
                checked={cover === item.id}
                onChange={() => setCover(item.id)}
              />
              <span className="goal-cover-art" aria-hidden="true">
                {item.id === 'general' ? <ImageIcon size={24} /> : <GoalArtwork type={item.id} />}
              </span>
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {!data.isDemoMode && (
        <p className="settings-note">
          Goals track progress; round-ups go to your savings wallet.
        </p>
      )}
      {errors.save && (
        <p role="alert" className="consumer-error">
          {errors.save}
        </p>
      )}
      <div className="editor-save">
        <button type="submit" className="consumer-primary" disabled={saving}>
          {saving ? 'Saving…' : initialGoal ? 'Save changes' : 'Create goal'}
        </button>
        <Link href="/savings">Cancel</Link>
      </div>
    </form>
  )
}
