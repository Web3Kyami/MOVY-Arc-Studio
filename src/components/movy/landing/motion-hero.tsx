'use client'

import Image from 'next/image'
import { ArrowUpRight } from 'lucide-react'
import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import styles from './hero-style.module.css'

gsap.registerPlugin(useGSAP)
// Deliberately ordinary document flow. Payment choreography belongs to the feed.
export function MotionHero({ onStartSaving }: { onStartSaving: () => void }) {
  const root = useRef<HTMLElement>(null)
  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
    const brand = root.current?.closest('.landing-page')?.querySelector('[data-brand]')
    const timeline = gsap.timeline({ defaults: { duration: 0.65, ease: 'power3.out' } })
    if (brand) timeline.from(brand, { y: -6, opacity: 0.6 }, 0)
    timeline.from('h1', { y: 20, opacity: 0.35 }, 0.12)
      .from('[data-hero-visual]', { y: 18, scale: 0.975 }, 0.22)
      .from('[data-hero-deck]', { y: 10, opacity: 0.4 }, 0.36)
      .from('[data-hero-actions]', { y: 8, opacity: 0.4 }, 0.48)
    })
    return () => media.revert()
  }, { scope: root })
  return <section ref={root} className={styles.hero} aria-labelledby="landing-title" data-section="01">
    <div className={styles.composition}>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>Make room for what’s next.</p>
        <h1 id="landing-title">Small change.<span>Bigger moves.</span></h1>
        <p className={styles.deck} data-hero-deck>Save a little. Make room for more.</p>
        <div className={styles.actions} data-hero-actions>
          <button type="button" onClick={onStartSaving} className={styles.primary}>Start Saving <ArrowUpRight aria-hidden="true" size={19} /></button>
        </div>
      </div>
      <div className={styles.visual} aria-hidden="true" data-hero-visual>
        <div className={styles.plane} />
        <Image src="/artwork/movy_hero_sculpture.webp" width={1400} height={876} priority sizes="(max-width: 899px) 92vw, 52vw" alt="" className={styles.sculpture} />
      </div>
    </div>
  </section>
}
