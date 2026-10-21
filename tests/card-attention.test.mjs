import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CanvasStore} from '../electron/store.mjs';
import {CanvasService} from '../electron/service.mjs';

class Runtime extends EventEmitter{
  counter=0;
  async close(){}
  async newThread(){return{id:`attention-thread-${++this.counter}`}}
  async sendTurn(threadId){const turn={id:`attention-turn-${++this.counter}`,status:'inProgress'};this.emit('notification',{method:'turn/started',params:{threadId,turn}});return turn}
  async interrupt(){}
  complete(node,text='A completed visible reply',status='completed',turnId=node.activeTurnId){
    if(text!==null)this.emit('notification',{method:'item/completed',params:{threadId:node.threadId,turnId,item:{id:`assistant-${turnId}`,type:'agentMessage',text}}});
    this.emit('notification',{method:'turn/completed',params:{threadId:node.threadId,turn:{id:turnId,status}}});
    return turnId;
  }
}
function fixture(t,kind='chat'){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-card-attention-'));
  const store=new CanvasStore(directory),runtime=new Runtime(),service=new CanvasService(store,runtime);service.connection.connected=true;
  const board=store.state.boards[0],node=service.makeNode(board,kind),p={boardId:board.id,nodeId:node.id};
  const send=text=>service.invoke('node/send',{...p,text:text||'A new request'}),ack=()=>service.invoke('node/update',{...p,hasUnreadReply:false});
  const services=[service];t.after(async()=>{for(const item of services)await item.close();fs.rmSync(directory,{recursive:true,force:true})});
  return{directory,store,runtime,service,services,board,node,p,send,ack};
}

for(const kind of ['chat','comment'])test(`${kind} attention follows native work, successful reply, acknowledgement, and next turn`,async t=>{
  const f=fixture(t,kind);assert.equal(f.node.hasUnreadReply,false);
  await f.send();assert.equal(f.node.status,'running');assert.equal(f.node.hasUnreadReply,false);
  f.runtime.complete(f.node);assert.equal(f.node.status,'idle');assert.equal(f.node.hasUnreadReply,true);
  await f.ack();assert.equal(f.node.hasUnreadReply,false);
  await f.send('Continue this exploration');assert.equal(f.node.hasUnreadReply,false);
  f.runtime.complete(f.node,'A second completed reply');assert.equal(f.node.hasUnreadReply,true);
  await f.send('Start again before reading it');assert.equal(f.node.status,'running');assert.equal(f.node.hasUnreadReply,false);
});

test('click acknowledgements are durable and idempotent; clients cannot manufacture unread replies',async t=>{
  const f=fixture(t);await f.send();f.runtime.complete(f.node);
  f.store.flush();assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.hasUnreadReply,true);
  await f.ack();f.store.flush();assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.hasUnreadReply,false);
  const updatedAt=f.board.updatedAt;await f.ack();assert.equal(f.board.updatedAt,updatedAt);assert.equal(f.store.dirty,false);
  await f.service.invoke('node/update',{...f.p,hasUnreadReply:true});assert.equal(f.node.hasUnreadReply,false);assert.equal(f.store.dirty,false);
});

test('duplicate and stale completion events cannot relight an acknowledged reply',async t=>{
  const f=fixture(t);await f.send();const first=f.runtime.complete(f.node);await f.ack();
  f.runtime.complete(f.node,'A completed visible reply','completed',first);assert.equal(f.node.hasUnreadReply,false);
  await f.send('Another turn');const second=f.runtime.complete(f.node,'Another answer');await f.ack();
  f.runtime.complete(f.node,'A completed visible reply','completed',first);assert.equal(f.node.hasUnreadReply,false);
  f.runtime.complete(f.node,'Another answer','completed',second);assert.equal(f.node.hasUnreadReply,false);
  await f.send('Current working turn');const current=f.node.activeTurnId;
  f.runtime.complete(f.node,'Old answer again','completed',first);assert.equal(f.node.activeTurnId,current);assert.equal(f.node.hasUnreadReply,false);
});

