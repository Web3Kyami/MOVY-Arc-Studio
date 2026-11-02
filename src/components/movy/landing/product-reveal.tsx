'use client'

import Image from 'next/image'
import { motion, useReducedMotion } from 'motion/react'
import styles from './product-reveal.module.css'

export function ProductReveal() {
  const reduceMotion = useReducedMotion()

  return (
    <section className={styles.section} aria-labelledby="product-reveal-title" data-section="04">
      <div className={styles.layout}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>
            <span className={styles.eyebrowMark} aria-hidden="true" />
            Inside MOVY
          </p>
          <h2 id="product-reveal-title" className={styles.heading}>
            Your savings, in clear view.
          </h2>
          <p className={styles.support}>
            Track goals and round-ups in one place. Eligible USDC payments from your connected
            spending wallet stay unchanged while spare change moves separately to a savings
            destination you control.
          </p>
        </div>

        <motion.figure
          className={styles.device}
          initial={reduceMotion ? false : { y: 30, scale: 0.985 }}
          whileInView={reduceMotion ? undefined : { y: 0, scale: 1 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ type: 'spring', stiffness: 78, damping: 18, mass: 0.8 }}
        >
          <div className={styles.frame}>
            <div className={styles.screen}>
              <picture className={styles.picture}>
                <source
                  media="(max-width: 359px)"
                  srcSet="/artwork/movy-home-preview-320.webp"
                  type="image/webp"
                />
                <Image
                  src="/artwork/movy-home-preview-390.webp"
                  alt="MOVY Home screen with example savings, goal progress and recent round-ups."
                  fill
                  sizes="(max-width: 359px) calc(100vw - 40px), (max-width: 959px) min(100vw - 24px, 428px), 428px"
                  className={styles.screenImage}
                  loading="lazy"
                  draggable={false}
                />
              </picture>
            </div>
          </div>
          <figcaption className={styles.caption}>
            <span>MOVY Home</span>
          </figcaption>
        </motion.figure>
      </div>
    </section>
  )
}
