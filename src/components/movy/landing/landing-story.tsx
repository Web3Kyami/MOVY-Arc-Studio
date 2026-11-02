import { RoundupExample } from '@/components/movy/landing/roundup-example'
import { MovingRoundupFeed } from '@/components/movy/landing/moving-roundup-feed'
import { ProductReveal } from '@/components/movy/landing/product-reveal'
import { GoalStory } from '@/components/movy/landing/goal-story'
import { LandingClosure } from '@/components/movy/landing/landing-closure'

export function LandingStory({ onStartSaving }: { onStartSaving: () => void }) {
  return (
    <>
      <MovingRoundupFeed />

      <RoundupExample />

      <ProductReveal />

      <GoalStory />

      <LandingClosure onStartSaving={onStartSaving} />
    </>
  )
}