test('acknowledging a previously rendered turn cannot clear a newer completed reply',async t=>{
  const f=fixture(t);await f.send();f.runtime.complete(f.node);const rendered=f.node.lastReplyNoticeTurnId;
  await f.send('A queued successor finishes before the old click arrives');f.runtime.complete(f.node,'New unseen successor answer');
  const latest=f.node.lastReplyNoticeTurnId;assert.notEqual(latest,rendered);f.store.flush();const updatedAt=f.board.updatedAt;
  await f.service.invoke('node/update',{...f.p,hasUnreadReply:false,expectedReplyTurnId:rendered});
  assert.equal(f.node.hasUnreadReply,true);assert.equal(f.node.lastReplyNoticeTurnId,latest);assert.equal(f.store.dirty,false);assert.equal(f.board.updatedAt,updatedAt);
  await f.service.invoke('node/update',{...f.p,hasUnreadReply:false,expectedReplyTurnId:latest});assert.equal(f.node.hasUnreadReply,false);
});

test('a stale acknowledgement bundled with another card edit preserves the new notice while applying that edit',async t=>{
  const f=fixture(t);await f.send();f.runtime.complete(f.node);const rendered=f.node.lastReplyNoticeTurnId;
  await f.send('Continue');f.runtime.complete(f.node,'A newer reply');
  await f.service.invoke('node/update',{...f.p,title:'New card title',hasUnreadReply:false,expectedReplyTurnId:rendered});
  assert.equal(f.node.title,'New card title');assert.equal(f.node.hasUnreadReply,true);
});

test('failed, interrupted and stopped turns never announce completion, even with partial text',async t=>{
  const f=fixture(t);await f.send();f.runtime.complete(f.node,'Partial failed answer','failed');assert.equal(f.node.hasUnreadReply,false);
  await f.send();f.runtime.complete(f.node,'Partial interrupted answer','interrupted');assert.equal(f.node.hasUnreadReply,false);
  await f.send();const stopped=f.node.activeTurnId;await f.service.invoke('node/stop',f.p);
  f.runtime.complete(f.node,'A late output after stop','completed',stopped);assert.equal(f.node.hasUnreadReply,false);
});

test('successful empty or tool-only turns do not announce an answer, but native image output does',async t=>{
  const f=fixture(t);await f.send();f.runtime.complete(f.node,null);assert.equal(f.node.hasUnreadReply,false);
  await f.send();f.runtime.complete(f.node,'  \n  ');assert.equal(f.node.hasUnreadReply,false);
  await f.send();const turnId=f.node.activeTurnId;
  f.service.assets.fromGeneration=()=>({id:'attention-image.png',mime:'image/png'});
  f.runtime.emit('notification',{method:'item/completed',params:{threadId:f.node.threadId,turnId,item:{id:'attention-image-item',type:'imageGeneration',status:'completed'}}});
  f.runtime.complete(f.node,null);assert.equal(f.node.hasUnreadReply,true);assert.equal(f.node.messages.at(-1).images.length,1);
});

test('historical imports and existing idle histories never become unread merely from replayed data',async t=>{
  const f=fixture(t),source={id:'historical-source',name:'Imported old research',turns:[{id:'historical-turn',status:'completed',items:[{id:'historical-answer',type:'agentMessage',text:'An old completed answer'}]}]};
  f.runtime.readThread=async()=>structuredClone(source);f.runtime.forkThread=async()=>({...structuredClone(source),id:'historical-fork'});
  const imported=await f.service.invoke('codex/import',{boardId:f.board.id,threadId:source.id});
  assert.equal(imported.hasUnreadReply,false);
  const actual=f.board.nodes.find(node=>node.id===imported.id);f.runtime.complete(actual,null,'completed','historical-turn');assert.equal(actual.hasUnreadReply,false);
  f.node.threadId='old-existing-thread';f.node.messages=[{id:'old-existing-answer',role:'assistant',text:'Old existing answer',turnId:'old-existing-turn',status:'completed'}];delete f.node.hasUnreadReply;
  f.runtime.complete(f.node,null,'completed','old-existing-turn');assert.notEqual(f.node.hasUnreadReply,true);
});

test('relaunch preserves a pending notice and its acknowledgement prevents replay from relighting it',async t=>{
  const f=fixture(t);await f.send();const turnId=f.runtime.complete(f.node);f.store.flush();
  const reopenedStore=new CanvasStore(f.directory),runtime=new Runtime(),reopened=new CanvasService(reopenedStore,runtime);f.services.push(reopened);
  const node=reopenedStore.node(f.board.id,f.node.id).node;assert.equal(node.hasUnreadReply,true);
  await reopened.invoke('node/update',{...f.p,hasUnreadReply:false});reopenedStore.flush();
  runtime.complete(node,null,'completed',turnId);assert.equal(node.hasUnreadReply,false);
  assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.hasUnreadReply,false);
});
