import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,cpSync,readdirSync,statSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const base='61a3762f53f31e9f4fd9c985a399aa2bb67b066a',out=resolve('out/task03c2d')
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
const sha=git('rev-parse','HEAD'),branch=git('branch','--show-current')
assert.equal(branch,'feat/task-03c2d-stack-polish')
const checks=JSON.parse(readFileSync(join(out,'audit/checks.json'))),browser=JSON.parse(readFileSync(join(out,'audit/browser.json')))
assert(checks.results.every(c=>c.exit===0));assert.equal(browser.errors.length,0)
assert.equal(browser.videos.length,2);assert(browser.videos.every(v=>v.decoded))
const files=git('diff','--name-only',base,sha).split('\n')
assert(!files.some(f=>/landing-story\.tsx|\/DESIGN\.md$|package(-lock)?\.json$/.test(f)))
const delivery=join(out,`delivery-${sha.slice(0,12)}`);mkdirSync(delivery,{recursive:true})
for(const folder of ['screenshots','videos','audit']){
 mkdirSync(join(delivery,folder),{recursive:true})
 for(const file of readdirSync(join(out,folder))){const p=join(out,folder,file);if(statSync(p).isFile()&&/\.(png|webm|json|txt)$/.test(file))cpSync(p,join(delivery,folder,file))}
}
cpSync(resolve('docs/MOVY_TASK03C2D_REVIEW.md'),join(delivery,'MOVY_TASK03C2D_REVIEW.md'))
writeFileSync(join(delivery,'changed-files.txt'),files.join('\n')+'\n')
writeFileSync(join(delivery,'REPORT.md'),`# Task03C.2D delivery\n\nReady for Kyami visual review.\n\nBranch: ${branch}\nBase: ${base}\nFinal: ${sha}\nPreview: http://localhost:3118/\nBuild ID: ${readFileSync('.next/BUILD_ID','utf8').trim()}\n\nVERIFIED in exercised Chrome: Section03 directional stack, retained edges, final hold/release/reverse, independent320/390 swipe/snap, keyboard, reduced motion, no-JS, no horizontal overflow or console errors. TypeScript/build/activity/observer/lint pass. Scoped axe reports zero violations and incomplete findings. See raw audit and review for exact skills and observable use.\n\nCard1 enters promptly from the right by at most48px while readable. Remaining entrances clear left/right/left viewport edges. One215vh desktop pin, no autoplay or wheel interception. Mobile remains native snap without pinning.\n\nOnly two Section03 runtime files changed. Other changes are review documentation and verification scripts. No packages/assets added, asset bytes unchanged. Sections01/02/04+ and four scenarios unchanged. No financial features, merge, deployment, network switch or transaction.\n\nNOT VERIFIED: physical mobile devices, Safari/Firefox, screen-reader speech, field performance and Kyami visual approval. Later sections remain DRAFT/UNAPPROVED.\n`)
const manifest=[]
function walk(dir){for(const name of readdirSync(dir)){const p=join(dir,name);if(statSync(p).isDirectory())walk(p);else manifest.push({path:p.slice(delivery.length+1).replaceAll('\\','/'),bytes:statSync(p).size,sha256:createHash('sha256').update(readFileSync(p)).digest('hex')})}}
walk(delivery);writeFileSync(join(delivery,'file-hashes.json'),JSON.stringify(manifest,null,2))
const zip=resolve('MOVY_TASK03C2D_STACK_POLISH_EVIDENCE.zip')
execFileSync('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath '${delivery}' -DestinationPath '${zip}' -Force`],{stdio:'inherit'})
console.log(JSON.stringify({branch,base,final:sha,files,zip,bytes:statSync(zip).size,sha256:createHash('sha256').update(readFileSync(zip)).digest('hex')},null,2))
