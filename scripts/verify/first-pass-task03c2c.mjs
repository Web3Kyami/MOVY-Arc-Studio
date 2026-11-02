import {chromium} from 'playwright-core'
import {mkdirSync,writeFileSync} from 'node:fs'
const dir='out/task03c2c/first-pass';mkdirSync(dir,{recursive:true})
const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),results=[]
for(const [width,height] of [[320,568],[390,844],[1440,900]]){
 const c=await b.newContext({viewport:{width,height}}),p=await c.newPage()
 await p.goto('http://localhost:3116/',{waitUntil:'networkidle'});await p.waitForTimeout(1300)
 await p.screenshot({path:`${dir}/hero-${width}.png`})
 const top=await p.locator('[data-section="03"]').evaluate(e=>e.getBoundingClientRect().top+scrollY)
 await p.evaluate(y=>scrollTo(0,y+3),top);await p.waitForTimeout(800)
 await p.screenshot({path:`${dir}/stack-${width}.png`})
 const measure=await p.locator('[data-section="03"]').evaluate(e=>({mode:e.dataset.enhanced,viewport:innerHeight,sectionHeight:e.getBoundingClientRect().height,card:[...e.querySelectorAll('[data-scenario]')].map(c=>({top:c.getBoundingClientRect().top,bottom:c.getBoundingClientRect().bottom,width:c.getBoundingClientRect().width,left:c.getBoundingClientRect().left})),overflow:document.documentElement.scrollWidth>innerWidth}))
 results.push({width,height,...measure})
 if(width===1440){await p.evaluate(y=>scrollTo(0,y+2160*.93),top);await p.waitForTimeout(700);await p.screenshot({path:`${dir}/stack-1440-final.png`})}
 await c.close()
}
writeFileSync(`${dir}/mobile-pin-trial.json`,JSON.stringify(results,null,2));console.log(results);await b.close()
