import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {CRYPTO_SCENARIOS} from '../src/components/movy/landing/crypto-scenarios.ts'
const base='7491f69bb7f04d278a6dc805b9090f0c7663df2f',read=f=>readFileSync(f,'utf8').replaceAll('\r','')
for(const f of ['src/components/movy/landing/landing-story.tsx','src/app/globals.css','src/components/movy/landing/rolling-money.tsx','src/components/movy/landing/roundup-data.ts','package.json','package-lock.json','../DESIGN.md']){
 if(f.startsWith('../'))continue
 assert.equal(read(f),execFileSync('git',['show',`${base}:${f}`],{encoding:'utf8'}).replaceAll('\r',''),`${f}: untouched scope`)
}
const hero=read('src/components/movy/landing/motion-hero.tsx')
assert(!/ScrollTrigger|pin:|scrub:|Emergency|sanctuary|\$3\.40/.test(hero))
const feedPath='src/components/movy/landing/moving-roundup-feed.tsx',feed=read(feedPath),old=execFileSync('git',['show',`${base}:${feedPath}`],{encoding:'utf8'}).replaceAll('\r','')
const motion=s=>s.slice(s.indexOf('  useGSAP('),s.indexOf('\n  return <section'))
assert.equal(motion(feed),motion(old),'Feed motion preserved')
assert.deepEqual(CRYPTO_SCENARIOS.map(s=>[s.cents,s.basis,s.saved]),[[940,1000,60],[28625,28700,75],[1949,2000,51],[7420,7500,80]])
for(const s of CRYPTO_SCENARIOS){assert.equal(Math.ceil(s.cents/100)*100,s.basis);assert.equal(s.basis-s.cents,s.saved)}
for(const f of ['src/components/movy/landing/motion-hero.tsx',feedPath,'src/components/movy/landing/roundup-example.tsx'])assert(!/\p{Emoji_Presentation}|—|–|Arc Testnet|No wallet|No funds|Interactive example|How MOVY works|Try it yourself/i.test(read(f)),`${f}: copy sweep`)
console.log('PASS exact four-scenario cents, copy sweep, Hero non-scroll, feed mechanics preserved, later/global/data/dependencies untouched.')
