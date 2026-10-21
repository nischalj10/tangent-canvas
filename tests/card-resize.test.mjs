import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CanvasStore} from '../electron/store.mjs';
import {CanvasService} from '../electron/service.mjs';

test('large card geometry and north-west origin survive saving; UI and durable size limits agree',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-resize-'));
  const runtime=new EventEmitter();runtime.close=async()=>{};
  const store=new CanvasStore(directory),service=new CanvasService(store,runtime);
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true})});
  const board=store.state.boards[0],node=service.makeNode(board,'comment');
  await service.invoke('node/update',{boardId:board.id,nodeId:node.id,width:4096,height:3072,position:{x:-185.5,y:-220.25}});
  store.flush();
  const saved=new CanvasStore(directory).node(board.id,node.id).node;
  assert.deepEqual([saved.width,saved.height,saved.position],[4096,3072,{x:-185.5,y:-220.25}]);
  await service.invoke('node/update',{boardId:board.id,nodeId:node.id,width:9000,height:9000});
  assert.deepEqual([node.width,node.height],[8192,8192]);
  await service.invoke('node/update',{boardId:board.id,nodeId:node.id,width:Infinity,height:NaN});
  assert.deepEqual([node.width,node.height],[8192,8192]);
  const note=service.makeNode(board,'note');
  await service.invoke('node/update',{boardId:board.id,nodeId:note.id,width:260,height:180});
  assert.deepEqual([note.width,note.height],[260,180],'The note resize handle minimum must match its saved minimum');
});
