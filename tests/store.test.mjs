import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CanvasStore, freshState, validateState } from '../electron/store.mjs';

async function directory(t) {
  const d=await mkdtemp(path.join(tmpdir(),'tangent-store-'));
  t.after(()=>rm(d,{recursive:true,force:true}));return d;
}
function card(p={}) { return {id:'card',kind:'chat',position:{x:30,y:70},messages:[],status:'idle',...p}; }

test('empty first run is honest and atomically persists a private readable state',async t=>{
  const d=await directory(t),store=new CanvasStore(d);assert.equal(store.state.boards.length,1);assert.equal(store.state.boards[0].nodes.length,0);
  store.flush();const parsed=JSON.parse(fs.readFileSync(store.file,'utf8'));assert.equal(parsed.version,1);
  assert.equal(fs.statSync(store.file).mode&0o777,0o600);assert.equal(fs.statSync(d).mode&0o777,0o700);
  assert.equal(fs.readdirSync(d).some(n=>n.includes('.tmp-')),false);
});

test('save and relaunch preserve graph geometry, cutoff provenance, messages and viewport',async t=>{
  const d=await directory(t),store=new CanvasStore(d),board=store.state.boards[0];
  board.viewport={x:-410,y:250,zoom:.7};board.nodes.push(card({threadId:'source',messages:[{id:'a1',role:'assistant',text:'Response',turnId:'t1'}]}),card({id:'child',parentId:'card',sourceMessageId:'a1',sourceTurnId:'t1',inheritedCount:1,position:{x:650,y:70}}));
  board.edges.push({id:'edge',source:'card',target:'child',kind:'branch',sourceMessageId:'a1'});store.touch();store.flush();
  const reopened=new CanvasStore(d);assert.deepEqual(reopened.state,store.state);
  const snapshot=reopened.snapshot();snapshot.boards[0].nodes[0].messages[0].text='Changed externally';assert.equal(reopened.state.boards[0].nodes[0].messages[0].text,'Response');
});

test('last readable backup recovers a corrupt primary without silently discarding the canvas',async t=>{
  const d=await directory(t),store=new CanvasStore(d);store.state.boards[0].title='First readable';store.flush();
  store.state.boards[0].title='Latest';store.touch();store.flush();fs.writeFileSync(store.file,'{"partial":');
  const recovered=new CanvasStore(d);assert.equal(recovered.state.boards[0].title,'First readable');assert.match(recovered.recoveryNotice,/backup/);
  recovered.touch();recovered.flush();assert.equal(JSON.parse(fs.readFileSync(recovered.file,'utf8')).boards[0].title,'First readable');
});

test('a missing primary with an existing backup recovers that backup',async t=>{
  const d=await directory(t),store=new CanvasStore(d);store.state.boards[0].title='Recover me';store.flush();store.touch();store.flush();
  fs.unlinkSync(store.file);const recovered=new CanvasStore(d);assert.equal(recovered.state.boards[0].title,'Recover me');assert.match(recovered.recoveryNotice,/backup/);
});

test('unreadable primary and backup are quarantined, and new state explains recovery',async t=>{
  const d=await directory(t);fs.writeFileSync(path.join(d,'canvas-state.json'),'bad primary');fs.writeFileSync(path.join(d,'canvas-state.backup.json'),'bad backup');
  const store=new CanvasStore(d);assert.equal(store.state.boards[0].nodes.length,0);assert.match(store.recoveryNotice,/protected copy/);
  const recovery=fs.readdirSync(d).find(n=>n.startsWith('canvas-state-unreadable-'));assert.ok(recovery);assert.equal(fs.readFileSync(path.join(d,recovery),'utf8'),'bad primary');assert.equal(fs.statSync(path.join(d,recovery)).mode&0o777,0o600);
});

test('restart marks active turns interrupted and removes stale approval and question controls',async t=>{
  const d=await directory(t),store=new CanvasStore(d),board=store.state.boards[0];
  for(const status of ['running','starting','awaiting-approval'])board.nodes.push(card({id:status,status,activeTurnId:'old-turn',messages:[{id:status,role:'assistant',text:'Partial output',status:'streaming'}],pendingApproval:{requestId:'obsolete'},pendingQuestion:{requestId:'obsolete-question'}}));
  store.touch();store.flush();const reopened=new CanvasStore(d);
  for(const n of reopened.state.boards[0].nodes){assert.equal(n.status,'interrupted');assert.equal(n.messages[0].status,'interrupted');assert.equal(n.pendingApproval,undefined);assert.equal(n.pendingQuestion,undefined);assert.equal(n.activeTurnId,undefined);assert.match(n.error,/closed/);}
});

test('failed final rename leaves the previous state readable and keeps dirty changes for retry',async t=>{
  const d=await directory(t),store=new CanvasStore(d);store.state.boards[0].title='Before';store.flush();store.state.boards[0].title='After';store.touch();
  const rename=fs.renameSync;fs.renameSync=()=>{throw Object.assign(Error('simulated disk failure'),{code:'EIO'});};
  try{assert.throws(()=>store.flush(),/simulated disk failure/);}finally{fs.renameSync=rename;}
  assert.equal(JSON.parse(fs.readFileSync(store.file,'utf8')).boards[0].title,'Before');assert.equal(store.dirty,true);
  store.flush();assert.equal(JSON.parse(fs.readFileSync(store.file,'utf8')).boards[0].title,'After');assert.equal(store.dirty,false);
});

test('validation rejects duplicate card IDs and dangling graph edges, and repairs stale active board ID',()=>{
  let state=freshState();state.boards[0].nodes=[card(),card()];assert.throws(()=>validateState(state),/card/);
  state=freshState();state.boards[0].edges=[{source:'gone',target:'missing'}];assert.throws(()=>validateState(state),/missing/);
  state=freshState();state.activeBoardId='deleted';assert.equal(validateState(state).activeBoardId,state.boards[0].id);
});

test('malformed message contents trigger recovery instead of reaching the renderer',async t=>{
  const d=await directory(t),state=freshState();state.boards[0].nodes.push(card({messages:[null]}));
  fs.writeFileSync(path.join(d,'canvas-state.json'),JSON.stringify(state));
  const store=new CanvasStore(d);assert.match(store.recoveryNotice,/could not be read|backup/);assert.equal(store.state.boards[0].nodes.length,0);
});
