'use client'

import React, { useEffect, useState, useRef } from 'react'

interface SavingsNumberRevealProps {
  value: number
  isLoading?: boolean
  isError?: boolean
  className?: string
}

/**
 * Restrained financial numeral reveal for the primary savings balance.
 * - Begins only when the balance is confirmed and non-zero.
 * - Never turns loading or error into a temporary fake zero.
 * - Respects prefers-reduced-motion (instantly renders static value).
 * - Avoids rerunning on routine background re-renders or 3s polling via hasAnimatedRef.
 * - Tabular numbers with exact two-decimal precision.
 * - Accessible aria-label preserving screen reader truth.
 */
export function SavingsNumberReveal({
  value,
  isLoading = false,
  isError = false,
  className,
}: SavingsNumberRevealProps) {
  const [reveal, setReveal] = useState<{ target: number; current: number } | null>(null)
  const hasAnimatedRef = useRef<boolean>(false)

  useEffect(() => {
    if (isLoading || isError || value <= 0) {
      return
    }

    if (typeof window !== 'undefined') {
      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (prefersReduced || hasAnimatedRef.current) {
        const frameId = requestAnimationFrame(() => setReveal({ target: value, current: value }))
        return () => cancelAnimationFrame(frameId)
      }
    }

    hasAnimatedRef.current = true
    const duration = 380 // 380ms smooth ease-out
    const startTime = performance.now()
    const startValue = 0
    const endValue = value
    let frameId: number

    function update(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      // Ease out cubic
      const ease = 1 - Math.pow(1 - progress, 3)
      const current = startValue + (endValue - startValue) * ease
      setReveal({ target: endValue, current: progress === 1 ? endValue : current })

      if (progress < 1) {
        frameId = requestAnimationFrame(update)
      }
    }

    frameId = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frameId)
  }, [value, isLoading, isError])

  if (isLoading) {
    return (
      <span
        className={className}
        aria-label="Loading savings balance"
        role="status"
      >
        —
      </span>
    )
  }

  if (isError) {
    return (
      <span
        className={className}
        aria-label="Unable to load savings balance"
        role="status"
      >
        —
      </span>
    )
  }

  const visibleValue = value <= 0 ? value : reveal?.target === value ? reveal.current : value

  return (
    <span
      className={className}
      aria-label={`Total saved: $${value.toFixed(2)}`}
    >
      ${visibleValue.toFixed(2)}
    </span>
  )
}
