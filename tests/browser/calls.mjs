const {chromium}=await import(process.env.WIHM_PLAYWRIGHT_MODULE||'playwright-core');
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const directory='.wrangler/calls-browser-qa';await mkdir(directory,{recursive:true});
async function checkLayout(page, label) {
 const layout=await page.locator('dialog').evaluate(dialog=>{const r=dialog.getBoundingClientRect(),s=getComputedStyle(dialog);return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,color:s.color};});
 await page.screenshot({path:`${directory}/${label}.png`});
 console.log(label,JSON.stringify(layout));
 assert.ok(Math.abs(layout.x+layout.width/2-layout.viewportWidth/2)<=1,'Call dialog must be horizontally centered');
 assert.ok(Math.abs(layout.y+layout.height/2-layout.viewportHeight/2)<=1,'Call dialog must be vertically centered');
 assert.ok(layout.x>=0&&layout.y>=0&&layout.x+layout.width<=layout.viewportWidth&&layout.y+layout.height<=layout.viewportHeight,'Call dialog must stay inside the viewport');
 assert.equal(layout.color,'rgb(248, 250, 252)','Native dialog must use the app text color');
}
const browser=await chromium.launch({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],...(process.env.WIHM_CHROME_PATH?{executablePath:process.env.WIHM_CHROME_PATH}:{})}),contexts=[],pages=[],errors=[];
try{
 for(let i=0;i<2;i++){
  const context=await browser.newContext({permissions:['microphone','camera'],viewport:{width:i?375:1280,height:850}});contexts.push(context);
  await context.route('https://calls.network.workers.dev/**',async route=>{const path=new URL(route.request().url()).pathname;await route.fulfill({contentType:path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8',body:path.endsWith('.js')?await readFile('public/calls.js'):path.endsWith('.css')?await readFile('public/style.css'):'<!doctype html><html dir="rtl"><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="mount"></div><p id="status"></p><script src="/calls.js"></script></html>'});});
  const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.exposeFunction('relay',data=>pages[1-i].evaluate(data=>controller.receive(data),{...data,event:'call_signal',from:i?'bob':'alice',expiresAt:Date.now()+900000}));
  await page.goto('https://calls.network.workers.dev');
  await page.evaluate(i=>{const NativePeer=RTCPeerConnection;window.RTCPeerConnection=class extends NativePeer{constructor(options){super({...options,iceServers:[]});}};window.peers=[];const LocalPeer=RTCPeerConnection;window.RTCPeerConnection=class extends LocalPeer{constructor(options){super(options);peers.push(this);}};window.tracks=[];const media=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{const stream=await media(options);tracks.push(...stream.getTracks());return stream;};window.controller=WihmCalls.create({getChat:()=>({id:'test-dm',type:'dm'}),getUser:()=>({id:i?'bob':'alice'}),send:data=>relay(data),mount:document.getElementById('mount'),notify:text=>document.getElementById('status').textContent=text});},i);
  assert.equal(await page.locator('dialog').isVisible(),false,'Closed dialog must not leak into the page');
 }
 const [a,b]=pages;await a.evaluate(()=>controller.start(false));await b.locator('dialog').waitFor({state:'visible'});
 for(const [i,page]of pages.entries()){await checkLayout(page,`audio-ringing-${i}`);assert.equal(await page.locator('dialog video:visible').count(),0,'Voice calls must not show empty video players');}
 assert.equal(await b.evaluate(()=>tracks.length),0,'No capture before accepting');await b.locator('.call-accept').click();
 for(const page of pages)await page.waitForFunction(()=>[...document.querySelectorAll('dialog p')].some(p=>p.textContent.startsWith('تماس برقرار است.')),{},{timeout:30000});
 for(const page of pages)await page.waitForFunction(async()=>{for(const p of peers)for(const report of (await p.getStats()).values())if(report.type==='inbound-rtp'&&report.kind==='audio'&&report.bytesReceived>0)return true;return false;},{},{timeout:15000});
 for(const page of pages){assert.equal(await page.locator('dialog audio').evaluate(audio=>!!audio.srcObject),true,'Connected voice call must play the remote audio stream');assert.equal(await page.locator('.call-speaker').isVisible(),true);assert.equal(await page.locator('dialog video:visible').count(),0);}
 await a.evaluate(()=>controller.reset());for(const page of pages){await page.waitForFunction(()=>!controller.active()&&tracks.every(t=>t.readyState==='ended'));assert.equal(await page.locator('dialog').isVisible(),false);}
 await b.setViewportSize({width:375,height:480});await a.evaluate(()=>controller.start(true));await b.locator('dialog').waitFor({state:'visible'});
 for(const [i,page]of pages.entries())await checkLayout(page,`video-ringing-${i}`);
 await b.getByRole('button',{name:'رد تماس',exact:true}).click();for(const page of pages)await page.waitForFunction(()=>!controller.active());
 assert.deepEqual(errors,[]);await writeFile(directory+'/results.json',JSON.stringify({passed:true,nativeWebRTC:true,syntheticMicrophone:true,physicalDevicesChecked:false,directLocalICE:true,consent:true,remoteAudioBytes:true,hangupStopsTracks:true,closedDialogHidden:true,centeredDialog:true,audioPlayer:true,shortViewport:true,errors},null,2));console.log('Native WebRTC browser test passed with synthetic devices.');
}catch(e){for(const [i,page]of pages.entries())console.log(JSON.stringify({i,text:await page.locator('body').innerText(),state:await page.evaluate(()=>({tracks:tracks.map(t=>({kind:t.kind,state:t.readyState})),peers:peers.map(p=>({connection:p.connectionState,ice:p.iceConnectionState,local:p.localDescription?.type,remote:p.remoteDescription?.type}))}))}));throw e;}finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
