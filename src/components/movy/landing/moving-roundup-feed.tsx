'use client'

import Image from 'next/image'
import { useRef, useState } from 'react'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ROUNDUP_PAYMENTS, accumulatedCents, formatCents } from './roundup-data'
import styles from './roundup-sections.module.css'
import { RollingMoney } from './rolling-money'

gsap.registerPlugin(useGSAP, ScrollTrigger)

export function MovingRoundupFeed() {
  const root = useRef<HTMLElement>(null)
  const [stage, setStage] = useState(3)

  useGSAP(() => {
    const element = root.current!
    const media = gsap.matchMedia()
    media.add({ desktop: '(min-width: 900px)', mobile: '(max-width: 899px)', reduce: '(prefers-reduced-motion: reduce)' }, context => {
      if (context.conditions?.reduce) return
      const rows = gsap.utils.toArray<HTMLElement>('[data-payment]', element)
      const actors = gsap.utils.toArray<HTMLElement>('[data-feed-actor]', element)
      const list = element.querySelector('[data-feed-list]')!
      const destination = element.querySelector('[data-destination]')!
      const stageElement = element.querySelector('[data-feed-stage]')!
      if (context.conditions?.desktop) {
        element.dataset.enhanced = 'desktop'
        setStage(-1)
        gsap.set(actors, { opacity: 0 })
        const pitch = rows[1].offsetTop - rows[0].offsetTop
        let lastStage = -1
        const timeline = gsap.timeline({ onUpdate: function () {
          const next = Math.max(-1, Math.min(3, Math.floor((this.time() - 0.73) / 1.05)))
          if (next !== lastStage) { lastStage = next; setStage(next) }
        }, scrollTrigger: {
          id: 'movy-payment-feed', trigger: stageElement, start: 'top top', end: '+=1900',
          pin: true, scrub: 0.35, invalidateOnRefresh: true,
        } })
        rows.forEach((row, index) => {
          const time = index * 1.05
          if (index) timeline.to(list, { y: -index * pitch, duration: 0.65, ease: 'power2.inOut' }, time - 0.35)
          timeline.fromTo(actors[index], { x: 0, y: 0, scale: 0.65, opacity: 0 }, {
            x: () => destination.getBoundingClientRect().left + destination.clientWidth * 0.5 - actors[index].getBoundingClientRect().left,
            y: -65, scale: 0.9, opacity: 1, duration: 0.55, ease: 'power2.inOut',
          }, time + 0.18)
          timeline.to(actors[index], { opacity: 0, scale: 0.3, duration: 0.2 }, time + 0.73)
          timeline.to(destination, { scale: 1.018, duration: 0.12, yoyo: true, repeat: 1 }, time + 0.75)
        })
        timeline.to({}, { duration: 0.45 })
      } else {
        element.dataset.enhanced = 'mobile'
        setStage(0)
        rows.forEach((row, index) => {
          gsap.fromTo(row.querySelector('[data-mobile-actor]'), { x: 0, y: 0, opacity: 0 }, { x: () => row.clientWidth - 36, y: 0, opacity: 1,
            scrollTrigger: { trigger: row, start: 'top 78%', end: 'top 35%', scrub: true,
              onEnter: () => setStage(index), onEnterBack: () => setStage(index) }, ease: 'none' })
        })
      }
      return () => { delete element.dataset.enhanced; setStage(3) }
    })
    return () => media.revert()
  }, { scope: root })

  return <section ref={root} className={styles.feed} aria-labelledby="moving-feed-title" data-section="02">
    <div className={styles.feedStage} data-feed-stage>
      <header className={styles.feedHeading}>
        <h2 id="moving-feed-title">A little from eligible payments.</h2>
        <p>The payment stays the same.<br />The spare change moves toward savings.</p>
      </header>
      <div className={styles.feedComposition}>
        <div className={styles.ledger}>
          <div className={styles.ledgerCaption}><span>Original payment</span><span>Separate saving</span></div>
          <div className={styles.feedWindow}>
            <ol className={styles.feedList} data-feed-list>
              {ROUNDUP_PAYMENTS.map((payment, index) => <li key={payment.id} className={styles.payment} data-payment>
                <Image src={payment.image} width={432} height={432} sizes="(max-width: 899px) 84px, (max-width: 1100px) 100px, 144px" alt="" className={styles.merchantImage} />
                <div className={styles.paymentCopy}><small>{payment.moment}</small><h3>{payment.name}</h3>
                  <p><strong>{formatCents(payment.cents)}</strong> <span>USDC</span></p>
                  <small>Merchant receives {formatCents(payment.cents)}</small>
                </div>
                <div className={styles.difference}><strong>+{formatCents(payment.saved)}</strong><span>saved separately</span>
                  <small className={styles.rowTotal}>Together: {formatCents(accumulatedCents[index])}</small>
                </div>
                <span className={styles.mobileActor} data-mobile-actor aria-hidden="true" />
              </li>)}
            </ol>
          </div>
          <div className={styles.flightLayer} aria-hidden="true">
            {ROUNDUP_PAYMENTS.map(payment => <span key={payment.id} className={styles.feedActor} data-feed-actor />)}
          </div>
        </div>
        <aside className={styles.destination} data-destination aria-label="Illustrative accumulated savings">
          <div className={styles.destinationCopy}><p>Spare change moved</p>
            <strong data-feed-total><RollingMoney cents={accumulatedCents[stage] ?? 0} /><small>USDC</small></strong>
            <span>{stage + 1} of 4 example payments</span>
          </div>
          <div className={styles.accumulationVisual}>
            <svg viewBox="0 0 420 160" fill="none" aria-hidden="true"><path d="M72 132h276M100 109h220M130 86h160" stroke="#ffffff30" strokeWidth="2" strokeLinecap="round" /><circle cx="210" cy="61" r="27" fill="#c5f47a" /><path d="M210 72V49m-7 7 7-7 7 7" stroke="#082e26" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <div className={styles.destinationProgress} role="progressbar" aria-label="Example savings accumulation" aria-valuemin={0} aria-valuemax={240} aria-valuenow={accumulatedCents[stage] ?? 0} aria-valuetext={`${formatCents(accumulatedCents[stage] ?? 0)} of $2.40 in this example`}><i style={{ transform: `scaleX(${(accumulatedCents[stage] ?? 0) / 240})` }} /></div>
          </div>
          <p className={styles.destinationFoot}>Every small move adds up.</p>
        </aside>
      </div>
    </div>
  </section>
}
