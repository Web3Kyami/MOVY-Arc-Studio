import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
const out=resolve('out/task03c2-sections/audit');mkdirSync(out,{recursive:true})
const checks=[['typecheck','npm run typecheck'],['production-build','npm run build'],['activity','npm run test:activity'],['observer','npm run test:observer'],['section02-03-scope-arithmetic','npx tsx scripts/test-task03c2.mjs'],['landing-eslint','npx eslint src/components/movy/landing/moving-roundup-feed.tsx src/components/movy/landing/rolling-money.tsx src/components/movy/landing/roundup-example.tsx src/components/movy/landing/roundup-data.ts']]
const results=[]
for(const [name,command] of checks){const started=new Date().toISOString();const result=spawnSync(command,{shell:true,encoding:'utf8'});writeFileSync(resolve(out,name+'.txt'),`Command: ${command}\nStarted: ${started}\nExit: ${result.status}\n${result.stdout||''}\n${result.stderr||''}`);results.push({name,command,exit:result.status});console.log(name,result.status);if(result.status!==0)process.exitCode=1}
writeFileSync(resolve(out,'checks.json'),JSON.stringify(results,null,2))
