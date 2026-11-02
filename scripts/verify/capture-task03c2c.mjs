import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {mkdirSync,writeFileSync,statSync,unlinkSync} from 'node:fs'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
const BASE=process.env.MOVY_CAPTURE_BASE||'http://localhost:3117',OUT=resolve('out/task03c2c')
for(const f of ['screenshots','videos','audit'])mkdirSync(resolve(OUT,f),{recursive:true})
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
const report={base:BASE,date:new Date().toISOString(),screenshots:[],videos:[],errors:[],layouts:[],stack:[],keyboard:[],mobile:[],fallback:[],entries:[],axe:[],copy:[]}
async function ready(p){p.on('pageerror',e=>report.errors.push(e.message));p.on('console',m=>{if(m.type()==='error')report.errors.push(m.text())});await p.goto(BASE,{waitUntil:'networkidle'});assert.equal(new URL(p.url()).origin,new URL(BASE).origin);assert((await p.title()).includes('MOVY'));await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(1200)}
async function scroll(p,y,wait=450){await p.evaluate(y=>scrollTo(0,y),y);await p.waitForTimeout(wait)}
const top=(p,s)=>p.locator(`[data-section="${s}"]`).evaluate(e=>e.getBoundingClientRect().top+scrollY)
async function shot(p,name,section){const options={path:resolve(OUT,'screenshots',name+'.png')};if(section){const r=await p.locator(`[data-section="${section}"]`).evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height}});options.fullPage=true;options.clip=r}await p.screenshot(options);report.screenshots.push(name+'.png')}
async function metrics(p,width){const r=await p.evaluate(()=>{
 const hero=document.querySelector('[data-section="01"]'),feed=document.querySelector('[data-section="02"]'),stack=document.querySelector('[data-section="03"]'),h=hero.getBoundingClientRect(),f=feed.getBoundingClientRect()
 const text=[document.querySelector('.landing-nav').innerText,hero.innerText,feed.innerText,stack.innerText].join('\n')
 return {url:location.href,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,heroPinned:!!hero.closest('.pin-spacer'),heroTop:h.top+scrollY,heroBottom:h.bottom+scrollY,feedTop:f.top+scrollY,heroText:hero.innerText,copy:text,mode:stack.dataset.enhanced||stack.dataset.mobile||'static',cards:stack.querySelectorAll('[data-scenario]').length,styles:[hero.querySelector('h1'),stack.querySelector('h2'),stack.querySelector('[data-scenario]'),stack.querySelector('strong')].map(e=>{const s=getComputedStyle(e);return {element:e.tagName,font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,color:s.color,background:s.backgroundColor,radius:s.borderRadius}}),buttons:[...hero.querySelectorAll('button'),...stack.querySelectorAll('button')].filter(e=>getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0).map(e=>({name:e.getAttribute('aria-label')||e.innerText,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}))}
 });assert.equal(r.viewport,width);assert(!r.overflow);assert(!r.heroPinned);assert(r.feedTop>=r.heroBottom-1);assert.equal(r.cards,4);assert(!/\$|Emergency|sanctuary/i.test(r.heroText));assert(!/—|ARC TESTNET|testnet|Interactive example|No wallet|No funds|HOW MOVY WORKS|TRY IT YOURSELF|Demo requires|\b0[123]\b/i.test(r.copy));assert(r.buttons.every(b=>b.w>=44&&b.h>=44));report.copy.push({width,forbidden:[],allowedInternalIdentifiers:['data-section=01','data-section=02','data-section=03']});report.layouts.push({width,...r})}
