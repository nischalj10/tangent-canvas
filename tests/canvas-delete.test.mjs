import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CanvasService} from '../electron/service.mjs';
import {CanvasStore} from '../electron/store.mjs';

function setup(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-delete-canvas-'));
  const store=new CanvasStore(directory),runtime=new EventEmitter(),calls=[];
  runtime.close=async()=>{};
  runtime.request=async(...args)=>{calls.push(args);throw Error('Deleting a local canvas must not call a remote service.');};
  const service=new CanvasService(store,runtime);store.flush();
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true})});
  return{directory,store,service,calls,board:store.state.boards[0]};
}

test('canvas deletion requires confirmation, persists exact local removal, and keeps other data and shared media',async t=>{
  const f=setup(t),removed=f.board;
  const chat=f.service.makeNode(removed,'chat');chat.threadId='native-original';chat.messages.push({id:'answer',role:'assistant',text:'A native conversation remains in Codex.'});
  f.service.makeNode(removed,'page',{url:'https://chatgpt.com/space/page_OriginalKept123'});
  const media=f.service.pageMedia.import({mime:'text/html',text:'<p>A shared native Page figure.</p>'});
  const retained=await f.service.invoke('board/create',{title:'Keep this canvas'});
  const retainedNode=f.service.makeNode(f.store.board(retained.id),'note',{text:'Keep this exact note.'});
  f.store.flush();const saved=structuredClone(f.store.state);
  for(const confirmed of [undefined,false,'true']){
    await assert.rejects(f.service.invoke('board/delete',{boardId:removed.id,confirmed}),/Confirm/);
    assert.deepEqual(f.store.state,saved);
  }
  const result=await f.service.invoke('board/delete',{boardId:removed.id,confirmed:true});
  assert.deepEqual(result,{deletedBoardId:removed.id,activeBoardId:retained.id});
  assert.deepEqual(f.store.state.boards,[saved.boards.find(board=>board.id===retained.id)]);
  assert.equal(f.store.node(retained.id,retainedNode.id).node.noteText,'Keep this exact note.');
  assert.equal(fs.existsSync(f.service.pageMedia.path(media.id)),true);
  assert.deepEqual(new CanvasStore(f.directory).state,f.store.state);
  assert.deepEqual(f.calls,[]);
  await assert.rejects(f.service.invoke('board/delete',{boardId:removed.id,confirmed:true}),/Canvas not found/);
});

test('deleting the active or last canvas always leaves a valid, durable active canvas',async t=>{
  const f=setup(t),original=f.board;
  const other=await f.service.invoke('board/create',{title:'Second canvas'});
  await f.service.invoke('board/delete',{boardId:other.id,confirmed:true});
  assert.equal(f.store.state.activeBoardId,original.id);
  await f.service.invoke('board/delete',{boardId:original.id,confirmed:true});
  assert.equal(f.store.state.boards.length,1);assert.notEqual(f.store.state.activeBoardId,original.id);
  assert.equal(f.store.state.boards[0].title,'My canvas');assert.equal(f.store.state.boards[0].nodes.length,0);
  assert.equal(new CanvasStore(f.directory).state.activeBoardId,f.store.state.activeBoardId);
});

test('active work and Page saves block deletion without removing or changing a canvas',async t=>{
  const f=setup(t),node=f.service.makeNode(f.board,'chat');f.store.flush();
  node.status='running';
  await assert.rejects(f.service.invoke('board/delete',{boardId:f.board.id,confirmed:true}),/Stop the active chats/);
  assert.equal(f.store.state.boards[0],f.board);assert.equal(node.archived,undefined);
  node.status='idle';f.service.pageOperations.set(node.id,Promise.resolve());
  await assert.rejects(f.service.invoke('board/delete',{boardId:f.board.id,confirmed:true}),/sync or save/);
  f.service.pageOperations.delete(node.id);f.service.initializing.set(node.id,Promise.resolve());
  await assert.rejects(f.service.invoke('board/delete',{boardId:f.board.id,confirmed:true}),/Stop/);
  f.service.initializing.delete(node.id);
});

test('a failed durable delete rolls back the complete in-memory canvas and later saves the original',async t=>{
  const f=setup(t);f.service.makeNode(f.board,'comment',{title:'Retain this question'});f.store.flush();
  const before=structuredClone(f.store.state),flush=f.store.flush.bind(f.store);
  f.store.flush=()=>{throw Error('Disk write failed.');};
  await assert.rejects(f.service.invoke('board/delete',{boardId:f.board.id,confirmed:true}),/Disk write failed/);
  assert.deepEqual(f.store.state,before);
  f.store.flush=flush;f.store.flush();
  assert.deepEqual(new CanvasStore(f.directory).state,JSON.parse(JSON.stringify(before)));
});
