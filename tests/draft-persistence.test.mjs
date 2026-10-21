import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CanvasStore} from '../electron/store.mjs';
import {CanvasService} from '../electron/service.mjs';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-draft-persistence-'));
  const runtime=new EventEmitter();runtime.close=async()=>{};
  const store=new CanvasStore(directory),service=new CanvasService(store,runtime);
  const board=store.state.boards[0],node=service.makeNode(board,'chat');
  store.flush();clearTimeout(service.emitTimer);service.emitTimer=null;
  const events=[];service.on('event',event=>events.push(event));
  const payload={boardId:board.id,nodeId:node.id};
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true})});
  return{directory,store,service,board,node,payload,events};
}

const diskNode=f=>JSON.parse(fs.readFileSync(f.store.file,'utf8')).boards[0].nodes.find(node=>node.id===f.node.id);
function connectedRuntime(f){
  f.service.connection.connected=true;f.node.threadId='draft-fixture-thread';f.service.loaded.add(f.node.threadId);
  f.service.runtime.sendTurn=async()=>({id:'draft-fixture-turn'});
}

test('chat draft checkpoints never broadcast the whole canvas, then persist the latest text once',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  f.board.updatedAt=1;
  await f.service.invoke('node/update',{...f.payload,draft:'First typing pause'});
  t.mock.timers.tick(300);
  await f.service.invoke('node/update',{...f.payload,draft:'Latest typing pause'});
  t.mock.timers.tick(749);
  assert.equal(f.events.filter(event=>event.type==='state').length,0,'Typing must not clone, send or rerender every canvas card');
  assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.draft,'','Draft checkpoints coalesce before a disk write');
  assert.equal(f.store.dirty,true);assert.equal(f.store.persistence.saving,true);assert.ok(f.board.updatedAt>1);
  t.mock.timers.tick(1);
  assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.draft,'Latest typing pause');
  assert.deepEqual(f.events,[{type:'persistence',persistence:{saving:false,error:null}}]);
  assert.equal(f.store.dirty,false);
});

test('identical draft updates are true no-ops and cannot delay an existing save',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const updatedAt=f.board.updatedAt;
  await f.service.invoke('node/update',{...f.payload,draft:''});
  assert.equal(f.store.dirty,false);assert.equal(f.board.updatedAt,updatedAt);
  t.mock.timers.tick(1000);assert.deepEqual(f.events,[]);
  await f.service.invoke('node/update',{...f.payload,draft:'Keep exactly once'});
  const changedAt=f.board.updatedAt;
  t.mock.timers.tick(749);
  await f.service.invoke('node/update',{...f.payload,draft:'Keep exactly once'});
  assert.equal(f.board.updatedAt,changedAt);
  t.mock.timers.tick(1);
  assert.equal(f.store.dirty,false);assert.equal(f.events.length,1);
  await f.service.invoke('node/update',{...f.payload,draft:'Keep exactly once'});
  assert.equal(f.store.dirty,false);
});

test('mixed draft and visible card changes still broadcast their canonical state',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  await f.service.invoke('node/update',{...f.payload,draft:'Unsent question',title:'Updated title',width:920,position:{x:11,y:22}});
  t.mock.timers.tick(32);
  assert.equal(f.events.length,1);assert.equal(f.events[0].type,'state');
  const emitted=f.events[0].state.boards[0].nodes[0];
  assert.deepEqual([emitted.title,emitted.width,emitted.position,emitted.draft],['Updated title',920,{x:11,y:22},'Unsent question']);
  t.mock.timers.tick(188);
  assert.deepEqual(f.events[1],{type:'persistence',persistence:{saving:false,error:null}});
  const reopened=new CanvasStore(f.directory).node(f.board.id,f.node.id).node;
  assert.deepEqual([reopened.title,reopened.width,reopened.position,reopened.draft],['Updated title',920,{x:11,y:22},'Unsent question']);
});

test('quiet drafts flush on explicit checkpoint and service close, including empty drafts',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  await f.service.invoke('node/update',{...f.payload,draft:'Persist before the idle timer'});
  f.store.flush();
  assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.draft,'Persist before the idle timer');
  await f.service.invoke('node/update',{...f.payload,draft:''});
  await f.service.close();
  assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.draft,'');
  assert.ok(f.events.every(event=>event.type==='persistence'));
});

