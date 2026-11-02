import {mkdirSync,readFileSync,writeFileSync,cpSync,statSync} from 'node:fs'
import {resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const base='45009d2c70a11a55908f2e512ef3b1823d6b69f0'
const root=resolve('out/task03c2b'),delivery=resolve('out/task03c2b-delivery')
const browser=JSON.parse(readFileSync(resolve(root,'audit/browser-verification.json')))
const checks=JSON.parse(readFileSync(resolve(root,'audit/checks.json')))
if(checks.some(c=>c.exit!==0)||browser.errors.length||browser.axe.violations.length)throw Error('Evidence gate failed')
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
const sha=git('rev-parse','HEAD'),branch=git('branch','--show-current')
const changed=git('diff','--name-only',base,sha).split('\n')
mkdirSync(delivery,{recursive:true})
for(const folder of ['screenshots','videos','audit'])cpSync(resolve(root,folder),resolve(delivery,folder),{recursive:true})
cpSync('docs/MOVY_TASK03C2B_HERO_SEPARATION.md',resolve(delivery,'research-and-specification.md'))
cpSync('docs/MOVY_DESIGN_V2_PROPOSAL.md',resolve(delivery,'design-proposal-history.md'))
writeFileSync(resolve(delivery,'changed-files.txt'),changed.join('\n')+'\n')
const old=JSON.parse(readFileSync('out/task03c2a-style/asset-manifest.json'))
const asset=path=>({path,bytes:statSync(path).size,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})
const assets={newAssets:[],stockUsed:false,addedBytes:0,notes:'Existing original generated WebPs reused byte-for-byte. Hero coin/sanctuary removed; feed sanctuary replaced by inline SVG. No imagegen activation or new licensed-stock claim in this task.',assets:[{...asset('public/artwork/movy_hero_sculpture.webp'),width:1400,height:876,usage:'Hero sole brand visual',origin:'Existing original MOVY generated sculpture from Task03C',loading:'critical priority, reserved dimensions'},...old.assets.map(a=>({...a,...asset(a.path),status:'reused unchanged; provenance copied from existing Task03C.2A manifest'}))]}
writeFileSync(resolve(delivery,'asset-manifest.json'),JSON.stringify(assets,null,2))
writeFileSync(resolve(delivery,'manifest.json'),JSON.stringify({branch,base,final:sha,changedFiles:changed,screenshots:browser.screenshots,videos:browser.videos,checks,scope:'Sections01–03 only; later sections DRAFT / UNAPPROVED'},null,2))
const skills=['kyami-product-design','ui-reference-loop','screenshot-to-code','gsap','gsap-scrolltrigger','gsap-react','gsap-performance','motion-dev','a11y-gates','headless-browser-display-driving','browser-video-recording','controlled-evidence-verification','kyami-development']
writeFileSync(resolve(delivery,'REPORT.md'),`# MOVY Task03C.2B — Ready for Kyami visual review

Branch: \`${branch}\`
Base: \`${base}\`
Final commit: \`${sha}\`
Preview: http://localhost:3115/ (local production build; not deployed)

## Outcome and before/after

Hero now contains only proposition, short emotional copy, genuine entry buttons and one original sculpture. It has NO GSAP import, ScrollTrigger, pin, scrub, transaction overlay, goal/sanctuary, Emergency Cushion or product/app screen. CSS transform-only load entrance is optional and disabled for reduced motion. Before: pinned payment→saving→sanctuary story. After: normal document flow; Hero moves1:1 with scroll and leaves naturally. Its future-state DOM was removed, not delayed/hidden until a client effect.

All illustrative payment/round-up storytelling begins in Section02. The section uses the same coherent original everyday WebPs, merchant-original-payment labels and separate saving. Visible internal02/03 prefixes removed. Section02 sanctuary changed to a restrained citrus SVG accumulation cue; no detailed goal story. Feed GSAP lifecycle/timeline code is byte-identical to base. Section03 keeps its existing Motion tactile digits, native radio choices, arithmetic and small illustrative progress response, with only its customer-facing eyebrow changed.

Section04+ markup, global stylesheet, approved Home, activation/financial/network semantics, dependencies and root DESIGN.md were not modified. Later content remains DRAFT / UNAPPROVED and is excluded from screenshots/video. No merge, deployment, mainnet switch, wallet connection, authorization or real-money movement.

## VERIFIED — implementation and scoped Chromium execution

- TypeScript, production build, activity regressions, observer regressions, Landing lint and scope/integer-arithmetic guards: six checks, all exit0; raw logs in audit/.
- Fresh browser contexts at320×568,390×844,900×1080,1440×900,1920×1080: no horizontal overflow, Hero copy/art overlap, pin ancestry, payment/goal text inside Hero, console/page/hydration errors or visible internal roadmap numbering.
- ${browser.separation.length} boundary observations through forward/reverse checks and both actual recordings:02 starts at/after Hero bottom; every rendered citrus actor remains below Hero. Hidden display:none/zero-width actors are excluded. Hero document position remains constant through ordinary scroll.
- Desktop feed updates0→0.60→1.40→2.40 at sampled progression, stays still when scroll stops and returns to0 on reverse; all four underlying savings total2.40. Mobile unpinned progression reaches2.40 without climbing into Hero.
- Lab Coffee3.40→4.00/+0.60; Lunch14.25→15.00/+0.75; Groceries38.20→39.00/+0.80; Commute2.75→3.00/+0.25. Native arrow selection, visible keyboard outlines and≥44px controls checked;390 touch selection captured.
- Hero Explore Demo enters populated /home with Simulated disclosure; Start Saving enters genuine Step1of6 activation flow, not Preview. No wallet authorization performed.
- Reduced-motion and JavaScript-disabled fresh loads at1440/390: complete proposition, all four static payments,2.40 accumulated savings and default Lab arithmetic; no pin or blank motion spacer. Reduced-motion Lab selection works. No-JS is readable static content, not a claim of interactive functionality.
- Focused axe4.10.3 WCAG2A/AA/2.1AA has zero definite violations. It flags ten incomplete contrast determinations on overlapped/masked feed elements; retained in audit/axe.json, not represented as a full accessibility certification. Visible initial/final rows, headline, values and focus were visually inspected.
- 45 fresh screenshots and two raw real-browser WebM recordings, desktop1440×900/17.84s and mobile390×844/16.36s at25fps. Both fully decoded successfully; extracted startup/intermediate frames inspected. These are actual browser captures, not still-image animation. Evidence stops at03.
- Touched customer UI contains no emoji; functional icons remain Lucide. Source scope guard protects later story/global rules, shared digit component, financial sample data and package files.

## NOT VERIFIED / review caveats

Kyami visual acceptance is NOT VERIFIED and is not claimed. Physical iPhone/Android, Safari/Firefox, hardware screen-reader output, low-end device performance and field Core Web Vitals were not tested. The ten axe contrast-incomplete nodes remain an explicit audit limitation. Browser geometry and decoded videos verify separation, not design approval.

One first boundary-test run failed because the harness treated mobile display:none actors as visible at zero coordinates. It was corrected to test rendered non-zero bounds, and the complete browser suite was rerun; no product workaround was applied for that false failure. Windows Chromium works directly; no X11 fallback required.

## Skills actually loaded

${skills.map(s=>'- C:/Users/USER/.codex/skills/'+s+'/SKILL.md').join('\n')}

Screenshot-to-code used for static reference proportions/hierarchy only, never motion extraction. Kyami-development loaded as its required integration. UI reference loop drove fresh renders, state inspection and review. GSAP skills preserve section-scoped cleanup/user progression; Motion owns only local Lab/digit changes. Accessibility and evidence skills constrain reduced/static fallback and verification claims. No additional animation library or package installed. Existing GSAP3.15.0, @gsap/react2.1.2 and Motion14 are used; Hero uses CSS only.

## References and imagery

Exact source URLs, roles and retrieval limitations are in research-and-specification.md. Bitstack and Revolut actual pages inspected; Cash App official content available but browser region-blocked; KAST browser site-not-found, indexed official text available. Pinned Comacard and Syncly repository READMEs inspected. No reference code, brand imagery, card/bank semantics or network was imported.

Five existing original WebPs reused; four coherent merchant images lazy-loaded with reserved sizes. One critical Hero sculpture priority-loaded with dimensions. No new stock/source licence obligation or asset-byte increase. Inline SVG replaces later aspiration imagery. Full provenance/size/hash manifest included. Existing runtime libraries unchanged; no unbounded scroll listener, new WebGL or video hero. Field performance is not certified.

## Exact changed files

${changed.map(f=>'- '+f).join('\n')}

Ready for Kyami visual review. STOP — no Section04 work, merge or deployment.
`)
console.log(JSON.stringify({branch,sha,changedFiles:changed.length,delivery,screenshots:browser.screenshots.length,videos:browser.videos.length},null,2))
