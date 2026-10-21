import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { CanvasStore } from '../electron/store.mjs';
import { CanvasService } from '../electron/service.mjs';
import { threadMessages } from '../electron/codex.mjs';
import { repairImageBindings } from '../electron/inline-images.mjs';

const DATA='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
class Runtime extends EventEmitter {
  calls=[];threads=new Map();
  async start(){return {connected:true,model:'test',effort:'low',models:[{id:'test',model:'test'}]}}
  async close(){}
  async readThread(id){this.calls.push(['readThread',id]);return structuredClone(this.threads.get(id))}
  async forkThread(id){this.calls.push(['forkThread',id]);return {...structuredClone(this.threads.get(id)),id:'imported-thread'}}
}
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(tmpdir(),'tangent-inline-images-')),store=new CanvasStore(dir),runtime=new Runtime(),service=new CanvasService(store,runtime);
  await service.connect();const board=store.state.boards[0],node=service.makeNode(board,'chat');node.threadId='native';
  t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true})});
  const emit=(method,turnId,item)=>runtime.emit('notification',{method,params:{threadId:node.threadId,turnId,item}});
  return {dir,store,runtime,service,board,node,emit};
}
const image=(id='image-A')=>({id,type:'imageGeneration',status:'completed',result:DATA,revisedPrompt:'DNA and genome'});
const user=(id,turnId)=>({id,turnId,role:'user',text:id});
const answer=(id,turnId)=>({id,turnId,role:'assistant',text:id,status:'completed'});

test('late native image stays inside its originating answer ahead of the queued next question',async t=>{
  const f=await fixture(t);f.node.messages=[user('question-A','turn-A'),answer('answer-A','turn-A'),user('question-B','turn-B'),answer('answer-B','turn-B')];
  f.node.activeTurnId='turn-B';f.node.status='running';
  f.emit('item/completed','turn-A',image());
  assert.deepEqual(f.node.messages.map(m=>m.id),['question-A','answer-A','image-A','question-B','answer-B']);
  const output=f.node.messages[2];assert.equal(output.kind,'imageGeneration');assert.equal(output.turnId,'turn-A');assert.equal(output.images[0].turnId,'turn-A');assert.equal(output.images[0].itemId,'image-A');
  assert.equal(f.node.activeTurnId,'turn-B');assert.equal(f.node.status,'running');assert.equal(f.board.nodes.filter(n=>['page','document'].includes(n.kind)).length,0);
  f.emit('item/completed','turn-A',image());assert.equal(f.node.messages.filter(m=>m.id==='image-A').length,1);assert.equal(f.node.generatedImages.length,1);
  f.store.flush();const saved=JSON.parse(fs.readFileSync(f.store.file,'utf8')).boards[0].nodes.find(n=>n.id===f.node.id);assert.equal(saved.messages[2].images[0].turnId,'turn-A');assert.doesNotMatch(JSON.stringify(saved),/data:image|iVBORw0KGgo/);
});

test('same image bytes requested in distinct turns remain two independent inline items',async t=>{
  const f=await fixture(t);f.node.messages=[user('qA','A'),answer('aA','A')];f.emit('item/completed','A',image('image-A'));
  f.node.messages.push(user('qB','B'));f.emit('item/completed','B',image('image-B'));
  assert.equal(f.node.generatedImages.length,2);assert.equal(f.node.generatedImages[0].id,f.node.generatedImages[1].id);
  assert.deepEqual(f.node.messages.filter(m=>m.images).map(m=>[m.id,m.turnId]),[['image-A','A'],['image-B','B']]);
});

