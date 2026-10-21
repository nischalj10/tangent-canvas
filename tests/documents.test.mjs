import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { DocumentAssets, DOCUMENT_TOOL, assetPattern } from '../electron/documents.mjs';
import { CanvasStore, newBoard } from '../electron/store.mjs';
import { CanvasService } from '../electron/service.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const DATA=`data:image/png;base64,${PNG.toString('base64')}`;
class Runtime extends EventEmitter {
  constructor(){super();this.calls=[];this.i=0;}
  async start(){return{connected:true,model:'test',effort:'low',models:[{model:'test',id:'test'}]}}
  async newThread(options){this.calls.push({method:'newThread',options});return{id:`thread-${++this.i}`,turns:[]}}
  async sendTurn(threadId,text,options){this.calls.push({method:'sendTurn',threadId,text,options});return{id:`turn-${++this.i}`,status:'inProgress'}}
  async close(){}
  respond(id,result){this.onRespond?.(id,result);this.calls.push({method:'respond',id,result})}
  reject(id,message){this.calls.push({method:'reject',id,message})}
}
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'tangent-documents-'));
  const store=new CanvasStore(directory),runtime=new Runtime(),service=new CanvasService(store,runtime);await service.connect();
  const board=store.state.boards[0],caller=service.makeNode(board,'chat');caller.threadId='caller-thread';service.loaded.add(caller.threadId);
  const document=(title='Draft',markdown='Original user content')=>service.documentTool(board,caller,{action:'create',title,markdown});
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  return{directory,store,runtime,service,board,caller,document,assets:service.assets};
}
const getDoc=(f,id)=>f.store.node(f.board.id,id).node;
function imageEvent(f,item){f.runtime.emit('notification',{method:'item/completed',params:{threadId:f.caller.threadId,turnId:'image-turn',item:{id:'image-item',type:'imageGeneration',status:'completed',...item}}});}
function toolCall(f,id,args,threadId=f.caller.threadId){f.runtime.emit('serverRequest',{id,method:'item/tool/call',params:{threadId,tool:'canvas_document',arguments:args}});return f.runtime.calls.find(c=>c.method==='respond'&&c.id===id)?.result;}

test('images become private content-addressed assets with stable URLs across relaunch',async t=>{
  const f=await fixture(t),a=f.assets.importImage(PNG),b=f.assets.importImage(DATA);
  assert.equal(a.id,b.id);assert.match(a.id,assetPattern);assert.equal(a.url,`tangent-asset://${a.id}`);
  assert.equal(a.mime,'image/png');assert.equal(a.bytes,PNG.length);assert.equal(fs.readdirSync(f.assets.directory).length,1);
  assert.equal(fs.statSync(f.assets.path(a.id)).mode&0o777,0o600);
  const reopened=new DocumentAssets(f.directory);assert.deepEqual(fs.readFileSync(reopened.path(a.id)),PNG);
  for(const bad of ['../outside.png','%2e%2e/outside.png','A'.repeat(64)+'.png','x'.repeat(64)+'.svg'])assert.throws(()=>reopened.path(bad),/Invalid image/);
});

test('an interrupted asset write never poisons its stable URL on retry',async t=>{
  const f=await fixture(t),write=fs.writeFileSync;
  fs.writeFileSync=(file,bytes,options)=>{
    if(String(file).startsWith(f.assets.directory+path.sep)){write(file,Buffer.from(bytes).subarray(0,8),options);throw Error('Interrupted asset write');}
    return write(file,bytes,options);
  };
  try{assert.throws(()=>f.assets.importImage(PNG),/Interrupted asset write/);}finally{fs.writeFileSync=write;}
  const retried=f.assets.importImage(PNG);assert.deepEqual(fs.readFileSync(f.assets.path(retried.id)),PNG);
});

