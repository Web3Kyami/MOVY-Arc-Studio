import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {ROUNDUP_PAYMENTS,accumulatedCents,roundedBasis} from '../src/components/movy/landing/roundup-data.ts'
const base='45009d2c70a11a55908f2e512ef3b1823d6b69f0'
const current=f=>readFileSync(f,'utf8').replaceAll('\r','')
const original=f=>execFileSync('git',['show',`${base}:${f}`],{encoding:'utf8'}).replaceAll('\r','')
for(const f of ['src/components/movy/landing/landing-story.tsx','src/app/globals.css','src/components/movy/landing/rolling-money.tsx','src/components/movy/landing/roundup-data.ts','package.json','package-lock.json'])assert.equal(current(f),original(f),`${f}: protected scope`)
const hero=current('src/components/movy/landing/motion-hero.tsx')
assert(!/ScrollTrigger|useGSAP|gsap|\$3\.40|\$0\.60|sanctuary|Emergency|mh-|MotionPath/.test(hero),'Hero must not contain scroll/financial story')
assert(hero.includes('data-section="01"'));assert(hero.includes('onExploreDemo'));assert(hero.includes('onStartSaving'))
const feed='src/components/movy/landing/moving-roundup-feed.tsx',motion=s=>s.slice(s.indexOf('  useGSAP('),s.indexOf('\n  return <section'))
assert.equal(motion(current(feed)),motion(original(feed)),'Feed mechanics byte-identical')
const lab='src/components/movy/landing/roundup-example.tsx'
assert.equal(current(lab).replace('>Interactive example</p>','>03 / Interactive example</p>'),original(lab),'Lab only customer label changes')
for(const f of ['src/components/movy/landing/motion-hero.tsx',feed,lab])assert(!/\p{Emoji_Presentation}/u.test(current(f)),`${f}: no emoji UI`)
for(const p of ROUNDUP_PAYMENTS)assert.equal(roundedBasis(p.cents)-p.cents,p.saved)
assert.deepEqual(accumulatedCents,[60,140,165,240])
console.log('PASS Hero financial/pin story absent; feed mechanics and Lab interaction preserved; later sections/global rules/dependencies/data untouched.')
