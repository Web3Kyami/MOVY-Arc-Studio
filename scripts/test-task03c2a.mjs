import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {ROUNDUP_PAYMENTS,accumulatedCents,roundedBasis} from '../src/components/movy/landing/roundup-data.ts'
const base='6796cff3e8d846ab3f762062178b5dacce03b42b'
const current=file=>readFileSync(file,'utf8').replaceAll('\r','')
const original=file=>execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}).replaceAll('\r','')
for(const file of ['src/components/movy/landing/landing-story.tsx','src/app/globals.css','src/components/movy/landing/rolling-money.tsx','package.json','package-lock.json'])assert.equal(current(file),original(file),`${file}: untouched scope/libraries/first-paint rules`)
for(const file of ['src/components/movy/landing/motion-hero.tsx','src/components/movy/landing/moving-roundup-feed.tsx']){
 const motion=s=>s.slice(s.indexOf('  useGSAP('),s.indexOf(file.includes('motion-hero') ? '\n  return (' : '\n  return <section'))
 assert.equal(motion(current(file)),motion(original(file)),`${file}: approved choreography must be byte-identical`)
}
for(const p of ROUNDUP_PAYMENTS){assert.equal(roundedBasis(p.cents)-p.cents,p.saved);assert(Number.isInteger(p.cents));assert(p.saved>=0&&p.saved<100)}
assert.deepEqual(accumulatedCents,[60,140,165,240])
const lab='src/components/movy/landing/roundup-example.tsx'
assert.equal(current(lab).split('  return <section')[0],original(lab).split('  return <section')[0],'Lab state, arithmetic and reduced-motion transition logic remain unchanged')
console.log('PASS: original Hero/feed choreography, first-paint/fallback global rules, rolling digits, all later sections, dependencies unchanged. Integer round-up arithmetic preserved.')