test('invalid signatures, oversized buffers and missing assets are rejected',async t=>{
  const f=await fixture(t);assert.throws(()=>f.assets.importImage(Buffer.from('<svg>fake</svg>')),/PNG|JPEG|WebP|GIF/);
  assert.throws(()=>f.assets.importImage(Buffer.alloc(24*1024*1024+1)),/24 MB/);
  assert.throws(()=>f.assets.normalizeMarkdown(`![missing](tangent-asset://${'0'.repeat(64)}.png)`),/no longer available/);
  assert.throws(()=>f.assets.normalizeMarkdown('![remote](https://example.com/image.png)'),/Remote images/);
});

test('valid JPEG, WebP and GIF assets retain correct MIME types and bytes',async t=>{
  const f=await fixture(t),formats=[
    ['jpg','image/jpeg','/9j/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/90ABAAB/9oACAEBAAA/APwDr//Z'],
    ['webp','image/webp','UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'],
    ['gif','image/gif','R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'],
  ];
  for(const[ext,mime,encoded]of formats){const bytes=Buffer.from(encoded,'base64'),asset=f.assets.importImage(bytes);assert.ok(asset.id.endsWith(`.${ext}`));assert.equal(asset.mime,mime);assert.deepEqual(fs.readFileSync(f.assets.path(asset.id)),bytes);}
});

test('truncated magic bytes and malformed base64 are not accepted as usable images',async t=>{
  const f=await fixture(t);assert.throws(()=>f.assets.importImage(PNG.subarray(0,8)),/image|PNG|corrupt|invalid/i);
  assert.throws(()=>f.assets.importImage(`data:image/png;base64,${PNG.toString('base64')}!`),/base64|image|invalid/i);
});

test('Markdown normalization preserves prose while replacing local, relative and data images',async t=>{
  const f=await fixture(t),project=path.join(f.directory,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'small image.png'),PNG);
  const original=`# A report\n\nKeep **all** these words.\n\n![local](<${path.join(project,'small image.png')}>)\n\n![relative](small%20image.png)\n\n![inline](${DATA})`;
  const normalized=f.assets.normalizeMarkdown(original,project),asset=f.assets.importImage(PNG);
  assert.match(normalized,/# A report\n\nKeep \*\*all\*\* these words\./);
  assert.equal(normalized.split(asset.url).length-1,3);assert.doesNotMatch(normalized,/data:image|small%20image|small image/);
  assert.equal(f.assets.normalizeMarkdown(normalized,project),normalized);
});

test('image-generation normalization accepts saved path, result path, raw base64 and data URI',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'generated.png');fs.writeFileSync(file,PNG);
  const expected=f.assets.importImage(PNG).id;
  for(const item of [{savedPath:file,result:'not used'},{result:file},{result:PNG.toString('base64')},{result:DATA},{savedPath:'/missing/path',result:DATA}])assert.equal(f.assets.fromGeneration(item).id,expected);
});

test('image-generation file URLs resolve to the same durable asset',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'generated image.png');fs.writeFileSync(file,PNG);
  assert.equal(f.assets.fromGeneration({result:pathToFileURL(file).href}).id,f.assets.importImage(PNG).id);
  assert.equal(f.assets.fromGeneration({savedPath:pathToFileURL(file).href}).id,f.assets.importImage(PNG).id);
});

test('document revisions reject stale agent writes and preserve newer user content',async t=>{
  const f=await fixture(t),created=f.document();
  const saved=f.service.saveDocument({boardId:f.board.id,nodeId:created.documentId,expectedRevision:1,markdown:'New user wording'});
  assert.equal(saved.revision,2);
  assert.throws(()=>f.service.documentTool(f.board,f.caller,{action:'update',documentId:created.documentId,expectedRevision:1,markdown:'Stale model overwrite'}),/changed|revision/);
  assert.equal(getDoc(f,created.documentId).documentMarkdown,'New user wording');assert.equal(getDoc(f,created.documentId).documentRevision,2);
  assert.throws(()=>f.service.documentTool(f.board,f.caller,{action:'update',documentId:created.documentId,markdown:'No revision'}),/expectedRevision/);
});

