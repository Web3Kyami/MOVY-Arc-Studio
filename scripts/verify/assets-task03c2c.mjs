import sharp from 'sharp'
import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs'
import {createHash} from 'node:crypto'
const manifest=[]
for(const a of JSON.parse(readFileSync('docs/MOVY_TASK03C2C_IMAGE_PROMPTS.json'))){
 const path=`public/artwork/movy_scenario_${a.id}.webp`
 await sharp(a.source).resize(1200,800,{fit:'cover'}).webp({quality:84,effort:6}).toFile(path)
 manifest.push({...a,path,bytes:statSync(path).size,width:1200,height:800,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),sourceType:'OpenAI built-in image generation, original photorealistic artwork',stock:false,crop:'3:2 center crop, card image object-fit cover',loading:'lazy; width/height reserved'})
}
mkdirSync('out/task03c2c/audit',{recursive:true})
writeFileSync('out/task03c2c/imagery-manifest.json',JSON.stringify({assets:manifest,addedBytes:manifest.reduce((n,a)=>n+a.bytes,0),stockUsed:false},null,2))
console.log(manifest.map(({id,bytes})=>({id,bytes})))
