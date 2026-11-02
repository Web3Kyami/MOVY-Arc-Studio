'use client'

import Image from 'next/image'
import { useRef } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ArrowLeft, ArrowRight, ArrowUpRight } from 'lucide-react'
import { CRYPTO_SCENARIOS } from './crypto-scenarios'
import { formatCents } from './roundup-data'
import styles from './scenario-stack.module.css'

gsap.registerPlugin(useGSAP, ScrollTrigger)

// Export retained so the later draft sections remain byte-for-byte untouched.
export function RoundupExample() {
  const root = useRef<HTMLElement>(null)
  const track = useRef<HTMLOListElement>(null)
  useGSAP(() => {
    const element = root.current!
    const media = gsap.matchMedia()
    media.add({ desktop: '(min-width: 900px)', mobile: '(max-width: 899px)', reduce: '(prefers-reduced-motion: reduce)' }, context => {
      if (context.conditions?.reduce) return
      if (context.conditions?.mobile) {
        element.dataset.mobile = 'snap'
        return () => { delete element.dataset.mobile }
      }
      element.dataset.enhanced = 'desktop'
      const cards = gsap.utils.toArray<HTMLElement>('[data-scenario]', element)
      // Card 1 is the only visible card on arrival. Later cards stay hidden
      // until their own scroll segment, then sweep in from alternating edges.
      const entrance = (card: HTMLElement, index: number) => {
        const stageLeft = track.current!.getBoundingClientRect().left
        const left = stageLeft + card.offsetLeft
        if (!index) return Math.max(0, Math.min(48, window.innerWidth - left - card.offsetWidth - 16))
        return index % 2 ? window.innerWidth - left + 48 : -left - card.offsetWidth - 48
      }
      cards.forEach((card, index) => gsap.set(card, {
        x: entrance(card, index), y: index ? 14 : 0, scale: index ? 0.985 : 1,
        rotation: 0, rotationY: 0, transformOrigin: index % 2 ? 'right center' : 'left center',
        opacity: index ? 0 : 1, xPercent: 0, zIndex: index + 1,
      }))
      const timeline = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: {
        id: 'movy-scenarios', trigger: element, start: 'top top', end: () => `+=${window.innerHeight * 2.15}`,
        pin: true, scrub: true, invalidateOnRefresh: true,
      } })
      for (let index = 0; index < cards.length; index++) {
        const time = index ? 0.38 + (index - 1) * 1.02 : 0
        const duration = index ? 0.78 : 0.18
        if (index) timeline.set(cards[index], { opacity: 1 }, time)
        const flap = index ? (index % 2 ? 3 : -3) : 0
        timeline.fromTo(cards[index], { x: () => entrance(cards[index], index), y: index ? 14 : 0, scale: index ? 0.985 : 1, rotation: flap }, { x: 0, y: 0, scale: 1, rotation: 0, duration, immediateRender: false, ease: 'power1.out' }, time)
        timeline.fromTo(cards[index].querySelector('img'), { scale: 1.035, x: index % 2 ? -8 : 8 }, { scale: 1, x: 0, duration, immediateRender: false }, time)
        for (let previous = 0; previous < index; previous++) {
          const depth = index - previous
          timeline.to(cards[previous], { x: -20 * depth, y: -9 * depth, scale: 1 - 0.012 * depth, duration, ease: 'power1.out' }, time)
          timeline.to(cards[previous].querySelector('[data-image-shade]'), { opacity: Math.min(0.22, 0.08 * depth), duration }, time)
        }
        timeline.addLabel(CRYPTO_SCENARIOS[index].id, time + duration)
      }
      timeline.to({}, { duration: 0.36 })
      element.dataset.stackReady = 'true'
      return () => { delete element.dataset.enhanced; delete element.dataset.stackReady }
    })
    return () => media.revert()
  }, { scope: root })

  const move = (direction: number) => {
    const list = track.current!
    const pitch = list.children[0].getBoundingClientRect().width + 16
    list.scrollBy({ left: pitch * direction, behavior: 'smooth' })
  }
  const reveal = (index: number) => {
    const trigger = ScrollTrigger.getById('movy-scenarios')
    if (trigger && root.current?.dataset.enhanced) {
      const timeline = trigger.animation as gsap.core.Timeline
      const progress = timeline.labels[CRYPTO_SCENARIOS[index].id] / timeline.duration()
      window.scrollTo({ top: trigger.start + Math.min(1, progress) * (trigger.end - trigger.start), behavior: 'instant' })
    }
  }

  return <section ref={root} className={styles.section} aria-labelledby="roundup-example-title" data-section="03">
    <header className={styles.heading}>
      <h2 id="roundup-example-title">Different spends.<span>Same little move.</span></h2>
      <p>A few crypto payment examples.</p>
    </header>
    <ol ref={track} className={styles.stage} aria-label="Crypto payment examples" onKeyDown={event => {
      if (!root.current?.dataset.enhanced && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1)
      }
    }}>
      {CRYPTO_SCENARIOS.map((scenario, index) => <li key={scenario.id} className={styles.card} data-scenario={scenario.id} tabIndex={0} aria-labelledby={`scenario-${scenario.id}`} onFocus={() => reveal(index)}>
        <div className={styles.photo}><Image src={scenario.image} width={1200} height={800} sizes="(max-width: 899px) 85vw, 600px" alt={scenario.alt} /><span className={styles.imageShade} data-image-shade aria-hidden="true" /></div>
        <div className={styles.content}>
          <p className={styles.category}>{scenario.category}</p>
          <h3 id={`scenario-${scenario.id}`}>{scenario.name}</h3>
          <dl className={styles.amounts}>
            <div><dt>Purchase</dt><dd>{formatCents(scenario.cents)}</dd></div>
            <div><dt>Rounding basis</dt><dd>{formatCents(scenario.basis)}</dd></div>
          </dl>
          <div className={styles.saved}><div><span>Potential round-up</span><strong>+{formatCents(scenario.saved)}</strong></div><ArrowUpRight size={44} strokeWidth={1.5} aria-hidden="true" /></div>
        </div>
      </li>)}
    </ol>
    <div className={styles.controls}>
      <button type="button" aria-label="Previous scenario" onClick={() => move(-1)}><ArrowLeft size={20} aria-hidden="true" /></button>
      <button type="button" aria-label="Next scenario" onClick={() => move(1)}><ArrowRight size={20} aria-hidden="true" /></button>
    </div>
  </section>
}
