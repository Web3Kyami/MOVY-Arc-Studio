import {chromium} from 'playwright-core'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
const out=resolve('out/task03c2-sections/research');mkdirSync(out,{recursive:true})
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:900}})
await page.goto('https://www.bitstack-app.com/en/roundups?c=EUR',{waitUntil:'domcontentloaded'})
await page.waitForTimeout(3500)
const consent=page.getByText('Continue without consent',{exact:true});if(await consent.count())await consent.click()
const samples=[]
for(let n=0;n<6;n++){
 samples.push(await page.evaluate(()=>({time:performance.now(),scrollY:window.scrollY,rows:[...document.querySelectorAll('.frame-2939')].slice(0,4).map(e=>({text:e.textContent,top:e.getBoundingClientRect().top,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})),panel:[...document.querySelectorAll('.bloc-btc-roundups')].map(e=>({position:getComputedStyle(e).position,text:e.textContent,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))})))
 await page.waitForTimeout(350)
}
await page.screenshot({path:resolve(out,'bitstack-desktop.png')})
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(600)
await page.screenshot({path:resolve(out,'bitstack-mobile.png')})
writeFileSync(resolve(out,'bitstack-dom-samples.json'),JSON.stringify(samples,null,2))
console.log(samples.map(s=>({time:s.time,y:s.scrollY,top:s.rows[0]?.top,total:s.panel[0]?.text})))
await browser.close()