async function geometry(p){return p.locator('[data-section="03"]').evaluate(e=>({top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height,position:getComputedStyle(e).position,scroll:scrollY,mode:e.dataset.enhanced||e.dataset.mobile||'static',track:e.querySelector('ol').scrollLeft,cards:[...e.querySelectorAll('[data-scenario]')].map(c=>{const r=c.getBoundingClientRect(),style=getComputedStyle(c);return {id:c.dataset.scenario,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,opacity:style.opacity,transform:style.transform,z:style.zIndex,text:c.innerText}})}))}
async function contentFits(p,index){const r=await p.locator('[data-scenario]').nth(index).evaluate(c=>{const b=c.getBoundingClientRect();return [...c.querySelectorAll('h3,dt,dd,strong')].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,fits:r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1}})});assert(r.every(e=>e.fits),JSON.stringify(r))}
async function desktop(p,width){const start=await top(p,'03'),distance=(await p.evaluate(()=>innerHeight))*2.4
 const fractions=[0,.29,.59,.89]
 for(let i=0;i<4;i++){await scroll(p,start+distance*fractions[i]);const g=await geometry(p);assert(Math.abs(g.cards[i].left-g.cards[0].left-(i?22*i:0))<4||i===0);assert(g.cards.every(c=>c.opacity==='1'));assert(g.cards[i].right<=width+1);assert(g.cards[i].top>=0);assert(g.cards[i].bottom<=(await p.evaluate(()=>innerHeight))+1);if(i===0)assert(g.cards.slice(1).every(c=>c.left>=width));if(i>0){for(let j=0;j<i;j++)assert(g.cards[j].left<g.cards[j+1].left,'prior edge remains visible')}
  await contentFits(p,i);report.stack.push({width,state:i+1,...g});await shot(p,`section03-${width}-card${i+1}`)
 }
 const before=JSON.stringify((await geometry(p)).cards.map(c=>c.transform));await p.waitForTimeout(600);assert.equal(JSON.stringify((await geometry(p)).cards.map(c=>c.transform)),before);await scroll(p,start);assert((await geometry(p)).cards[1].left>=width)
 await scroll(p,start+distance+64);const exit=await geometry(p);assert(exit.top<0);assert.notEqual(exit.position,'fixed');report.stack.push({width,state:'release',...exit});const h=Math.min(await p.evaluate(()=>innerHeight),Math.floor(exit.top+exit.height));await p.screenshot({path:resolve(OUT,'screenshots',`section03-${width}-exit.png`),clip:{x:0,y:0,width,height:h}});report.screenshots.push(`section03-${width}-exit.png`)
}
async function mobile(p,width){const start=await top(p,'03');await scroll(p,start);assert.equal((await geometry(p)).mode,'snap');await shot(p,`section03-${width}-first`)
 const list=p.locator('[data-section="03"] ol');const first=await list.evaluate(e=>({left:e.scrollLeft,width:e.clientWidth,next:e.children[1].getBoundingClientRect().left}));assert(first.next<width&&first.next>width*.65,'next card peeks')
 // Actual touch input on the visible image, not a programmatic scroll substitute.
 const box=await list.boundingBox(),session=await p.context().newCDPSession(p),y=Math.min((await p.evaluate(()=>innerHeight))-100,box.y+100)
 const initialY=await p.evaluate(()=>scrollY)
 await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width-60,y}]})
 for(let x=width-60;x>=40;x-=22){await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});await p.waitForTimeout(18)}
 await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(700);assert((await list.evaluate(e=>e.scrollLeft))>100);assert(Math.abs((await p.evaluate(()=>scrollY))-initialY)<3)
 await shot(p,`section03-${width}-swipe`)
 for(let i=0;i<2;i++){await p.getByRole('button',{name:'Next scenario',exact:true}).click();await p.waitForTimeout(650)}
 const g=await geometry(p);assert(g.cards[3].left>=0&&g.cards[3].left<50);assert(g.cards[3].right<=width+1);await contentFits(p,3);await shot(p,`section03-${width}-later`,'03')
 await p.getByRole('button',{name:'Previous scenario',exact:true}).click();await p.waitForTimeout(650);const before=await list.evaluate(e=>e.scrollLeft);await p.locator('[data-scenario="gaming"]').focus();await p.keyboard.press('ArrowLeft');await p.waitForTimeout(650);assert((await list.evaluate(e=>e.scrollLeft))<before)
 report.mobile.push({width,swipe:true,verticalStable:true,next:true,previous:true,arrow:true,pinned:false,...g})
 const bottom=await p.locator('[data-section="03"]').evaluate(e=>e.getBoundingClientRect().bottom+scrollY);await scroll(p,bottom-(await p.evaluate(()=>innerHeight))+48);const end=await geometry(p);assert(end.top<0);await p.screenshot({path:resolve(OUT,'screenshots',`section03-${width}-exit.png`),clip:{x:0,y:0,width,height:Math.floor(end.top+end.height)}});report.screenshots.push(`section03-${width}-exit.png`)
}
for(const width of [1440,320,390,900,1920]){
 const height=width===320?568:width===390?844:width===1440?900:1080,c=await browser.newContext({viewport:{width,height},isMobile:width<900,hasTouch:width<900}),p=await c.newPage();await ready(p);await metrics(p,width);await shot(p,`hero-${width}-settled`)
 const feedTop=await top(p,'02');await scroll(p,feedTop-100);await shot(p,`hero-${width}-exit`);await scroll(p,feedTop);await shot(p,`section02-${width}-initial`)
 if(width>=900)await scroll(p,feedTop+1790);else{const h=await p.locator('[data-section="02"]').evaluate(e=>e.clientHeight);await scroll(p,feedTop+h-height)}
 assert.equal(await p.locator('[data-feed-total] > span > span:first-child').textContent(),'$2.40');await shot(p,`section02-${width}-accumulated`)
 if(width>=900)await desktop(p,width);else await mobile(p,width)
 await c.close()
}
// Real Tab navigation must reveal each desktop scenario and its visible focus ring.
{const c=await browser.newContext({viewport:{width:1440,height:900}}),p=await c.newPage();await ready(p);let seen=[]
 for(let n=0;n<12&&seen.length<4;n++){await p.keyboard.press('Tab');await p.waitForTimeout(160);const f=await p.evaluate(()=>{const e=document.activeElement,r=e.getBoundingClientRect();return {id:e.getAttribute('data-scenario'),name:e.getAttribute('aria-label')||e.textContent,focus:e.matches(':focus-visible'),outline:getComputedStyle(e).outlineWidth,left:r.left,right:r.right,top:r.top}});if(f.id){assert(f.focus);assert(parseFloat(f.outline)>=3);assert(f.left>=0&&f.right<=1441);seen.push(f.id);report.keyboard.push(f)}}
 assert.deepEqual(seen,['vpn','travel','gaming','accessory']);await shot(p,'section03-1440-keyboard');await c.close()}
