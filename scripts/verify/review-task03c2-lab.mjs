import {chromium} from 'playwright-core'
import {mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
const out=resolve('out/task03c2-review');mkdirSync(out,{recursive:true})
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:900}})
await page.goto('http://localhost:3000',{waitUntil:'networkidle'});await page.waitForTimeout(1000)
await page.locator('[data-section="03"]').evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+window.scrollY))
await page.waitForTimeout(600);await page.screenshot({path:resolve(out,'lab-desktop.png')})
await page.getByRole('radio',{name:'Coffee, $3.40 USDC',exact:true}).check();await page.waitForTimeout(600)
await page.screenshot({path:resolve(out,'lab-coffee.png')})
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500)
await page.locator('[data-section="03"]').evaluate(e=>window.scrollTo(0,e.getBoundingClientRect().top+window.scrollY))
await page.waitForTimeout(500);await page.screenshot({path:resolve(out,'lab-mobile.png')})
console.log(await page.locator('[data-section="03"]').innerText());await browser.close()