test('native image does not modify a stale document target without an explicit insertion',async t=>{
  const f=await fixture(t),created=f.service.documentTool(f.board,f.node,{action:'create',title:'Earlier document',markdown:'Keep exactly this.'});
  f.node.messages=[user('q','A')];f.emit('item/completed','A',image());
  const document=f.board.nodes.find(n=>n.id===created.documentId);assert.equal(document.documentMarkdown,'Keep exactly this.');assert.equal(document.documentRevision,1);
  f.service.insertImage({boardId:f.board.id,nodeId:f.node.id,documentId:document.id,assetId:f.node.generatedImages[0].id});
  assert.match(document.documentMarkdown,/!\[Generated image\]\(tangent-asset:/);assert.equal(document.documentRevision,2);
});

test('imported native history retains image item order and ownership without importing private reasoning',async t=>{
  const f=await fixture(t),thread={id:'external',name:'History',turns:[{id:'A',startedAt:42,status:'completed',items:[
    {id:'uA',type:'userMessage',content:[{type:'text',text:'Draw DNA'}]},
    {id:'aA',type:'agentMessage',text:'Here is DNA.'},image('iA'),{id:'secret',type:'reasoning',text:'private reasoning'},
    {id:'aA-final',type:'agentMessage',text:'A completed image.'},
  ]},{id:'B',startedAt:44,status:'completed',items:[{id:'uB',type:'userMessage',content:[{type:'text',text:'Another question'}]},{id:'aB',type:'agentMessage',text:'Answer B.'}]}]};
  const messages=threadMessages(thread,{imageAsset:item=>f.service.assets.fromGeneration(item)});
  assert.deepEqual(messages.map(m=>m.id),['uA','aA','iA','aA-final','uB','aB']);assert.equal(messages[2].images[0].turnId,'A');
  f.runtime.threads.set('external',thread);const imported=await f.service.importThread({boardId:f.board.id,threadId:'external'});
  assert.deepEqual(imported.messages.map(m=>m.id),messages.map(m=>m.id));assert.equal(imported.generatedImages[0].itemId,'iA');assert.equal(imported.threadId,'imported-thread');
});

test('startup repairs only a byte-matched legacy gallery from read-only native receipts',async t=>{
  const f=await fixture(t),asset=f.service.assets.fromGeneration(image());
  f.node.messages=[user('question-A','A'),answer('answer-A','A'),answer('final-A','A'),user('question-B','B'),answer('answer-B','B')];
  f.node.generatedImages=[{...asset,createdAt:123}];f.node.queue=[{id:'queued',text:'Untouched',status:'queued'}];f.node.draft='Unsaved user draft';
  const before=structuredClone(f.node),thread={id:'native',turns:[{id:'A',items:[{id:'question-A',type:'userMessage'},{id:'answer-A',type:'agentMessage'},image('image-A'),{id:'final-A',type:'agentMessage'}]},{id:'B',items:[]}]};
  f.runtime.threads.set('native',thread);await f.service.repairLegacyImages();
  assert.deepEqual(f.node.messages.map(m=>m.id),['question-A','answer-A','image-A','final-A','question-B','answer-B']);
  assert.equal(f.node.generatedImages[0].turnId,'A');assert.equal(f.node.generatedImages[0].createdAt,123);assert.equal(f.node.generatedImages[0].itemId,'image-A');
  assert.deepEqual(f.node.queue,before.queue);assert.equal(f.node.draft,before.draft);assert.equal(f.node.threadId,before.threadId);assert.deepEqual(f.runtime.calls,[['readThread','native']]);
  await f.service.repairLegacyImages();assert.equal(f.node.messages.filter(m=>m.id==='image-A').length,1);assert.equal(f.runtime.calls.length,1);
});

test('legacy repair never guesses an ambiguous identical image used in two native turns',async t=>{
  const f=await fixture(t),asset=f.service.assets.fromGeneration(image());f.node.generatedImages=[asset];f.node.messages=[user('qA','A'),answer('aA','A'),user('qB','B'),answer('aB','B')];
  const before=structuredClone(f.node);
  const repaired=repairImageBindings(f.node,{turns:[{id:'A',items:[image('iA')]},{id:'B',items:[image('iB')]}]},f.service.assets);
  assert.equal(repaired,0);assert.deepEqual(f.node,before);
});