test('a rejected document update does not retarget future generated images',async t=>{
  const f=await fixture(t),first=f.document('First'),second=f.document('Second');
  assert.equal(f.caller.documentTargetId,second.documentId);
  assert.throws(()=>f.service.documentTool(f.board,f.caller,{action:'update',documentId:first.documentId,expectedRevision:0,markdown:'Stale'}),/revision|changed/);
  assert.equal(f.caller.documentTargetId,second.documentId);
});

test('document save is durable before success and preserves inline assets across relaunch',async t=>{
  const f=await fixture(t),created=f.document();
  const saved=f.service.saveDocument({boardId:f.board.id,nodeId:created.documentId,expectedRevision:1,markdown:`# Report\n\n![Illustration](${DATA})`});
  const disk=JSON.parse(fs.readFileSync(f.store.file,'utf8')),doc=disk.boards[0].nodes.find(n=>n.id===created.documentId);
  assert.equal(doc.documentRevision,saved.revision);assert.equal(doc.documentMarkdown,saved.markdown);assert.match(doc.documentMarkdown,/tangent-asset:/);
  assert.doesNotMatch(JSON.stringify(disk),/data:image|iVBORw0KGgo/);
  const reopened=new CanvasStore(f.directory);assert.equal(reopened.state.boards[0].nodes.find(n=>n.id===created.documentId).documentMarkdown,saved.markdown);
});

test('a disk failure cannot silently replace the last user document in memory',async t=>{
  const f=await fixture(t),created=f.document(),before=structuredClone(getDoc(f,created.documentId)),flush=f.store.flush.bind(f.store);
  f.store.flush=()=>{throw Error('Simulated disk full')};
  try{assert.throws(()=>f.service.saveDocument({boardId:f.board.id,nodeId:created.documentId,expectedRevision:1,markdown:'Failed replacement'}),/disk full/);}finally{f.store.flush=flush;}
  assert.equal(getDoc(f,created.documentId).documentMarkdown,before.documentMarkdown);assert.equal(getDoc(f,created.documentId).documentRevision,before.documentRevision);
  const disk=JSON.parse(fs.readFileSync(f.store.file,'utf8'));assert.equal(disk.boards[0].nodes.find(n=>n.id===created.documentId).documentMarkdown,before.documentMarkdown);
});

test('failed document creation cannot leave a phantom target that later autosaves',async t=>{
  const f=await fixture(t);f.store.flush();const before=structuredClone(f.board),flush=f.store.flush.bind(f.store);
  f.store.flush=()=>{throw Error('Simulated creation disk full')};
  let result;try{result=toolCall(f,'failed-create',{action:'create',title:'Unsaved phantom',markdown:'This creation failed'});}finally{f.store.flush=flush;}
  assert.equal(result.success,false);assert.equal(f.board.nodes.length,before.nodes.length);assert.equal(f.board.edges.length,before.edges.length);assert.equal(f.caller.documentTargetId,undefined);
});

test('completed native image output is inline in its answer without editing an earlier document',async t=>{
  const f=await fixture(t),created=f.document('Report','Keep this paragraph.');imageEvent(f,{result:PNG.toString('base64'),revisedPrompt:'A tiny square'});
  const doc=getDoc(f,created.documentId);assert.equal(doc.documentMarkdown,'Keep this paragraph.');assert.equal(doc.documentRevision,1);
  assert.equal(f.caller.generatedImages.length,1);assert.equal(f.caller.generatedImages[0].alt,'A tiny square');
  assert.doesNotMatch(JSON.stringify(f.store.state),/iVBORw0KGgo|data:image/);
  f.store.flush();const disk=JSON.parse(fs.readFileSync(f.store.file,'utf8'));assert.equal(disk.boards[0].nodes.find(n=>n.id===created.documentId).documentMarkdown,doc.documentMarkdown);
  const output=f.caller.messages.find(message=>message.kind==='imageGeneration');assert.equal(output.turnId,'image-turn');assert.equal(output.images[0].id,f.caller.generatedImages[0].id);
  const revision=doc.documentRevision;imageEvent(f,{result:DATA});assert.equal(doc.documentRevision,revision);assert.equal(f.caller.generatedImages.length,1);
});

