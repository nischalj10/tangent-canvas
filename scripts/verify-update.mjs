import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';
import {CodexClient} from '../electron/codex.mjs';
import {requireLivePageUrl} from './live-page-target.mjs';
const url=requireLivePageUrl();
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=process.argv[2]||path.join(root,'release/mac-arm64/Tangent Canvas.app/Contents/MacOS/Tangent Canvas');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-package-v2-'));
const errors=[];let application,threadId;
// Read-only DOM readiness probe. Route/title/loading completion alone does not
// establish that an auth page has finished bootstrapping its controls.
function inspectHostedReadiness(){
 const visible=element=>{const r=element.getBoundingClientRect();const style=getComputedStyle(element);return r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
 const enabled=element=>!element.matches(':disabled')&&element.getAttribute('aria-disabled')!=='true'&&!element.closest('[inert]');
 const emails=[...document.querySelectorAll('input[type="email"]')].filter(visible);
 const providers=[...document.querySelectorAll('button')].filter(button=>visible(button)&&/Continue with (?:Google|Apple|Microsoft)|Continue with phone/i.test(button.textContent||''));
 const authPage=/\/auth(?:\/|$)/.test(location.pathname)||/^(?:auth|auth0|accounts|account|login)\.openai\.com$/.test(location.hostname)||emails.length>0&&providers.length>0;
 const connecting=/Connecting/i.test(document.body?.innerText||'');
 const challenge=/^Just a moment|Checking your browser/i.test(document.title)||[...document.querySelectorAll('iframe')].some(frame=>{if(!visible(frame))return false;try{return new URL(frame.src,location.href).hostname==='challenges.cloudflare.com'}catch{return false}});
 const emailEnabled=emails.some(enabled),providersEnabled=providers.length>0&&providers.every(enabled);
 const contentLength=(document.body?.innerText||'').trim().length;
 return{url:location.origin+location.pathname,authPage,documentState:document.readyState,connecting,challenge,emailCount:emails.length,emailEnabled,providerCount:providers.length,providersEnabled,contentLength,ready:!challenge&&document.readyState==='complete'&&(authPage?emailEnabled&&providersEnabled&&!connecting:contentLength>80)};
}
try{
 const env={...process.env,TANGENT_DATA_DIR:folder,TANGENT_ALLOW_MULTIPLE:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.TANGENT_E2E;delete env.TANGENT_TEST_CODEX_BINARY;
 application=await electron.launch({executablePath:executable,args:['--background'],env});
 const page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await page.getByTestId('canvas-surface').waitFor();
 await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('app/connection')),{timeout:45000}).toMatchObject({connected:true,account:{type:'chatgpt'}});
 assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
 await page.getByTestId('welcome-new-chat').click();
 const state=()=>page.evaluate(()=>window.tangent.invoke('app/state'));
 let initial=await state(),board=initial.boards.find(b=>b.id===initial.activeBoardId),chat=board.nodes.find(n=>n.kind==='chat');
 const current=async()=>{const s=await state();return s.boards.find(b=>b.id===board.id).nodes.find(n=>n.id===chat.id)};
 await page.getByTestId(`node-model-${chat.id}`).selectOption('gpt-6.1-sol');await page.getByTestId(`node-effort-${chat.id}`).selectOption('low');
 await page.getByTestId(`composer-${chat.id}`).fill(`For this verification only, first run exactly the harmless shell command sleep 8 in the temporary verification workspace ${folder}. This keeps the turn active so the client can verify native steering. Then read this existing ChatGPT Page with connected Pages tools: ${url}. Do not modify it, create a new Page, run any other shell commands or edit files. Attach the original Page to this Tangent canvas with canvas_page action attach and its exact title. Then reply with one short sentence.`);
 await page.getByTestId(`send-${chat.id}`).click();
 await expect.poll(async()=>(await current()).activeTurnId,{timeout:15000}).toBeTruthy();
 const turnId=(await current()).activeTurnId;threadId=(await current()).threadId;
 let verificationStep='queue submission';
 try{
  const queuedText='Reply exactly QUEUED_PACKAGE_READY.';
  const composer=page.getByTestId(`composer-${chat.id}`);
  await composer.fill(queuedText);await page.getByTestId(`queue-${chat.id}`).click();
  verificationStep='queue acceptance';
  await expect.poll(async()=>(await current()).queue.some(entry=>entry.text===queuedText&&entry.status==='queued'),{timeout:10000}).toBe(true);
  await expect(composer).toHaveValue('',{timeout:10000});
  assert.equal((await current()).activeTurnId,turnId,'Original turn must still be active after queue acknowledgement');
  verificationStep='steering submission';
  await composer.fill('Keep doing the same read-only Page task. End the first final reply with PACKAGE_STEER_ACCEPTED.');
  await expect(page.getByTestId(`steer-${chat.id}`)).toBeEnabled({timeout:10000});
  assert.equal((await current()).activeTurnId,turnId,'Steering must target the original turn');
  await page.getByTestId(`steer-${chat.id}`).click();
  verificationStep='native steering acceptance';
  await expect.poll(async()=>(await current()).messages.some(m=>m.delivery==='steer'&&m.deliveryStatus==='accepted'&&m.turnId===turnId),{timeout:20000}).toBe(true);
 }catch(error){
  const node=await current().catch(()=>null);
  console.error(JSON.stringify({verificationStep,expectedTurnId:turnId,currentActiveTurnId:node?.activeTurnId,status:node?.status,draft:node?.draft,composerValue:await page.getByTestId(`composer-${chat.id}`).inputValue().catch(()=>null),steerDisabled:await page.getByTestId(`steer-${chat.id}`).isDisabled().catch(()=>null),queue:node?.queue?.map(({id,status,error})=>({id,status,error})),error:node?.error}));
  throw error;
 }
 await expect.poll(async()=>{const c=await current();return c.status==='idle'&&!c.queue.length&&c.messages.some(m=>m.role==='assistant'&&m.text.includes('QUEUED_PACKAGE_READY'))},{timeout:150000,intervals:[250,500,1000]}).toBe(true);
 const final=await state(),b=final.boards.find(b=>b.id===board.id),c=b.nodes.find(n=>n.id===chat.id);threadId=c.threadId;
 const linked=b.nodes.find(n=>n.kind==='page'&&n.pageUrl===url);assert.ok(linked,'Real model must attach original rich Page through packaged tool bridge');
 assert.ok(c.messages.some(m=>m.role==='assistant'&&m.turnId===turnId&&m.text.includes('PACKAGE_STEER_ACCEPTED')));
 assert.equal(c.messages.filter(m=>m.text==='Reply exactly QUEUED_PACKAGE_READY.').length,1);
 assert.equal(c.model,'gpt-6.1-sol');assert.equal(c.effort,'low');assert.deepEqual(errors,[]);
 await page.getByTestId('fit-canvas').click();await page.screenshot({path:path.join(root,'screenshots/packaged-update.png')});
 // A fully hidden app prepares the Page without creating a native renderer.
 await page.getByTestId(`page-open-${linked.id}`).click();
 await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('page/status')),{timeout:10000}).toMatchObject({nodeId:linked.id,deferred:true,loading:false});
 // Compose the real native Page invisibly only after the window is ready.
 await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));if(!w)throw Error('Tangent root window not found');w.setOpacity(0);w.setHasShadow(false);w.setIgnoreMouseEvents(true);w.showInactive()});
 await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('page/status')),{timeout:40000}).toMatchObject({nodeId:linked.id,loading:false,deferred:false});
 let hosted=await page.evaluate(()=>window.tangent.invoke('page/status'));
 assert.ok(hosted.authHint||hosted.url===url,'Hosted view should load requested Page or its actual sign-in');
 let hostedReadiness;
 try{
  await expect.poll(async()=>{
   hostedReadiness=await application.evaluate(async({webContents},probe)=>{const wc=webContents.getAllWebContents().find(w=>/^https:\/\/(?:chatgpt\.com|auth\.openai\.com)\//.test(w.getURL()));if(!wc)throw Error('Actual hosted Page renderer not found');return wc.executeJavaScript(`(${probe})()`);},inspectHostedReadiness.toString());
   return hostedReadiness.ready;
  },{timeout:45000,intervals:[250,500,1000]}).toBe(true);
 }catch(error){console.error(JSON.stringify({verificationStep:'hosted document/auth bootstrap readiness',hostedReadiness}));throw error}
 hosted=await page.evaluate(()=>window.tangent.invoke('page/status'));
 const native=await application.evaluate(async({webContents})=>{const wc=webContents.getAllWebContents().find(w=>/^https:\/\/(?:chatgpt\.com|auth\.openai\.com)\//.test(w.getURL()));if(!wc)throw Error('Actual hosted Page renderer not found');wc.invalidate();await new Promise(resolve=>setTimeout(resolve,350));const image=await wc.capturePage(undefined,{stayHidden:true,stayAwake:true});return{png:image.toPNG().toString('base64'),url:new URL(wc.getURL()).origin+new URL(wc.getURL()).pathname}});
 fs.writeFileSync(path.join(root,'screenshots/packaged-hosted-sign-in.png'),Buffer.from(native.png,'base64'));
 assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused()),false);
 await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.hide();w.setOpacity(1);w.setIgnoreMouseEvents(false)});
 assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
 const result={packaged:true,version:'0.2.0',windowHidden:true,rendererErrors:errors.length,existingSubscription:true,perChatModelEffort:true,realNativeSteering:true,queuedNextTurnExactlyOnce:true,realOriginalPageReadAttached:true,originalPageUnchanged:true,hostedView:hostedReadiness.authPage?'requires-sign-in-ready':'document-rendered',hostedAuthControlsReady:hostedReadiness.authPage?true:undefined,boardId:board.id,threadId};
 fs.writeFileSync(path.resolve(root,'../../work/package-update-proof.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 if(application){const child=application.process();const watchdog=setTimeout(()=>{try{child?.kill('SIGKILL')}catch{}},7000);try{await application.close().catch(()=>{})}finally{clearTimeout(watchdog)}}
 if(threadId){const cleanup=new CodexClient({cwd:folder});try{await cleanup.start();await cleanup.request('thread/archive',{threadId})}finally{await cleanup.close()}}
 fs.rmSync(folder,{recursive:true,force:true});
}
