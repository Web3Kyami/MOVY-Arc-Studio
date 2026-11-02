import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
const out='out/task03c2c/audit';mkdirSync(out,{recursive:true});const results=[]
for(const [name,command] of [['typecheck','npm run typecheck'],['build','npm run build'],['activity','npm run test:activity'],['observer','npm run test:observer'],['scope','npx tsx scripts/test-task03c2c.mjs'],['lint','npx eslint src/components/movy/landing/motion-hero.tsx src/components/movy/landing/moving-roundup-feed.tsx src/components/movy/landing/roundup-example.tsx src/components/movy/landing/crypto-scenarios.ts src/components/movy/views/landing-view.tsx']]){
 const database=['observer','activity'].includes(name)?resolve(out,`${name}-${randomUUID()}.db`):null
 const start=new Date().toISOString(),r=spawnSync(command,{shell:true,encoding:'utf8',env:{...process.env,...(database?{MOVY_DB_PATH:database}:{})}});results.push({name,command,start,exit:r.status,database});writeFileSync(`${out}/${name}.txt`,`${command}\n${start}\nDatabase:${database||'suite default'}\nExit:${r.status}\n${r.stdout}\n${r.stderr}`);console.log(name,r.status);if(r.status!==0)process.exitCode=1
}
writeFileSync(`${out}/checks.json`,JSON.stringify(results,null,2))
