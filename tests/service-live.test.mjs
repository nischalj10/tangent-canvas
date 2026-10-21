import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CanvasStore } from '../electron/store.mjs';
import { CanvasService } from '../electron/service.mjs';
import { CodexClient } from '../electron/codex.mjs';
import { DocumentMcpBridge } from '../electron/document-mcp.mjs';
import { DOCUMENT_TOOL } from '../electron/documents.mjs';

const live=process.env.TANGENT_LIVE_SERVICE==='1';
async function setup(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-service-live-'));
  const runtime=new CodexClient({cwd:directory});const store=new CanvasStore(directory);const service=new CanvasService(store,runtime);
  const bridge=new DocumentMcpBridge({tools:[DOCUMENT_TOOL],onToolCall:(context,name,args)=>service.documentToolForContext(context,name,args)});
  await bridge.start();service.documentBridge=bridge;await service.connect();
  assert.equal(service.connection.account?.type,'chatgpt');assert.ok(service.connection.connected);
  const model=service.connection.models.find(m=>m.model==='gpt-6.1-sol')||service.connection.models.find(m=>m.isDefault);
  await service.invoke('codex/settings',{model:model.model,effort:'low'});
  t.after(async()=>{
    for(const board of store.state.boards)for(const node of board.nodes)if(node.threadId){try{await runtime.request('thread/archive',{threadId:node.threadId})}catch{}}
    await service.close();fs.rmSync(directory,{recursive:true,force:true});
  });
  return{runtime,store,service,board:store.state.boards[0]};
}
async function done(node,timeout=180000){
  const start=Date.now();while(Date.now()-start<timeout){if(['idle','error','interrupted'].includes(node.status)){
    assert.equal(node.status,'idle',node.error||`Unexpected status ${node.status}`);return node;
  }await new Promise(r=>setTimeout(r,100))}throw Error('Live canvas turn timed out');
}
const assistant=node=>node.messages.filter(m=>m.role==='assistant').at(-1)?.text||'';

test('LIVE full service: on-canvas historical comment auto-replies and parent stays isolated',{skip:!live,timeout:300000},async t=>{
  const{store,service,board}=await setup(t);
  const created=await service.invoke('node/create',{boardId:board.id,kind:'chat'});const main=board.nodes.find(n=>n.id===created.id);
  await service.invoke('node/send',{boardId:board.id,nodeId:main.id,text:'Use no tools or files. Remember main_marker=MARBLE-83. Reply exactly: Main marker MARBLE-83.'});await done(main);
  const first=main.messages.find(m=>m.role==='assistant');assert.ok(first.turnId);
  await service.invoke('node/send',{boardId:board.id,nodeId:main.id,text:'Use no tools or files. Remember main_marker=ORBIT-29. Reply exactly: Main marker ORBIT-29.'});await done(main);
  const childResult=await service.invoke('node/branch',{boardId:board.id,nodeId:main.id,messageId:first.id,kind:'comment',quote:'Main marker MARBLE-83.',text:'Use no tools or files. List every main_marker value in your context. Then remember side_marker=BRONZE-61. Reply briefly.'});
  const child=board.nodes.find(n=>n.id===childResult.id);await done(child);
  assert.notEqual(child.threadId,main.threadId);assert.match(assistant(child),/MARBLE-83/);assert.ok(!assistant(child).includes('ORBIT-29'));
  await service.invoke('node/send',{boardId:board.id,nodeId:main.id,text:'Use no tools or files. List every side_marker value you can see in this conversation. If there is none reply exactly NONE. Do not guess.'});await done(main);
  assert.match(assistant(main),/^NONE[.!]?$/);assert.equal(board.edges.length,1);
  store.flush();const reopened=new CanvasStore(store.directory);assert.equal(reopened.state.boards[0].nodes.length,2);
});

test('LIVE full service: native image generation creates a durable editable illustrated document',{skip:!live,timeout:300000},async t=>{
  const{store,service,board}=await setup(t);
  const created=await service.invoke('node/create',{boardId:board.id,kind:'chat'});const node=board.nodes.find(n=>n.id===created.id);
  await service.invoke('node/send',{boardId:board.id,nodeId:node.id,text:'Create a small illustrated document on my canvas. First use native image generation to make one square, minimal lavender illustration of a path branching into two peaceful directions; no text. Then use the canvas_document tool to create a document titled "Room for a tangent" with a heading, two short paragraphs about exploring side questions while keeping a main conversation focused, and the generated image embedded inline using its saved path. Do not run shell commands, use the web, or edit project files. Finish with one short sentence.'});
  await done(node,240000);
  assert.ok(node.generatedImages?.length,'No native generated image captured');
  const doc=board.nodes.find(n=>n.kind==='document');assert.ok(doc,'Agent did not create its document');assert.match(doc.documentMarkdown,/tangent-asset:\/\/[a-f0-9]{64}\.png/);
  const asset=node.generatedImages[0];assert.ok(fs.existsSync(service.assets.path(asset.id)));assert.ok(fs.statSync(service.assets.path(asset.id)).size>1000);
  assert.ok(!JSON.stringify(store.state).includes('data:image/'),'Base64 leaked into canvas state');
  const original=doc.documentMarkdown;
  service.saveDocument({boardId:board.id,nodeId:doc.id,markdown:original+'\n\nUser edit persisted.',expectedRevision:doc.documentRevision});
  const reopened=new CanvasStore(store.directory);assert.match(reopened.state.boards[0].nodes.find(n=>n.id===doc.id).documentMarkdown,/User edit persisted/);
  const proof=process.env.TANGENT_LIVE_PROOF_DIR;
  if(proof){fs.mkdirSync(proof,{recursive:true});fs.copyFileSync(service.assets.path(asset.id),path.join(proof,'native-generated-image.png'));fs.writeFileSync(path.join(proof,'illustrated-document.md'),doc.documentMarkdown);fs.writeFileSync(path.join(proof,'live-proof.json'),JSON.stringify({nativeImage:true,editableDocument:true,provider:service.connection.account.type,model:service.connection.model,assetBytes:fs.statSync(service.assets.path(asset.id)).size},null,2))}
});
