import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,cpSync,readdirSync,statSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const base='7491f69bb7f04d278a6dc805b9090f0c7663df2f',out=resolve('out/task03c2c')
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
const sha=git('rev-parse','HEAD'),branch=git('branch','--show-current')
assert.equal(branch,'feat/task-03c2c-stacked-crypto-scenarios')
const checks=JSON.parse(readFileSync(join(out,'audit/checks.json'))),browser=JSON.parse(readFileSync(join(out,'audit/browser-verification.json')))
assert.equal(checks.length,6);assert(checks.every(c=>c.exit===0));assert.equal(browser.errors.length,0);assert.equal(browser.videos.length,2);assert(browser.videos.every(v=>v.decoded));assert(browser.axe.every(a=>a.violations===0))
const files=git('diff','--name-only',base,sha).split('\n')
assert(!files.some(f=>/landing-story\.tsx|DESIGN\.md$|package(-lock)?\.json$/.test(f)))
const delivery=join(out,`delivery-${sha.slice(0,12)}`);mkdirSync(delivery,{recursive:true})
for(const folder of ['screenshots','videos','audit']){
 mkdirSync(join(delivery,folder),{recursive:true})
 for(const file of readdirSync(join(out,folder))){const p=join(out,folder,file);if(statSync(p).isFile()&&/\.(png|webm|json|txt)$/.test(file))cpSync(p,join(delivery,folder,file))}
}
cpSync(join(out,'first-pass'),join(delivery,'audit/superseded-mobile-pin-trial'),{recursive:true})
for(const file of ['MOVY_TASK03C2C_SPEC.md','MOVY_TASK03C2C_IMAGE_PROMPTS.json','MOVY_TASK03C2C_REVIEW.md'])cpSync(resolve('docs',file),join(delivery,file))
cpSync(join(out,'imagery-manifest.json'),join(delivery,'imagery-manifest.json'))
mkdirSync(join(delivery,'artwork'),{recursive:true})
for(const id of ['vpn','travel','gaming','accessory'])cpSync(resolve(`public/artwork/movy_scenario_${id}.webp`),join(delivery,'artwork',`movy_scenario_${id}.webp`))
writeFileSync(join(delivery,'changed-files.txt'),files.join('\n')+'\n')
const report=`# MOVY Task03C.2C verification report

Ready for Kyami visual review. This is not visual approval or completion of the whole Landing.

Branch: ${branch}
Base: ${base}
Final commit: ${sha}
Production build ID: ${readFileSync('.next/BUILD_ID','utf8').trim()}
Local preview: http://localhost:3117/

## VERIFIED in the exercised environment

- TypeScript, production build, existing activity and observer regressions, focused scope assertions and touched-source lint: all exit0. Raw logs and timestamps are in audit. Financial regressions use separate fresh disposable SQLite databases through the existing MOVY_DB_PATH override. Earlier cache/shared-fixture failures are preserved with superseded filenames and explained in the specification.
- Fresh Chrome renders at320,390,900,1440,1920. No page horizontal overflow, customer-facing forbidden copy or console/hydration errors in the exercised flows.
- Hero: non-scroll one-time entrance; normal flow; no Hero ScrollTrigger, pin, payment overlay, goal narrative or app screenshot. Eligible-payment storytelling starts only in02.
- Section02: prior finite scroll mechanism preserved byte-for-byte; original merchant amounts and separate round-ups retained; final accumulation$2.40.
- Section03: four exact scenarios and arithmetic; one desktop master ScrollTrigger; incoming cards enter from right; all previous cards retain opacity1 and visible left-edge depth; idle position stays still; reverse scroll resets; pin releases after final hold. Additional distance240vh. Actual raw browser video is the motion evidence, not screenshot interpolation.
- Keyboard Tab reaches all four scenarios, synchronises the visible desktop stage and shows a3px focus outline. Mobile finger swipe, next, previous and arrow keys exercised.48px controls. Mobile uses native CSS snap with peek, no pin.
- Reduced-motion and no-JS layouts at1440/390 retain all four scenarios in vertical flow, no pin. Axe4.10.3 WCAG2A/AA and2.1AA scoped to navigation and01–03: zero definite violations; inspect incomplete findings in raw audit.
- Explore Demo enters populated simulated Preview Home. Start Saving enters genuine activation Step1of6, not Preview. Verification stops there, with no wallet connection, authorization or transaction.

## Libraries and imagery

No packages added. GSAP3.15.0 and @gsap/react2.1.2 own Hero entrance and scroll stories. Motion14.0.0 remains in the existing02 rolling total only. No competing engines on card transforms. Four original imagegen photographs, no stock used, no merchant logos. Optimised1200x800 WebP assets total274392bytes, lazy-loaded with reserved dimensions. Exact source paths, prompts and hashes are in the asset manifest.

## NOT VERIFIED / limits

Kyami visual approval remains outstanding. Physical iOS/Android, Safari and Firefox, screen-reader speech output, field Core Web Vitals and low-end-device frame rate were not tested. Chrome mobile emulation is not hardware validation. Axe reports34 incomplete feed contrast nodes due to the existing transparent actor overlay; an in-view follow-up still reports incomplete rows. Separate authored solid token ratios pass4.5:1, but this is not a complete automated contrast verdict. Automated checks do not replace assistive-technology review. No mainnet, deployment, merge or financial transaction was performed. Sections04+ remain untouched DRAFT / UNAPPROVED and are not acceptance evidence.

## Evidence index

${browser.screenshots.length} fresh screenshots in screenshots, two raw25fps browser recordings in videos, extracted inspection frames, verification JSON, axe output and raw check logs in audit. Superseded trial files are labelled separately. Exact changed files: changed-files.txt. Exact loaded skill paths and observable application: MOVY_TASK03C2C_SPEC.md. Writing skill activation: kyami-writing with concise natural copy, no em dashes or technical chips in01–03.
`
writeFileSync(join(delivery,'REPORT.md'),report)
const manifest=[]
function walk(dir){for(const name of readdirSync(dir)){const p=join(dir,name);if(statSync(p).isDirectory())walk(p);else manifest.push({path:p.slice(delivery.length+1).replaceAll('\\','/'),bytes:statSync(p).size,sha256:createHash('sha256').update(readFileSync(p)).digest('hex')})}}
walk(delivery);writeFileSync(join(delivery,'file-hashes.json'),JSON.stringify(manifest,null,2))
const zip=resolve('MOVY_TASK03C2C_STACKED_SCENARIOS_EVIDENCE.zip')
execFileSync('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath '${delivery}' -DestinationPath '${zip}' -Force`],{stdio:'inherit'})
const result={branch,base,final:sha,files,zip,bytes:statSync(zip).size,sha256:createHash('sha256').update(readFileSync(zip)).digest('hex')}
writeFileSync(join(out,'delivery.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
