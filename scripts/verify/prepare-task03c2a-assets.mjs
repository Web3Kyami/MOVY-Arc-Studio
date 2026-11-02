import sharp from 'sharp'
import {writeFileSync,statSync,mkdirSync} from 'node:fs'
const sources={"coffee":"C:\\Users\\USER\\.codex\\generated_images\\01a10a1e-4a40-7a53-a3e1-63ed9a6f8c72\\exec-4c94e45f-1428-4bc3-9d94-207e930c745d.png","groceries":"C:\\Users\\USER\\.codex\\generated_images\\01a10a1e-4a40-7a53-a3e1-63ed9a6f8c72\\exec-1cd9ddad-fcc1-4ce1-8984-f574e261b13a.png","commute":"C:\\Users\\USER\\.codex\\generated_images\\01a10a1e-4a40-7a53-a3e1-63ed9a6f8c72\\exec-a2c551b3-c403-4203-97d5-a3c165e3b70f.png","lunch":"C:\\Users\\USER\\.codex\\generated_images\\01a10a1e-4a40-7a53-a3e1-63ed9a6f8c72\\exec-e8659a9f-8f92-4807-9e3c-0b070ec55583.png"}
mkdirSync('out/task03c2a-style',{recursive:true})
const assets=[]
for(const [name,source] of Object.entries(sources)){
 const path=`public/artwork/movy_everyday_${name}.webp`
 await sharp(source).resize(432,432,{fit:'cover'}).webp({quality:82}).toFile(path)
 assets.push({name,source,path,width:432,height:432,bytes:statSync(path).size,origin:'OpenAI built-in imagegen, original generated lifestyle imagery',stock:false,usage:'Section02 merchant thumbnail',loading:'lazy'})
}
writeFileSync('out/task03c2a-style/asset-manifest.json',JSON.stringify({assets,oldFeedTotalBytes:129706,newFeedTotalBytes:assets.reduce((s,a)=>s+a.bytes,0),heroAssets:'Existing approved artwork unchanged'},null,2))
console.log(assets)
