import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {writeFileSync,readFileSync} from 'node:fs'
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const report={date:new Date().toISOString(),subject:'http://localhost:3113/',tabOrder:[],entry:{},contrast:[],zoom:{},notes:['No wallet connected, allowance signed or financial transaction sent.','Axe image/layer contrast incomplete findings need manual visual review; selected control and financial result additionally measured against actual solid backgrounds.']}
const context=await browser.newContext({viewport:{width:1440,height:900}})
const page=await context.newPage()
try{
 await page.goto(report.subject,{waitUntil:'networkidle'});await page.waitForTimeout(900)
 assert.equal(await page.locator('#landing-title').innerText(),'Small change.\nBigger moves.')
 for(let n=0;n<5;n++){await page.keyboard.press('Tab');report.tabOrder.push(await page.evaluate(()=>({tag:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label')||document.activeElement.textContent,value:document.activeElement.getAttribute('value')})))}
 assert.equal(report.tabOrder[0].label,'Skip to main content');assert.equal(report.tabOrder[4].value,'groceries')
 const hit=await page.locator('input[value="groceries"]').evaluate(e=>{const r=e.getBoundingClientRect();return {visibleFocus:e.matches(':focus-visible'),outline:getComputedStyle(e.closest('label')).outlineWidth,reachable:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e}})
 assert(hit.reachable&&hit.visibleFocus);assert.equal(hit.outline,'3px');report.keyboard=hit
 const colors=await page.locator('[data-section="03"]').evaluate(e=>{const selected=e.querySelector('label[data-selected="true"]');const name=selected.querySelector('span span');const small=selected.querySelector('small');const saved=e.querySelector('[data-lab-saved]');return [{name:'selected name',fg:getComputedStyle(name).color,bg:getComputedStyle(selected).backgroundColor},{name:'selected amount',fg:getComputedStyle(small).color,bg:getComputedStyle(selected).backgroundColor},{name:'saved amount',fg:getComputedStyle(saved).color,bg:getComputedStyle(saved.parentElement.parentElement).backgroundColor}]})
 const lum=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722}
 for(const color of colors){const values=[lum(color.fg),lum(color.bg)].sort((a,b)=>b-a);const ratio=(values[0]+.05)/(values[1]+.05);assert(ratio>=4.5);report.contrast.push({...color,ratio})}
 // A 720px layout viewport represents the reflow width of 1440px at 200% browser zoom.
 await page.setViewportSize({width:720,height:900});await page.waitForTimeout(600);report.zoom={method:'200% equivalent layout reflow width, not physical browser zoom',width:720,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)};assert.equal(report.zoom.overflow,false)
 await context.close()
 const preview=await browser.newContext({viewport:{width:1440,height:900}});const pp=await preview.newPage();await pp.goto(report.subject,{waitUntil:'networkidle'});await pp.waitForTimeout(800);await pp.locator('.landing-demo-link').click();await pp.waitForURL('**/home');await pp.waitForTimeout(800);const text=await pp.locator('body').innerText();report.entry.preview={url:pp.url(),simulated:/Simulated/.test(text),populated:await pp.locator('[aria-label="Total saved: $355.00"]').count()===1};assert(report.entry.preview.simulated&&report.entry.preview.populated);await preview.close()
 const start=await browser.newContext({viewport:{width:1440,height:900}});const sp=await start.newPage();await sp.goto(report.subject,{waitUntil:'networkidle'});await sp.waitForTimeout(800);await sp.locator('.landing-start-link').click();await sp.getByRole('button',{name:'Get Started',exact:true}).waitFor();report.entry.start={url:sp.url(),stepOneOfFive:await sp.locator('[aria-label="Step 1 of 5"]').count()===1,previewRedirect:sp.url().endsWith('/home')};console.log(report.entry.start);assert(report.entry.start.stepOneOfFive&&!report.entry.start.previewRedirect);await start.close()
 const axe=JSON.parse(readFileSync('out/task03c2a-style/audit/axe.json','utf8'));report.axeIncomplete=axe.incomplete.map(i=>({id:i.id,nodes:i.nodes.length}));writeFileSync('out/task03c2a-style/audit/interaction-contrast-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{await browser.close()}