for(const width of [1440,390])for(const mode of ['reduce','no-js']){
 const c=await browser.newContext({viewport:{width,height:width===390?844:900},reducedMotion:mode==='reduce'?'reduce':'no-preference',javaScriptEnabled:mode!=='no-js'}),p=await c.newPage();await ready(p);await metrics(p,width);await shot(p,`hero-${width}-${mode}`)
 await scroll(p,await top(p,'03'));const g=await geometry(p);assert.equal(g.mode,'static');assert(g.cards.every((r,i)=>!i||r.top>=g.cards[i-1].bottom));assert(!await p.locator('[data-section="03"]').evaluate(e=>!!e.closest('.pin-spacer')));await shot(p,`section03-${width}-${mode}`,'03');report.fallback.push({width,mode,...g})
 if(mode==='reduce'){await p.addScriptTag({url:'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js'});const axe=await p.evaluate(()=>window.axe.run({include:[['.landing-nav'],['[data-section="01"]'],['[data-section="02"]'],['[data-section="03"]']]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));writeFileSync(resolve(OUT,'audit',`axe-${width}.json`),JSON.stringify(axe,null,2));assert.equal(axe.violations.length,0);report.axe.push({width,version:axe.testEngine.version,violations:axe.violations.length,incomplete:axe.incomplete.map(v=>({id:v.id,nodes:v.nodes.length}))})}
 await c.close()
}
for(const action of ['Explore Demo','Start Saving']){const c=await browser.newContext({viewport:{width:390,height:844}}),p=await c.newPage();await ready(p);await p.locator('[data-section="01"]').getByRole('button',{name:action}).click();await p.waitForTimeout(1000);if(action==='Explore Demo'){assert.equal(new URL(p.url()).pathname,'/home');assert((await p.locator('body').innerText()).includes('Simulated'))}else assert(await p.locator('[aria-label="Step 1 of 6"]').count());report.entries.push({action,url:p.url(),passed:true});await c.close()}
async function record(width){const height=width===390?844:900,c=await browser.newContext({viewport:{width,height},recordVideo:{dir:resolve(OUT,'videos/raw'),size:{width,height}},isMobile:width===390,hasTouch:width===390}),p=await c.newPage();await ready(p);const start=await top(p,'03'),end=width>=900?start+height*2.4+64:start
 for(let i=0;i<=230;i++)await scroll(p,end*i/230,65)
 if(width===390){for(let i=0;i<3;i++){await p.getByRole('button',{name:'Next scenario',exact:true}).click();await p.waitForTimeout(900)}const bottom=await p.locator('[data-section="03"]').evaluate(e=>e.getBoundingClientRect().bottom+scrollY);await scroll(p,bottom-height+48,500)}
 await p.waitForTimeout(600);const video=p.video();await c.close();const file=`hero-feed-stacked-scenarios-${width}.webm`;await video.saveAs(resolve(OUT,'videos',file));await video.delete();report.videos.push({file,width,height,bytes:statSync(resolve(OUT,'videos',file)).size})}
// Fresh-load entrance frame, then raw recordings including the one-time entrance.
{const c=await browser.newContext({viewport:{width:1440,height:900}}),p=await c.newPage();await p.goto(BASE,{waitUntil:'domcontentloaded'});await p.waitForTimeout(180);await shot(p,'hero-1440-entrance');await c.close()}
await record(1440);await record(390)
const ffmpeg=resolve(process.env.LOCALAPPDATA,'ms-playwright/ffmpeg-1011/ffmpeg-win64.exe')
for(const v of report.videos){const path=resolve(OUT,'videos',v.file),decode=path+'.decode.webm',r=spawnSync(ffmpeg,['-y','-i',path,'-c:v','libvpx','-deadline','realtime','-cpu-used','8',decode],{encoding:'utf8'});assert.equal(r.status,0);unlinkSync(decode);v.decoded=true;v.metadata=r.stderr.match(/Duration: ([^,]+).*?[\s\S]*?Video: ([^\n]+)/)?.slice(1)
 for(const t of [0.3,5,10,13,16,19])assert.equal(spawnSync(ffmpeg,['-y','-ss',String(t),'-i',path,'-frames:v','1','-update','1',resolve(OUT,'videos',`${v.width}-frame-${t}.png`)],{encoding:'utf8'}).status,0)
}
assert.equal(report.errors.length,0);writeFileSync(resolve(OUT,'audit/browser-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({screenshots:report.screenshots.length,videos:report.videos,errors:report.errors,axe:report.axe,mobile:report.mobile.map(m=>({width:m.width,mode:m.mode,swipe:m.swipe,pinned:m.pinned}))},null,2));await browser.close()
