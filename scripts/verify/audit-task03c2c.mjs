import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {writeFileSync} from 'node:fs'
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}),results=[]
for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:width===390?844:900},reducedMotion:'reduce'}),page=await context.newPage()
 await page.goto('http://localhost:3117/',{waitUntil:'networkidle'});await page.addScriptTag({url:'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js'})
 const selectors=['[data-section="01"]','[data-section="02"] header',...Array.from({length:4},(_,i)=>`[data-payment]:nth-child(${i+1})`),'[data-destination]',...['vpn','travel','gaming','accessory'].map(id=>`[data-scenario="${id}"]`)]
 for(const selector of selectors){await page.locator(selector).scrollIntoViewIfNeeded();const result=await page.evaluate(selector=>window.axe.run({include:[[selector]]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}),selector);assert.equal(result.violations.length,0);results.push({width,selector,violations:result.violations,incomplete:result.incomplete.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))})}
 await context.close()
}
// Real resize crosses matchMedia branches and then returns to the desktop stage.
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();await page.goto('http://localhost:3117/',{waitUntil:'networkidle'})
const modes=[]
for(const width of [1440,390,1920]){await page.setViewportSize({width,height:900});await page.waitForTimeout(500);const state=await page.locator('[data-section="03"]').evaluate(e=>({mode:e.dataset.enhanced||e.dataset.mobile,pinCount:document.querySelectorAll('.pin-spacer [data-section="03"]').length}));assert.equal(state.mode,width<900?'snap':'desktop');assert.equal(state.pinCount,width<900?0:1);modes.push({width,...state})}
await context.close();await browser.close();writeFileSync('out/task03c2c/audit/focused-accessibility-lifecycle.json',JSON.stringify({date:new Date().toISOString(),results,modes},null,2));console.log(JSON.stringify({states:results.length,incomplete:results.filter(r=>r.incomplete.length),modes},null,2))
