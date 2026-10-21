import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {CanvasStore} from '../electron/store.mjs';
import {CanvasService} from '../electron/service.mjs';
import {mergePageMarkdown} from '../electron/page-autosave.mjs';
const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}};
const tick=()=>new Promise(done=>setImmediate(done));
class Runtime extends EventEmitter{async close(){}}
class Pages extends EventEmitter{
  constructor(){super();this.reads=0;this.writes=[];this.peak=0;this.active=0;this.snapshot={pageId:'page_Autosave123456',url:'https://chatgpt.com/space/page_Autosave123456',title:'Exact title',titleHash:hash('Exact title'),canWrite:true,blocks:[{id:'body',hash:hash('alpha middle omega'),kind:'markdown',markdown:'alpha middle omega',metadata:{kept:{value:42}}},{id:'other',hash:'other-hash',kind:'markdown',markdown:'Unrelated original',metadata:{opaque:true}},{id:'media',hash:'media-hash',kind:'markdown',markdown:'![Original](library-file:file_opaque)',metadata:{image:{file_id:'file_opaque'}}}],references:[],comments:[],media:[]}}
  change(id,text){const block=this.snapshot.blocks.find(b=>b.id===id);block.markdown=text;block.hash=hash(text)}
  async read(){this.reads++;if(this.offline)throw Error('Offline');return clone(this.snapshot)}
  async editBlocks(_url,{blocks}){
    this.active++;this.peak=Math.max(this.peak,this.active);
    try{
      this.beforeWrite?.(blocks);this.writes.push(clone(blocks));
      const mappings={};
      for(const input of blocks){
        if(input.blockId==='__title__'){assert.equal(input.expectedHash,this.snapshot.titleHash);this.snapshot.title=input.markdown;this.snapshot.titleHash=hash(input.markdown)}
        else{
          assert.equal(input.expectedHash,this.snapshot.blocks.find(b=>b.id===input.blockId).hash);
          if(this.split){
            const first=this.snapshot.blocks.find(block=>block.id===input.blockId),parts=input.markdown.split('\n\n');
            for(const target of input.targets?.slice(1)||[]){const index=this.snapshot.blocks.findIndex(block=>block.id===target.id);assert.ok(index>=0);assert.equal(this.snapshot.blocks[index].hash,target.hash);this.snapshot.blocks.splice(index,1)}
            first.markdown=parts[0];first.hash=hash(first.markdown);const extra=parts.slice(1).map((markdown,index)=>({id:`created-${this.writes.length}-${index}`,kind:'markdown',hash:hash(markdown),markdown,metadata:{}}));
            this.snapshot.blocks.splice(this.snapshot.blocks.indexOf(first)+1,0,...extra);mappings[input.blockId]={blocks:clone([first,...extra]),markdown:input.markdown};
          }else{this.change(input.blockId,input.markdown);mappings[input.blockId]={blocks:clone([this.snapshot.blocks.find(block=>block.id===input.blockId)]),markdown:input.markdown}}
        }
      }
      this.started?.resolve();if(this.gate)await this.gate.promise;
      if(this.uncertain)throw Object.assign(Error('Missing receipt'),{code:'PAGE_EDIT_UNCERTAIN',snapshot:clone(this.snapshot),mutationAttempted:true});
      return{...clone(this.snapshot),editMappings:mappings};
    }finally{this.active--}
  }
  async close(){}
}
function setup(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-autosave-')),store=new CanvasStore(directory),pages=new Pages(),service=new CanvasService(store,new Runtime(),{pageConnector:pages});
  service.pageAutosave.debounceMs=100000;service.pageAutosave.retryMs=100000;
  const board=store.state.boards[0],node=service.makeNode(board,'page',{url:pages.snapshot.url});node.pageSnapshot=clone(pages.snapshot);node.pageId=pages.snapshot.pageId;service.changed(board);store.flush();
  const p={boardId:board.id,nodeId:node.id},draft=(markdown,clientRevision=1,fields={})=>service.invoke('page/draft',{...p,blockId:'body',expectedHash:node.pageSnapshot.blocks[0].hash,markdown,sessionId:'editor-one',clientRevision,...fields});
  t.after(async()=>{pages.gate?.resolve();await service.close();fs.rmSync(directory,{recursive:true,force:true})});return{directory,store,pages,service,board,node,p,draft};
}
test('three-way merge only accepts provably disjoint text changes, including Unicode and edge insertions',()=>{
  assert.deepEqual(mergePageMarkdown('alpha middle omega','ALPHA middle omega','alpha middle OMEGA'),{ok:true,markdown:'ALPHA middle OMEGA'});
  assert.deepEqual(mergePageMarkdown('abc','Xabc','Abc'),{ok:true,markdown:'XAbc'});
  assert.deepEqual(mergePageMarkdown('abc','axc','ayc'),{ok:false});assert.deepEqual(mergePageMarkdown('abc','aXbc','aYbc'),{ok:false});
  assert.deepEqual(mergePageMarkdown('😀 alpha omega','😀 ALPHA omega','😀 alpha OMEGA'),{ok:true,markdown:'😀 ALPHA OMEGA'});
});
test('drafts and rich editor state are fsynced before network, coalesced, and reject stale acknowledged IPC',async t=>{
  const f=setup(t),editor={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Latest'}]}]};
  await f.draft('First',1);await f.draft('Second',2);await f.draft('Latest',3,{editorJSON:editor});editor.content[0].content[0].text='Mutated caller';
  const disk=JSON.parse(fs.readFileSync(f.store.file,'utf8')).boards[0].nodes[0];assert.equal(disk.pageDrafts.body.markdown,'Latest');assert.equal(disk.pageDrafts.body.editorJSON.content[0].content[0].text,'Latest');assert.equal(f.pages.reads,0);assert.equal(f.pages.writes.length,0);
  f.pages.beforeWrite=blocks=>{const checkpoint=JSON.parse(fs.readFileSync(f.store.file,'utf8')).boards[0].nodes[0].pageDrafts.body;assert.equal(checkpoint.inFlight.markdown,blocks[0].markdown);assert.equal(checkpoint.status,'saving')};
  await f.service.invoke('page/flush',f.p);assert.equal(f.pages.writes.length,1);assert.equal(f.pages.writes[0][0].markdown,'Latest');assert.deepEqual(f.node.pageDrafts,{});assert.equal(f.node.pageSaveStatus,'saved');
  const stale=await f.draft('Stale old message',2);assert.equal(stale.accepted,false);assert.deepEqual(f.node.pageDrafts,{});assert.equal(f.pages.snapshot.blocks[0].markdown,'Latest');
});
test('a failed local fsync prevents every network call and leaves the latest draft retryable',async t=>{
  const f=setup(t),flush=f.store.flush.bind(f.store);f.store.flush=()=>{throw Error('Disk full')};await assert.rejects(f.draft('Never lose my typing'),/Disk full/);assert.equal(f.node.pageSaveStatus,'local-error');assert.equal(f.pages.reads,0);assert.equal(f.pages.writes.length,0);
  f.store.flush=flush;await f.service.invoke('page/retry',f.p);assert.equal(f.pages.snapshot.blocks[0].markdown,'Never lose my typing');assert.equal(f.node.pageSaveStatus,'saved');
});
test('late save acknowledgements never clear newer typing or its rich JSON',async t=>{
  const f=setup(t);f.pages.gate=deferred();f.pages.started=deferred();await f.draft('First saved version');const saving=f.service.invoke('page/flush',f.p);await f.pages.started.promise;
  const editor={type:'doc',content:[{type:'paragraph'}]};await f.draft('First saved version plus later typing',2,{editorJSON:editor});const disk=JSON.parse(fs.readFileSync(f.store.file,'utf8')).boards[0].nodes[0].pageDrafts.body;assert.equal(disk.clientRevision,2);assert.equal(disk.inFlight.revision,1);
  f.pages.gate.resolve();await saving;assert.equal(f.node.pageDrafts.body.markdown,'First saved version plus later typing');assert.deepEqual(f.node.pageDrafts.body.editorJSON,editor);assert.equal(f.node.pageDrafts.body.status,'pending');assert.equal(f.node.pageDrafts.body.baseHash,f.pages.snapshot.blocks[0].hash);
  f.pages.gate=null;await f.service.invoke('page/flush',f.p);assert.equal(f.pages.writes.length,2);assert.equal(f.pages.snapshot.blocks[0].markdown,'First saved version plus later typing');assert.deepEqual(f.node.pageDrafts,{});
});
test('non-overlapping cloud changes rebase without touching metadata, other blocks, or media',async t=>{
  const f=setup(t),untouched=clone(f.pages.snapshot.blocks.slice(1)),metadata=clone(f.pages.snapshot.blocks[0].metadata);await f.draft('ALPHA middle omega');f.pages.change('body','alpha middle OMEGA');await f.service.invoke('page/flush',f.p);
  assert.equal(f.pages.snapshot.blocks[0].markdown,'ALPHA middle OMEGA');assert.deepEqual(f.pages.snapshot.blocks[0].metadata,metadata);assert.deepEqual(f.pages.snapshot.blocks.slice(1),untouched);
});
test('overlapping changes remain local with both versions, stale conflict controls cannot discard newer typing',async t=>{
  const f=setup(t);await f.draft('alpha LOCAL omega');f.pages.change('body','alpha CLOUD omega');await f.service.invoke('page/flush',f.p);assert.equal(f.node.pageSaveStatus,'conflict');assert.equal(f.pages.writes.length,0);const version=f.node.pageDrafts.body.revision;assert.equal(f.node.pageDrafts.body.remoteMarkdown,'alpha CLOUD omega');
  await f.draft('alpha NEWER LOCAL omega',2);await assert.rejects(f.service.invoke('page/resolve-draft',{...f.p,blockId:'body',revision:version,choice:'use-cloud'}),/draft changed/i);assert.equal(f.node.pageDrafts.body.markdown,'alpha NEWER LOCAL omega');
  await f.service.invoke('page/resolve-draft',{...f.p,blockId:'body',revision:f.node.pageDrafts.body.revision,choice:'keep-local'});await f.service.invoke('page/flush',f.p);assert.equal(f.pages.snapshot.blocks[0].markdown,'alpha NEWER LOCAL omega');assert.equal(f.pages.writes.length,1);
});
test('offline drafts survive process reload and safe retry; opaque/media blocks cannot enter autosave',async t=>{
  const f=setup(t);await f.draft('Durable offline edit');f.pages.offline=true;await f.service.invoke('page/flush',f.p);assert.equal(f.node.pageSaveStatus,'offline');const reopened=new CanvasStore(f.directory).node(f.board.id,f.node.id).node;assert.equal(reopened.pageDrafts.body.markdown,'Durable offline edit');assert.equal(reopened.pageSaveStatus,'offline');
  await assert.rejects(f.draft('Remove image',2,{blockId:'media',expectedHash:'media-hash'}),/not directly editable/);f.pages.offline=false;await f.service.invoke('page/retry',f.p);assert.equal(f.node.pageSaveStatus,'saved');assert.equal(f.pages.snapshot.blocks[2].markdown,'![Original](library-file:file_opaque)');
});
test('an uncertain committed save is never replayed; retry reconciles desired cloud state read-only',async t=>{
  const f=setup(t);await f.draft('Committed but lost acknowledgement');f.pages.uncertain=true;await f.service.invoke('page/flush',f.p);assert.equal(f.node.pageSaveStatus,'uncertain');assert.equal(f.pages.writes.length,1);await f.service.invoke('page/flush',f.p);assert.equal(f.pages.writes.length,1);assert.equal(f.node.pageDrafts.body.inFlight.markdown,'Committed but lost acknowledgement');
  const reopened=new CanvasStore(f.directory).node(f.board.id,f.node.id).node;assert.equal(reopened.pageSaveStatus,'uncertain');f.pages.uncertain=false;await f.service.invoke('page/retry',f.p);assert.equal(f.node.pageSaveStatus,'saved');assert.equal(f.pages.writes.length,1);
});
test('separate cards for the same canonical Page serialize writes and rebase independent edits',async t=>{
  const f=setup(t),other=f.service.makeNode(f.board,'page',{url:f.pages.snapshot.url});other.pageSnapshot=clone(f.pages.snapshot);await f.draft('ALPHA middle omega');await f.service.invoke('page/draft',{boardId:f.board.id,nodeId:other.id,blockId:'body',expectedHash:other.pageSnapshot.blocks[0].hash,markdown:'alpha middle OMEGA',sessionId:'editor-two',clientRevision:1});f.pages.gate=deferred();f.pages.started=deferred();
  const first=f.service.invoke('page/flush',f.p);await f.pages.started.promise;const second=f.service.invoke('page/flush',{boardId:f.board.id,nodeId:other.id});await tick();assert.equal(f.pages.writes.length,1);f.pages.gate.resolve();await Promise.all([first,second]);assert.equal(f.pages.peak,1);assert.equal(f.pages.snapshot.blocks[0].markdown,'ALPHA middle OMEGA');
});
test('title drafts use their observed hash, and deleting a local canvas cancels pending autosave',async t=>{
  const f=setup(t);await f.draft('New exact title',1,{blockId:'__title__',expectedHash:f.node.pageSnapshot.titleHash});await f.service.invoke('page/flush',f.p);assert.equal(f.pages.writes[0][0].blockId,'__title__');assert.equal(f.pages.snapshot.title,'New exact title');await f.draft('Must remain only local');const writes=f.pages.writes.length;await f.service.invoke('board/delete',{boardId:f.board.id,confirmed:true});assert.equal(f.service.pageAutosave.timers.size,0);await tick();assert.equal(f.pages.writes.length,writes);
});
test('automatic debounce resets on newer input and performs exactly one latest save',async t=>{
  const f=setup(t);t.mock.timers.enable({apis:['setTimeout']});f.service.pageAutosave.debounceMs=600;
  await f.draft('First debounce edit');t.mock.timers.tick(599);await tick();assert.equal(f.pages.writes.length,0);
  await f.draft('Latest debounce edit',2);t.mock.timers.tick(599);await tick();assert.equal(f.pages.writes.length,0);t.mock.timers.tick(1);await tick();assert.equal(f.pages.writes.length,1);assert.equal(f.pages.snapshot.blocks[0].markdown,'Latest debounce edit');
});
test('keep-local refuses a second cloud change that was not shown in the conflict UI',async t=>{
  const f=setup(t);await f.draft('alpha local omega');f.pages.change('body','alpha cloud omega');await f.service.invoke('page/flush',f.p);const revision=f.node.pageDrafts.body.revision;f.pages.change('body','alpha newest cloud omega');await assert.rejects(f.service.invoke('page/resolve-draft',{...f.p,blockId:'body',revision,choice:'keep-local'}),/cloud version changed again/);assert.equal(f.pages.writes.length,0);assert.equal(f.node.pageDrafts.body.remoteMarkdown,'alpha newest cloud omega');
});
test('native paragraph splits, late typing and later saves replace only the receipt-owned span',async t=>{
  const f=setup(t);f.pages.split=true;f.pages.started=deferred();f.pages.gate=deferred();const protectedBlocks=clone(f.pages.snapshot.blocks.slice(1));await f.draft('First paragraph\n\nSecond paragraph');const saving=f.service.invoke('page/flush',f.p);await f.pages.started.promise;await f.draft('First paragraph\n\nSecond paragraph with later typing',2);f.pages.gate.resolve();await saving;
  assert.equal(f.node.pageDrafts.body.targets.length,2);assert.equal(f.node.pageEditMappings.body.targets.length,2);const firstCreated=f.node.pageDrafts.body.targets[1].id;f.pages.gate=null;await f.service.invoke('page/flush',f.p);assert.equal(f.pages.snapshot.blocks.some(block=>block.id===firstCreated),false);assert.deepEqual(f.pages.snapshot.blocks.filter(block=>['other','media'].includes(block.id)),protectedBlocks);assert.equal(f.node.pageEditMappings.body.markdown,'First paragraph\n\nSecond paragraph with later typing');
  // A clean acknowledgement may reach the backend before the renderer applies
  // it. The same active session still owns the verified logical source span.
  await f.draft('First paragraph edited again\n\nSecond paragraph with later typing',3);await f.service.invoke('page/flush',f.p);assert.equal(f.pages.snapshot.blocks.filter(block=>block.id.startsWith('created-')).length,1);
  const owned=f.node.pageEditMappings.body.targets[1].id,second=f.pages.snapshot.blocks.find(block=>block.id===owned).markdown;
  // Canonical rebuild rotates the session, so editing paragraph1 cannot erase2.
  await f.draft('Canonical first paragraph only',1,{sessionId:'canonical-new'});await f.service.invoke('page/flush',f.p);assert.equal(f.pages.snapshot.blocks.find(block=>block.id===owned).markdown,second);
  await assert.rejects(f.draft('Retired editor must not return',4),/newer editing session/);
});
test('a restarted in-flight save retains newer dirty typing, its owned span and unknown checkpoint',async t=>{
  const f=setup(t);f.pages.split=true;await f.draft('First paragraph\n\nSecond paragraph');await f.service.invoke('page/flush',f.p);f.pages.gate=deferred();f.pages.started=deferred();await f.draft('First changed\n\nSecond paragraph',2);const saving=f.service.invoke('page/flush',f.p);await f.pages.started.promise;await f.draft('First changed\n\nSecond paragraph plus newer typing',3);
  const reopened=new CanvasStore(f.directory).node(f.board.id,f.node.id).node;assert.equal(reopened.pageSaveStatus,'uncertain');assert.equal(reopened.pageDrafts.body.markdown,'First changed\n\nSecond paragraph plus newer typing');assert.equal(reopened.pageDrafts.body.targets.length,2);assert.equal(reopened.pageEditMappings.body.targets.length,2);assert.equal(reopened.pageDrafts.body.inFlight.clientRevision,2);
  f.pages.gate.resolve();await saving;
});
test('a stale first-edit guard retains durable conflict text instead of silently losing the draft',async t=>{
  const f=setup(t),old=f.node.pageSnapshot.blocks[0].hash;f.pages.change('body','A newer cloud paragraph');f.node.pageSnapshot=clone(f.pages.snapshot);await f.draft('My typing based on the old snapshot',1,{expectedHash:old});assert.equal(f.node.pageSaveStatus,'conflict');const reopened=new CanvasStore(f.directory).node(f.board.id,f.node.id).node;assert.equal(reopened.pageDrafts.body.markdown,'My typing based on the old snapshot');assert.equal(f.pages.writes.length,0);await assert.rejects(f.draft('No hash',2,{expectedHash:undefined}),/hash is missing/);
});
test('remote annotations on an owned trailing paragraph prevent destructive span replacement',async t=>{
  const f=setup(t);f.pages.split=true;await f.draft('First paragraph\n\nSecond paragraph');await f.service.invoke('page/flush',f.p);const trailing=f.node.pageEditMappings.body.targets[1].id;f.pages.snapshot.blocks.find(block=>block.id===trailing).metadata={external_annotation:{keep:true}};await f.draft('First changed\n\nSecond paragraph',2);await f.service.invoke('page/flush',f.p);assert.equal(f.node.pageSaveStatus,'conflict');assert.equal(f.pages.writes.length,1);assert.deepEqual(f.pages.snapshot.blocks.find(block=>block.id===trailing).metadata,{external_annotation:{keep:true}});assert.equal(f.node.pageDrafts.body.markdown,'First changed\n\nSecond paragraph');
});
