import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
const out=resolve('out/task03c2b/audit');mkdirSync(out,{recursive:true})
const results=[]
for(const [name,command] of [['typecheck','npm run typecheck'],['build','npm run build'],['activity','npm run test:activity'],['observer','npm run test:observer'],['scope','npx tsx scripts/test-task03c2b.mjs'],['landing-lint','npx eslint src/components/movy/landing/motion-hero.tsx src/components/movy/landing/moving-roundup-feed.tsx src/components/movy/landing/roundup-example.tsx src/components/movy/views/landing-view.tsx']]){
 const start=new Date().toISOString(),r=spawnSync(command,{shell:true,encoding:'utf8'});results.push({name,command,start,exit:r.status});writeFileSync(resolve(out,name+'.txt'),`${command}\n${start}\nExit:${r.status}\n${r.stdout}\n${r.stderr}`);console.log(name,r.status);if(r.status!==0)process.exitCode=1
}
writeFileSync(resolve(out,'checks.json'),JSON.stringify(results,null,2))
