import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=process.argv[2]||path.join(root,'release/mac-arm64/Tangent Canvas.app/Contents/MacOS/Tangent Canvas');
const proof=path.resolve(root,'../../work/tangent-live-proof/native-generated-image.png');
const errors=[];let application;
try{
  const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;delete environment.TANGENT_E2E;delete environment.TANGENT_TEST_CODEX_BINARY;
  application=await electron.launch({executablePath:executable,args:['--background'],env:environment});
  const page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.getByTestId('canvas-surface').waitFor();
  await expect.poll(async()=>page.evaluate(()=>window.tangent.invoke('app/connection')),{timeout:45000}).toMatchObject({connected:true,account:{type:'chatgpt'}});
  assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  const board=await page.evaluate(()=>window.tangent.invoke('board/create',{title:'Welcome to Tangent'}));
  await page.evaluate(()=>window.tangent.invoke('codex/settings',{model:'gpt-6.1-sol',effort:'low'}));
  const doc=await page.evaluate(({boardId})=>window.tangent.invoke('node/create',{boardId,kind:'document',title:'Keep the thread. Follow the tangent.',position:{x:650,y:75}}),{boardId:board.id});
  await page.evaluate(({boardId,nodeId,image})=>window.tangent.invoke('document/save',{boardId,nodeId,expectedRevision:1,markdown:`# Keep the thread. Follow the tangent.\n\n![A path with room to branch](${image})\n`}),{boardId:board.id,nodeId:doc.id,image:proof});
  const comment=await page.evaluate(({boardId,nodeId})=>window.tangent.invoke('document/ask',{boardId,nodeId,text:'Turn this page into a concise quick-start guide for Tangent, a canvas for Codex conversations. Keep its illustration inline. Add clear tips for branching from a reply, asking a side question without changing the main chat, importing an existing Codex chat as a separate copy, and generating images in a document. Use the canvas_document tool to update this same page. Under 150 words; no shell commands, web, or project file edits. Then reply with one short sentence.'}),{boardId:board.id,nodeId:doc.id});
  await expect.poll(async()=>page.evaluate(async({boardId,nodeId})=>(await window.tangent.invoke('app/state')).boards.find(b=>b.id===boardId).nodes.find(n=>n.id===nodeId).status,{boardId:board.id,nodeId:comment.id}),{timeout:180000,intervals:[250,500,1000]}).toBe('idle');
  const final=await page.evaluate(()=>window.tangent.invoke('app/state'));
  const b=final.boards.find(b=>b.id===board.id),document=b.nodes.find(n=>n.id===doc.id),chat=b.nodes.find(n=>n.id===comment.id);
  assert.ok(document.documentRevision>2,'Packaged Codex tool did not update document');assert.ok(document.documentMarkdown.includes('tangent-asset://'));assert.ok(chat.messages.some(m=>m.role==='assistant'));
  await page.evaluate(async({boardId,docId,chatId})=>{
    await window.tangent.invoke('node/update',{boardId,nodeId:chatId,title:'A quick tour with Codex',position:{x:60,y:75},width:480,height:700});
    await window.tangent.invoke('node/update',{boardId,nodeId:docId,position:{x:650,y:75},width:600,height:820});
    await window.tangent.invoke('board/update',{boardId,viewport:{x:10,y:10,zoom:.9}});
  },{boardId:board.id,docId:doc.id,chatId:comment.id});
  await page.getByTestId('fit-canvas').click();
  const img=page.getByTestId(`card-${doc.id}`).locator('img');await expect(img).toBeVisible();
  await expect.poll(async()=>img.evaluate(e=>({loaded:e.complete&&e.naturalWidth>0,width:e.naturalWidth}))).toMatchObject({loaded:true});
  await expect.poll(async()=>page.evaluate(async()=>(await window.tangent.invoke('app/state')).persistence.saving)).toBe(false);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.resolve(root,'../tangent-preview.png')});
  const dataPath=await application.evaluate(({app})=>app.getPath('userData'));
  const result={packaged:true,windowHidden:true,existingChatGPTSubscription:true,realCodexDocumentEdit:true,inlineGeneratedImageLoaded:true,rendererErrors:errors.length,dataPath,boardId:board.id};
  fs.writeFileSync(path.resolve(root,'../../work/tangent-package-proof.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}finally{await application?.close()}
