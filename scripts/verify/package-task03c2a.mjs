import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'

const base='6796cff3e8d846ab3f762062178b5dacce03b42b'
const input=resolve('out/task03c2a-style'),out=resolve('out/task03c2a-delivery')
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
const branch=git('branch','--show-current'),commit=git('rev-parse','HEAD')
if(branch!=='feat/task-03c2a-style-bridge-01-03'||commit===base)throw Error('Commit the scoped branch before packaging')
const checks=JSON.parse(readFileSync(join(input,'audit/checks.json')))
if(checks.some(c=>c.exit!==0))throw Error('Checks must pass')
const browser=JSON.parse(readFileSync(join(input,'audit/browser-verification.json')))
if(browser.videos.some(v=>!v.decoded))throw Error('Videos must decode')
const files=git('diff','--name-only',base,commit).split('\n')
const copy=(from,to)=>{mkdirSync(resolve(to,'..'),{recursive:true});copyFileSync(from,to)}
for(const name of browser.screenshots)copy(join(input,'screenshots',name),join(out,'screenshots',name))
for(const entry of readdirSync(join(input,'videos'),{withFileTypes:true}))if(entry.isFile())copy(join(input,'videos',entry.name),join(out,'videos',entry.name))
for(const entry of readdirSync(join(input,'audit'),{withFileTypes:true}))if(entry.isFile())copy(join(input,'audit',entry.name),join(out,'audit',entry.name))
copy(join(input,'asset-manifest.json'),join(out,'asset-manifest.json'))
for(const file of files.filter(f=>f.startsWith('public/artwork/')))copy(resolve(file),join(out,'assets',file.split('/').pop()))
copy(resolve('docs/MOVY_TASK03C2A_STYLE_BRIDGE.md'),join(out,'research-reference-and-style-notes.md'))
copy(resolve('docs/MOVY_DESIGN_V2_PROPOSAL.md'),join(out,'design-proposal.md'))
const before=[['out/task03c-landing/landing-1440-start.png','hero-before.png'],['out/task03c2-delivery/screenshots/section02-1440-initial.png','section02-before.png'],['out/task03c2-delivery/screenshots/section03-1440-default.png','section03-before.png']]
for(const [from,name] of before)if(existsSync(from))copy(resolve(from),join(out,'before',name))
writeFileSync(join(out,'changed-files.txt'),files.join('\n')+'\n')
const spec=readFileSync('docs/MOVY_TASK03C2A_STYLE_BRIDGE.md','utf8')
const skills=[...spec.matchAll(/^- `(.*SKILL\.md)`/gm)].map(m=>m[1])
const report=`# MOVY Task03C.2A — review delivery

Branch: ${branch}
Base: ${base}
Final commit: ${commit}

## Verdict

VERIFIED for the scoped implementation, regression checks and Chromium browser checks described below. NOT VERIFIED as final visual approval, cross-browser/device certification or performance certification. Stop for Kyami/coordinator review. No merge, deployment, network switch or financial transaction.

## Before / after

Hero DID change visually: white stage, sharper ink/evergreen typography, quieter sculptural framing, clearer dark destination region. Its artwork, pin/scrub/path/mask timeline and first-paint fix remain unchanged. Section02 now uses original cohesive photoreal everyday imagery, clean ledger rows and an evergreen/citrus accumulator. Section03 now has a dark section anchor, white product-like arithmetic workspace and native segmented controls. The selected background switches immediately for contrast while Motion's citrus outline travels. Sanctuary remains a selective brand accent, not the repeated page surface. No fake dashboard or unnecessary devices were introduced.

GSAP closures are byte-identical to the base; original scroll distances, row count, state/arithmetic, rolling digits, mobile adaptation, reduced/no-JS content and entry callbacks are retained. Sections04–06 markup, global first-paint/static CSS, Home, activation, contracts, network settings and package manifests are unchanged. Root DESIGN.md was not edited.

Before captures are archived accepted evidence, not a fresh paired same-session measurement. Fresh captures/videos are in screenshots/ and videos/.

## Checks and evidence

All six checks exited 0: TypeScript, production build, activity regressions, observer regressions, scope/arithmetic guard, focused Landing lint. Raw logs: audit/.

39 fresh screenshots include 320/390/900/1440/1920, Hero start/payment/travel/destination, feed progression/exit, Lab default/selection/focus, reduced motion and no-JS. Five raw browser videos decode completely: desktop Hero→02→03 (21.84s), mobile same flow (16.24s), focused Hero startup/story (13.52s), feed (14.32s), Lab (7.12s). These are actual 25fps Chromium viewport recordings, not screenshot-rendered animation or interpolated footage.

Browser checks: no horizontal overflow at all five widths; zero console/page errors; feed totals 0→0.60→1.40→1.65→2.40 and scroll reversal correct; no idle ticker; all four Lab calculations correct; moving digits sampled; native arrow selection, real Tab order, visible 3px focus, hit-testing and minimum 44px targets verified. Merchant receives original amount, basis is calculation only, savings are separate and explicitly illustrative. Explore Demo enters populated simulated Preview Home; Start Saving enters actual Step1of6, not Preview. No wallet connection or authorization performed.

Reduced motion at 1440/390 disables pinning and shows complete information. No-JS desktop/mobile preserve static numerical content. Fresh startup frames at 0.2/0.6/1/2s show no future payment/save/destination flash. Actual video frames were visually inspected at startup, travel, destination, feed accumulation, Lab and mobile states; all video streams fully decoded. This is sampled visual inspection, not a claim that every video frame was manually reviewed.

Axe4.10.3 WCAG A/AA scoped to01–03: zero definite violations, 14 image/layer contrast incomplete nodes remain manual-review items. Solid selected name/value contrast measured 14.69:1 / 11.61:1; saved result 4.59:1. No claim of complete accessibility certification. 720px equivalent reflow passes; physical browser200% zoom and hardware screen readers were not tested. The superseded first-pass contrast audit is preserved; selected-state timing was corrected and retested. An initial harness visibility assertion was corrected to existing opacity semantics; an entry assertion was corrected to the actual accessible Step1of6 label. Neither required changing the preserved flows.

## Assets / libraries / performance

Four original imagegen photographs, no stock/third-party production imagery or stock attribution obligations. WebP432×432, reserved dimensions, noncritical lazy loading. Active feed assets total160,408 bytes vs129,706 (+30,702 / +23.7%). Hero source assets/preload unchanged. Source manifest: asset-manifest.json; prompts/roles: research-reference-and-style-notes.md. No packages added. Existing GSAP3.15.0 + @gsap/react2.1.2 own scroll; Motion14 owns local transitions. No Torph/Anime/WebGL added. No animation ownership overlap.

No measured Core Web Vitals, low-end GPU benchmark, real-phone Safari or Firefox evidence; actual25fps recording proves behavior, not60fps performance. Image/layer contrast and final hierarchy remain reviewer checks. Main design question: approve the quieter retained Hero sculpture and the new photo-ledger/evergreen-Lab bridge; device framing is deliberately deferred to the unchanged genuine product reveal.

## Research and skills

Reference roles, URLs, retrieval limitations and source decisions are recorded in research-reference-and-style-notes.md. Bitstack actual page inspected; Revolut product hierarchy considered. CashApp direct retrieval and exact Comacard source were unavailable; KAST browser returned404. No fabricated measurements or imported reference code. Screenshot-to-code was loaded/inspected as secondary proportion support; theme replication rejected and never used as a motion source. Landing-page aesthetic skill informed hierarchy. Required skills informed scoped composition, lifecycle preservation, real-browser render/inspect/correct, native accessibility and evidence limits.

Exact loaded paths:
${skills.map(p=>'- '+p).join('\n')}

Exact OpenAI Codex model/version/reasoning level are not exposed to this task; no model identifier is invented.

## Exact changed files

${files.map(f=>'- '+f).join('\n')}
`
writeFileSync(join(out,'REPORT.md'),report)
writeFileSync(join(out,'manifest.json'),JSON.stringify({branch,base,commit,files,skills,screenshots:browser.screenshots,videos:browser.videos,verdict:'VERIFIED within reported scope; visual approval pending'},null,2))
console.log(JSON.stringify({out,commit,changedFiles:files.length,screenshots:browser.screenshots.length,videos:browser.videos.length}))
