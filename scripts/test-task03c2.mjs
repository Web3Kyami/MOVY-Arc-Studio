import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { ROUNDUP_PAYMENTS, accumulatedCents, roundedBasis, formatCents } from '../src/components/movy/landing/roundup-data.ts'

assert.equal(ROUNDUP_PAYMENTS.length,4)
for(const payment of ROUNDUP_PAYMENTS){assert.equal(roundedBasis(payment.cents)-payment.cents,payment.saved);assert(payment.saved>0&&payment.saved<100);assert(Number.isInteger(payment.cents));assert(Number.isInteger(payment.saved))}
assert.deepEqual(accumulatedCents,[60,140,165,240])
assert.equal(formatCents(80),'$0.80');assert.equal(roundedBasis(3820),3900);assert.equal(roundedBasis(300),300)
const base='f2a2ca1edae147ec2597e02de8ca413d441b2e74'
const baseStory=execFileSync('git',['show',`${base}:src/components/movy/landing/landing-story.tsx`],{encoding:'utf8'})
const story=readFileSync('src/components/movy/landing/landing-story.tsx','utf8')
const later=source=>source.slice(source.indexOf('<section className="landing-product"')).replaceAll('\r','')
assert.equal(later(story),later(baseStory),'All later Landing sections must remain byte-for-byte unchanged')
for(const file of ['src/components/movy/landing/motion-hero.tsx','src/app/globals.css','package.json','package-lock.json']){
assert.equal(readFileSync(file,'utf8').replaceAll('\r',''),execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}).replaceAll('\r',''),`${file} is outside this correction's change scope`)
}
console.log('PASS: four integer-cent examples, original payment invariance, correct basis/difference, finite accumulation, locked Hero/styles/dependencies and later sections unchanged.')
