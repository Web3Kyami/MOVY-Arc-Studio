import {spawnSync,execFileSync} from 'node:child_process'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
const out='out/task03c2d/audit',base='61a3762f53f31e9f4fd9c985a399aa2bb67b066a';mkdirSync(out,{recursive:true});const results=[]
const allowed=['src/components/movy/landing/roundup-example.tsx','src/components/movy/landing/scenario-stack.module.css']
const changed=execFileSync('git',['diff','--name-only',base],{encoding:'utf8'}).trim().split('\n');assert(changed.every(f=>allowed.includes(f)||f.startsWith('docs/')||f.startsWith('scripts/')))
for(const f of ['src/components/movy/landing/motion-hero.tsx','src/components/movy/landing/moving-roundup-feed.tsx','src/components/movy/landing/landing-story.tsx','src/components/movy/landing/crypto-scenarios.ts','src/components/movy/views/landing-view.tsx','src/app/globals.css','package.json','package-lock.json'])assert.equal(readFileSync(f,'utf8').replaceAll('\r\n','\n'),execFileSync('git',['show',`${base}:${f}`],{encoding:'utf8'}).replaceAll('\r\n','\n'),`Protected file ${f}`)
for(const [name,command] of [['typecheck','npm run typecheck'],['build','npm run build'],['activity','npm run test:activity'],['observer','npm run test:observer'],['lint','npx eslint src/components/movy/landing/roundup-example.tsx']]){
 const database=['activity','observer'].includes(name)?resolve(out,`${name}-${randomUUID()}.db`):null,start=new Date().toISOString(),r=spawnSync(command,{shell:true,encoding:'utf8',env:{...process.env,...(database?{MOVY_DB_PATH:database}:{})}})
 results.push({name,command,start,database,exit:r.status});writeFileSync(`${out}/${name}.txt`,`${command}\n${start}\nDatabase:${database}\nExit:${r.status}\n${r.stdout}\n${r.stderr}`);console.log(name,r.status);if(r.status!==0)process.exitCode=1
}
writeFileSync(`${out}/checks.json`,JSON.stringify({base,scope:'Only two Section03 runtime files changed; protected sections, scenarios, dependencies unchanged',changed,results},null,2))
