'use client'

import Image from 'next/image'
import { useEffect, useRef } from 'react'
import styles from './goal-story.module.css'

export function GoalStory() {
  const sectionRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const section = sectionRef.current
    if (!section) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (reduceMotion.matches || !('IntersectionObserver' in window)) return

    const bounds = section.getBoundingClientRect()
    if (bounds.top < window.innerHeight * 0.9) return

    let observer: IntersectionObserver | undefined
    const revealImmediately = () => {
      section.dataset.reveal = 'visible'
      observer?.disconnect()
    }

    try {
      section.dataset.reveal = 'pending'
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) revealImmediately()
        },
        { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
      )
      observer.observe(section)
      reduceMotion.addEventListener('change', revealImmediately)
    } catch {
      section.dataset.reveal = 'visible'
    }

    return () => {
      observer?.disconnect()
      reduceMotion.removeEventListener('change', revealImmediately)
    }
  }, [])

  return (
    <section ref={sectionRef} className={styles.section} aria-labelledby="goal-story-title">
      <div className={styles.stage}>
        <Image
          className={styles.photo}
          src="/artwork/movy-goal-everyday-home.webp"
          alt="A parent gently helps their child adjust a backpack at home."
          fill
          sizes="(max-width: 700px) 100vw, 94vw"
          loading="lazy"
          draggable={false}
        />
        <div className={styles.overlay} aria-hidden="true" />
        <div className={styles.copy}>
          <h2 id="goal-story-title">For whatever comes next.</h2>
          <p>Make room for the plans and unexpected moments that matter to you.</p>
        </div>
      </div>
    </section>
  )
}