test('failed native image output never masquerades as a completed document image',async t=>{
  const f=await fixture(t),created=f.document(),before=getDoc(f,created.documentId).documentMarkdown;
  imageEvent(f,{status:'failed',result:PNG.toString('base64'),failure:{type:'usageLimitExceeded',limitId:'image_gen'}});
  assert.equal(getDoc(f,created.documentId).documentMarkdown,before);assert.equal(f.caller.generatedImages?.length||0,0);
  assert.equal(f.caller.activities.at(-1).status,'failed');
});

test('image from another thread is not inserted into the current caller document',async t=>{
  const f=await fixture(t),created=f.document(),other=f.service.makeNode(f.board,'chat');other.threadId='other-thread';
  f.runtime.emit('notification',{method:'item/completed',params:{threadId:other.threadId,turnId:'other-turn',item:{id:'other-image',type:'imageGeneration',status:'completed',result:DATA}}});
  assert.equal(getDoc(f,created.documentId).documentMarkdown,'Original user content');assert.equal(f.caller.generatedImages,undefined);assert.equal(other.generatedImages.length,1);
});

test('dynamic document tool acts on caller board even when another canvas is active',async t=>{
  const f=await fixture(t),other=newBoard('Other canvas');f.store.state.boards.push(other);f.store.state.activeBoardId=other.id;
  f.runtime.onRespond=(id,result)=>{if(id==='create'){assert.equal(result.success,true);const disk=JSON.parse(fs.readFileSync(f.store.file,'utf8'));assert.equal(disk.boards.find(b=>b.id===f.board.id).nodes.filter(n=>n.kind==='document').length,1);}};
  const result=toolCall(f,'create',{action:'create',title:'Correct canvas',markdown:'Saved before tool success'});assert.equal(result.success,true);
  assert.equal(other.nodes.length,0);assert.equal(f.board.nodes.filter(n=>n.kind==='document').length,1);
  assert.match(DOCUMENT_TOOL.description,/expectedRevision/);
});

test('dynamic document tools cannot list, read or mutate documents from another board',async t=>{
  const f=await fixture(t),created=f.document(),other=newBoard('Other canvas');f.store.state.boards.push(other);const outsider=f.service.makeNode(other,'chat');outsider.threadId='outsider';
  const listed=toolCall(f,'list',{action:'list'},outsider.threadId);assert.deepEqual(JSON.parse(listed.contentItems[0].text).documents,[]);
  for(const action of ['read','update']){const result=toolCall(f,action,{action,documentId:created.documentId,expectedRevision:1,markdown:'Cross board overwrite'},outsider.threadId);assert.equal(result.success,false);}
  assert.equal(getDoc(f,created.documentId).documentMarkdown,'Original user content');
});

test('asking about a document creates a separate comment with explicit target context',async t=>{
  const f=await fixture(t),created=f.document('Editable report','A claim worth discussing.');
  const child=await f.service.invoke('document/ask',{boardId:f.board.id,nodeId:created.documentId,quote:'A claim',text:'Explain this claim'});
  assert.equal(child.kind,'comment');assert.equal(child.documentTargetId,created.documentId);assert.equal(child.quote,'A claim');
  const sent=f.runtime.calls.find(c=>c.method==='sendTurn');assert.match(sent.text,new RegExp(created.documentId));assert.match(sent.text,/canvas_document read\/update/);assert.match(sent.text,/Explain this claim/);
  assert.equal(getDoc(f,created.documentId).documentMarkdown,'A claim worth discussing.');
});
