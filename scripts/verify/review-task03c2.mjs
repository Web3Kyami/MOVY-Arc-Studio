import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const out = resolve('out/task03c2-review'); mkdirSync(out, { recursive: true })
const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const context=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:out,size:{width:1440,height:900}}})
const page = await context.newPage()
const errors=[]; page.on('pageerror',e=>errors.push(e.message))
await page.goto('http://localhost:3000',{waitUntil:'networkidle'}); await page.waitForTimeout(1200)
const section=page.locator('[data-section="02"]')
await section.scrollIntoViewIfNeeded(); await page.waitForTimeout(800)
const top=await section.evaluate(e=>e.getBoundingClientRect().top+window.scrollY)
for(const [name,offset] of [['initial',0],['mid',950],['late',1750]]){
 await page.evaluate(y=>window.scrollTo(0,y),top+offset); await page.waitForTimeout(900)
 await page.screenshot({path:resolve(out,`feed-${name}.png`)})
 console.log(name,await page.locator('[data-feed-total]').innerText())
}
await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(500)
await section.scrollIntoViewIfNeeded(); await page.waitForTimeout(700)
await page.screenshot({path:resolve(out,'feed-mobile.png')})
await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(500)
await page.evaluate(y=>window.scrollTo(0,y),top); await page.waitForTimeout(600)
for(let i=0;i<=90;i++){await page.evaluate(y=>window.scrollTo(0,y),top+i*22);await page.waitForTimeout(60)}
writeFileSync(resolve(out,'errors.json'),JSON.stringify(errors,null,2)); console.log({errors})
await context.close();await page.video().saveAs(resolve(out,'feed-review.webm'))
await browser.close()
