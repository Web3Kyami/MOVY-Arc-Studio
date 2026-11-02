'use client'

import Link from 'next/link'
import { Wordmark } from '@/components/movy/nav'
import styles from './landing-closure.module.css'

const faqs = [
  {
    question: 'What payments work with MOVY?',
    answer:
      'MOVY currently works with eligible outgoing USDC payments from a wallet you connect. It does not detect bank or card spending.',
  },
  {
    question: 'Does MOVY change what I pay?',
    answer:
      'No. The merchant receives the amount you sent. If eligible, MOVY sends the round-up separately from your spending wallet to the savings destination you chose.',
  },
  {
    question: 'Where does my spare change go?',
    answer: 'It goes to the separate savings destination you choose during setup.',
  },
  {
    question: 'Can I set limits or pause saving?',
    answer:
      'Yes. You can pause or resume automatic saving and set or update a daily limit in Settings.',
  },
]

export function LandingClosure({ onStartSaving }: { onStartSaving: () => void }) {
  return (
    <>
      <section className={styles.faqSection} aria-labelledby="landing-faq-title">
        <div className={styles.faqLayout}>
          <div className={styles.faqHeading}>
            <h2 id="landing-faq-title">Your savings. Your call.</h2>
          </div>
          <div className={styles.questions}>
            {faqs.map(({ question, answer }) => (
              <details className={styles.question} key={question}>
                <summary>{question}</summary>
                <div className={styles.answer}>
                  <p>{answer}</p>
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.closing} aria-labelledby="landing-closing-title">
        <div className={styles.closingContent}>
          <h2 id="landing-closing-title">Ready for your next move?</h2>
          <button type="button" onClick={onStartSaving} className={styles.startButton}>
            Start Saving
          </button>
        </div>
        <footer className={styles.footer}>
          <Link href="#landing-main" aria-label="MOVY home" className={styles.brandLink}>
            <Wordmark inverted markSize={25} />
          </Link>
          <nav aria-label="Footer">
            <Link href="#moving-feed-title">How it works</Link>
            <Link href="#roundup-example-title">Round-up examples</Link>
            <Link href="#product-reveal-title">The MOVY app</Link>
          </nav>
        </footer>
      </section>
    </>
  )
}
