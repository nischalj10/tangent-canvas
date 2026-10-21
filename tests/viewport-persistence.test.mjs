import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CanvasStore,newBoard} from '../electron/store.mjs';
import {CanvasService} from '../electron/service.mjs';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-viewport-persistence-'));
  const runtime=new EventEmitter();runtime.close=async()=>{};
  const store=new CanvasStore(directory),service=new CanvasService(store,runtime);
  const board=store.state.boards[0],node=service.makeNode(board,'chat');
  node.messages=[{id:'viewport-history',role:'assistant',text:'Keep this conversation unchanged.',status:'completed'}];
  node.draft='Keep this unsent draft.';
  store.flush();clearTimeout(service.emitTimer);service.emitTimer=null;
  const events=[];service.on('event',event=>events.push(event));
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true})});
  return{directory,store,service,board,node,events};
}
const reopened=f=>new CanvasStore(f.directory);

test('camera-only checkpoints coalesce normally without cloning or broadcasting the canvas',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const snapshot=t.mock.method(f.store,'snapshot'),first={x:-50,y:25,zoom:.6},latest={x:-125,y:80,zoom:.8};
  f.board.updatedAt=1;
  await f.service.invoke('board/update',{boardId:f.board.id,viewport:first});
  t.mock.timers.tick(100);
  await f.service.invoke('board/update',{boardId:f.board.id,viewport:latest});
  t.mock.timers.tick(219);
  assert.equal(snapshot.mock.callCount(),0,'Camera checkpoints must not clone all message history');
  assert.deepEqual(f.events,[],'Camera checkpoints must not rerender every card via a full state event');
  assert.equal(f.store.dirty,true);assert.ok(f.board.updatedAt>1);
  assert.notDeepEqual(reopened(f).board(f.board.id).viewport,latest,'The normal idle disk checkpoint remains coalesced');
  t.mock.timers.tick(1);
  assert.deepEqual(reopened(f).board(f.board.id).viewport,latest);
  assert.deepEqual(f.events,[{type:'persistence',persistence:{saving:false,error:null}}]);
});

test('identical camera checkpoints are no-ops and cannot postpone a dirty camera save',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  f.board.updatedAt=1;
  const timestamp=f.board.updatedAt;
  await f.service.invoke('board/update',{boardId:f.board.id,viewport:{...f.board.viewport}});
  t.mock.timers.tick(1000);
  assert.equal(f.board.updatedAt,timestamp);assert.equal(f.store.dirty,false);assert.deepEqual(f.events,[]);
  const viewport={x:70.5,y:-10.25,zoom:.75};
  await f.service.invoke('board/update',{boardId:f.board.id,viewport});
  const changedAt=f.board.updatedAt;t.mock.timers.tick(219);
  await f.service.invoke('board/update',{boardId:f.board.id,viewport:{...viewport}});
  assert.equal(f.board.updatedAt,changedAt);
  t.mock.timers.tick(1);
  assert.equal(f.store.dirty,false);assert.deepEqual(reopened(f).board(f.board.id).viewport,viewport);
  assert.equal(f.events.filter(event=>event.type==='state').length,0);
});

test('a mixed title and camera update still publishes and persists its complete canonical state',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const viewport={x:-210,y:64,zoom:.5};
  await f.service.invoke('board/update',{boardId:f.board.id,title:'Renamed canvas',viewport});
  t.mock.timers.tick(32);
  assert.equal(f.events.length,1);assert.equal(f.events[0].type,'state');
  assert.equal(f.events[0].state.boards[0].title,'Renamed canvas');assert.deepEqual(f.events[0].state.boards[0].viewport,viewport);
  t.mock.timers.tick(188);
  const disk=reopened(f).board(f.board.id);
  assert.equal(disk.title,'Renamed canvas');assert.deepEqual(disk.viewport,viewport);
  assert.deepEqual(disk.nodes[0],JSON.parse(JSON.stringify(f.node)),'Camera persistence must preserve full conversation history and the unsent draft');
});

test('invalid and additional-field camera updates preserve the existing general update route',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const original={...f.board.viewport};
  await f.service.invoke('board/update',{boardId:f.board.id,viewport:{x:NaN,y:5,zoom:.4}});
  t.mock.timers.tick(32);
  assert.deepEqual(f.board.viewport,original);assert.equal(f.events.at(-1).type,'state');
  const viewport={x:4,y:8,zoom:.5};
  await f.service.invoke('board/update',{boardId:f.board.id,viewport,additionalField:'legacy general update'});
  t.mock.timers.tick(32);
  assert.deepEqual(f.board.viewport,viewport);assert.equal(f.events.filter(event=>event.type==='state').length,2);
});

test('quiet camera updates retain board ownership and are included in the next board selection snapshot',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const second=newBoard('Second camera');f.store.state.boards.push(second);f.store.touch();f.store.flush();f.events.length=0;
  const original={...f.board.viewport},latest={x:-630,y:170,zoom:.33};
  await f.service.invoke('board/update',{boardId:second.id,viewport:latest});
  assert.equal(f.store.state.activeBoardId,f.board.id);assert.deepEqual(f.board.viewport,original);
  await f.service.invoke('board/select',{boardId:second.id});t.mock.timers.tick(32);
  const state=f.events.find(event=>event.type==='state').state;
  assert.equal(state.activeBoardId,second.id);assert.deepEqual(state.boards.find(board=>board.id===second.id).viewport,latest);
  await f.service.invoke('board/select',{boardId:f.board.id});t.mock.timers.tick(32);
  assert.deepEqual(f.events.filter(event=>event.type==='state').at(-1).state.boards.find(board=>board.id===f.board.id).viewport,original);
});

test('quiet camera updates copy their coordinate triple and flush durably on normal service close',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const viewport={x:-11,y:202,zoom:1.2},expected={...viewport},history=JSON.parse(JSON.stringify(f.node));
  await f.service.invoke('board/update',{boardId:f.board.id,viewport});
  viewport.x=999;
  assert.deepEqual(f.board.viewport,expected,'An invocation payload cannot mutate the canonical camera after acknowledgement');
  await f.service.close();
  const board=reopened(f).board(f.board.id);
  assert.deepEqual(board.viewport,expected);assert.deepEqual(board.nodes[0],history);
  assert.equal(f.events.filter(event=>event.type==='state').length,0);
});

test('camera save failure is reported compactly and the latest camera remains retryable',async t=>{
  const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  const failure=t.mock.method(fs,'fsyncSync',()=>{throw Error('Fixture camera disk failure')});
  const viewport={x:4,y:17,zoom:.9};
  await f.service.invoke('board/update',{boardId:f.board.id,viewport});t.mock.timers.tick(220);
  assert.equal(f.store.dirty,true);assert.deepEqual(f.board.viewport,viewport);
  assert.deepEqual(f.events,[{type:'persistence',persistence:{saving:false,error:'Fixture camera disk failure'}}]);
  failure.mock.restore();f.store.flush();
  assert.deepEqual(reopened(f).board(f.board.id).viewport,viewport);
  assert.deepEqual(f.events.at(-1),{type:'persistence',persistence:{saving:false,error:null}});
});
