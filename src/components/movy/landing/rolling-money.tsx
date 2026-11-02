'use client'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { formatCents } from './roundup-data'
import styles from './roundup-sections.module.css'

/** Motion owns these digits only; GSAP never targets this subtree. */
export function RollingMoney({ cents, plus = false }: { cents: number; plus?: boolean }) {
  const reduce = useReducedMotion()
  const text = `${plus ? '+' : ''}${formatCents(cents)}`
  return <span className={styles.rollingMoney}>
    <span className={styles.srOnly}>{text}</span>
    <span aria-hidden="true" className={styles.digits}>{[...text].map((digit, index) =>
      <span className={styles.digitWindow} key={index} style={{ width: digit === '.' ? '0.25em' : '0.62em', height: '1.2em', position: 'relative' }}><AnimatePresence initial={false}><motion.span key={digit}
        initial={reduce || !/\d/.test(digit) ? false : { y: '100%' }} animate={{ y: 0 }} exit={reduce ? { y: 0 } : { y: '-100%' }} style={{ display: 'inline-block', position: 'absolute', left: 0, top: 0 }}
        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 30 }}>
        {digit}
      </motion.span></AnimatePresence></span>)}</span>
  </span>
}
