'use client'

import Link from 'next/link'
import { MotionHero } from '@/components/movy/landing/motion-hero'
import { LandingStory } from '@/components/movy/landing/landing-story'
import { Wordmark } from '@/components/movy/nav'
import heroStyles from '@/components/movy/landing/hero-style.module.css'

export function LandingView() {
  const handleStartSaving = () => window.location.assign('/onboarding')

  return (
    <div className={`landing-page ${heroStyles.shell}`}>
      <a className="landing-skip" href="#landing-main">Skip to main content</a>
      <header className="landing-nav">
        <Link href="/" aria-label="MOVY home" className="landing-brand" data-brand>
          <Wordmark markSize={31} className="text-[1.05rem]" />
        </Link>
        <nav aria-label="Primary navigation">
          <button type="button" onClick={handleStartSaving} className="landing-start-link">
            Start Saving
          </button>
        </nav>
      </header>

      <main id="landing-main" tabIndex={-1}>
        <MotionHero onStartSaving={handleStartSaving} />
        <LandingStory onStartSaving={handleStartSaving} />
      </main>
    </div>
  )
}