test('a draft disk failure reports compact persistence status and leaves the latest text retryable',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const failure=t.mock.method(fs,'fsyncSync',()=>{throw Error('Fixture disk full')});
  await f.service.invoke('node/update',{...f.payload,draft:'Recover this unsent draft'});
  t.mock.timers.tick(750);
  assert.equal(f.store.dirty,true);assert.equal(f.node.draft,'Recover this unsent draft');
  assert.deepEqual(f.events,[{type:'persistence',persistence:{saving:false,error:'Fixture disk full'}}]);
  failure.mock.restore();f.store.flush();
  assert.deepEqual(f.events.at(-1),{type:'persistence',persistence:{saving:false,error:null}});
  assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.draft,'Recover this unsent draft');
});

test('durable queue delivery still checkpoints immediately and broadcasts its new message',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  await f.service.invoke('node/update',{...f.payload,draft:'Send this exact draft'});
  await f.service.invoke('node/queue',{...f.payload,text:'Send this exact draft'});
  const disk=new CanvasStore(f.directory).node(f.board.id,f.node.id).node;
  assert.equal(disk.queue[0].text,'Send this exact draft');assert.equal(disk.draft,'');
  t.mock.timers.tick(32);
  assert.equal(f.events.filter(event=>event.type==='state').length,1);
  assert.equal(f.events.filter(event=>event.type==='persistence').length,1);
  assert.equal(f.store.dirty,false);
});

test('sending an earlier question preserves a newer draft on disk while turn startup is still waiting',async t=>{
  const f=fixture(t);connectedRuntime(f);
  let release;const gate=new Promise(resolve=>{release=resolve});
  f.service.runtime.sendTurn=async()=>{await gate;return{id:'held-draft-fixture-turn'}};
  await f.service.invoke('node/update',{...f.payload,draft:'Newer unsent successor question'});
  const sending=f.service.invoke('node/send',{...f.payload,text:'Earlier submitted question'});
  await new Promise(resolve=>setImmediate(resolve));
  const duringStartup={memory:f.node.draft,disk:diskNode(f).draft,message:diskNode(f).messages.at(-1).text};
  release();await sending;
  assert.equal(duringStartup.memory,'Newer unsent successor question');assert.equal(duringStartup.disk,'Newer unsent successor question');
  assert.equal(duringStartup.message,'Earlier submitted question');assert.equal(f.node.draft,'Newer unsent successor question');
});

test('sending the matching original draft clears it while preserving its durable submitted message',async t=>{
  const f=fixture(t);connectedRuntime(f);
  await f.service.invoke('node/update',{...f.payload,draft:'  Original question to send  '});
  await f.service.invoke('node/send',{...f.payload,text:'Original question to send'});
  assert.equal(f.node.draft,'');assert.equal(diskNode(f).draft,'');assert.equal(diskNode(f).messages.at(-1).text,'Original question to send');
});

test('queueing an earlier question preserves an unrelated newer draft in its durable checkpoint',async t=>{
  const f=fixture(t);
  await f.service.invoke('node/update',{...f.payload,draft:'Keep this unrelated unsent question'});
  await f.service.invoke('node/queue',{...f.payload,text:'Earlier queued question'});
  assert.equal(f.node.draft,'Keep this unrelated unsent question');assert.equal(diskNode(f).draft,'Keep this unrelated unsent question');
  assert.equal(diskNode(f).queue[0].text,'Earlier queued question');
});

test('draining a queued question cannot clear an independently typed unsent draft',async t=>{
  const f=fixture(t);
  await f.service.invoke('node/update',{...f.payload,draft:'Queued question'});
  await f.service.invoke('node/queue',{...f.payload,text:'Queued question'});
  await f.service.invoke('node/update',{...f.payload,draft:'Independent unsent follow-up'});
  connectedRuntime(f);f.node.queuePaused=false;
  await f.service.drainQueue(f.board,f.node);
  assert.equal(f.node.queue.length,0);assert.equal(f.node.messages.at(-1).text,'Queued question');
  assert.equal(f.node.draft,'Independent unsent follow-up');assert.equal(diskNode(f).draft,'Independent unsent follow-up');
});

test('a failed queue checkpoint rolls back its entry and retains the exact newer draft',async t=>{
  const f=fixture(t);
  await f.service.invoke('node/update',{...f.payload,draft:'Newer recovery draft'});
  const flush=f.store.flush.bind(f.store);f.store.flush=()=>{throw Error('Fixture queue disk failure')};
  await assert.rejects(f.service.invoke('node/queue',{...f.payload,text:'Earlier queued request'}),/Fixture queue disk failure/);
  f.store.flush=flush;assert.equal(f.node.queue.length,0);assert.equal(f.node.draft,'Newer recovery draft');
  f.store.flush();assert.equal(diskNode(f).draft,'Newer recovery draft');
});
