import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPageUrl } from './pages.mjs';
import { permissionMode } from './chat-permissions.mjs';
import { validatePageDrafts,recoverPageDrafts } from './page-autosave.mjs';

export const id = (prefix) => `${prefix}_${randomUUID()}`;
export function newBoard(title = 'Untitled canvas') {
  const now=Date.now();
  return {id:id('board'),title,projectPath:null,createdAt:now,updatedAt:now,nodes:[],edges:[],viewport:{x:70,y:90,zoom:1}};
}
export function freshState() {
  const board=newBoard('My canvas');
  return {version:1,activeBoardId:board.id,boards:[board]};
}
export function validateState(value) {
  if(value?.version!==1 || !Array.isArray(value.boards) || !value.boards.length)throw Error('Unsupported or empty canvas data');
  const ids=new Set();
  for(const board of value.boards){
    if(typeof board.id!=='string'||ids.has(board.id)||typeof board.title!=='string'||!Array.isArray(board.nodes)||!Array.isArray(board.edges))throw Error('Invalid canvas data');
    ids.add(board.id);const nodeIds=new Set();
    for(const node of board.nodes){
      if(typeof node.id!=='string'||nodeIds.has(node.id)||!['chat','comment','note','document','page'].includes(node.kind)||!Array.isArray(node.messages)||!Number.isFinite(node.position?.x)||!Number.isFinite(node.position?.y))throw Error('Invalid card data');
      if(node.messages.some(m=>!m||typeof m.id!=='string'||!['user','assistant'].includes(m.role)||typeof m.text!=='string'))throw Error('Invalid message data');
      nodeIds.add(node.id);
      node.activities??=[];node.draft??='';node.inheritedCount??=0;
      if(['chat','comment'].includes(node.kind)){node.permissionMode=permissionMode(node.permissionMode);if(node.activePermissionMode!==undefined)permissionMode(node.activePermissionMode)}
      node.queue??=[];
      if(!Array.isArray(node.queue)||node.queue.some(q=>!q||typeof q.id!=='string'||typeof q.text!=='string'||!['queued','sending','failed','uncertain'].includes(q.status))||new Set(node.queue.map(q=>q.id)).size!==node.queue.length)throw Error('Invalid queued message data');
      node.queuePaused??=false;
      if(node.kind==='page'){
        node.pageUrl=canonicalPageUrl(node.pageUrl);
        if(node.pageSnapshot&&(!Array.isArray(node.pageSnapshot.blocks)||node.pageSnapshot.blocks.some(b=>typeof b.id!=='string'||typeof b.hash!=='string'||typeof b.markdown!=='string')||!Array.isArray(node.pageSnapshot.media)))throw Error('Invalid Page snapshot');
        validatePageDrafts(node);
      }
    }
    if(board.edges.some(e=>!nodeIds.has(e.source)||!nodeIds.has(e.target)))throw Error('A connection points to a missing card');
  }
  if(!ids.has(value.activeBoardId))value.activeBoardId=value.boards[0].id;
  return value;
}
export class CanvasStore {
  constructor(directory){
    this.directory=directory;this.file=path.join(directory,'canvas-state.json');this.backup=path.join(directory,'canvas-state.backup.json');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});this.recoveryNotice=null;this.dirty=false;this.persistence={saving:false,error:null};
    const exists=fs.existsSync(this.file);
    try{this.state=validateState(JSON.parse(fs.readFileSync(this.file,'utf8')))}catch(error){
      try{this.state=validateState(JSON.parse(fs.readFileSync(this.backup,'utf8')));this.recoveryNotice='Your last saved backup was restored.'}
      catch{
        if(!exists)this.state=freshState();
        else{
          const recovery=path.join(directory,`canvas-state-unreadable-${Date.now()}.json`);
          fs.copyFileSync(this.file,recovery);fs.chmodSync(recovery,0o600);
          this.state=freshState();this.recoveryNotice='The saved canvas could not be read. A protected copy has been kept in the data folder.';
        }
      }
    }
    for(const board of this.state.boards)for(const node of board.nodes){
      if(['running','starting','awaiting-approval'].includes(node.status)){
        node.status='interrupted';node.error='The app closed before this reply finished. You can send another message to continue.';
        for(const m of node.messages)if(m.status==='streaming')m.status='interrupted';
      }
      delete node.pendingApproval;delete node.pendingQuestion;
      delete node.activeTurnId;delete node.activePermissionMode;
      if(node.kind==='page'&&node.pageSyncStatus==='loading')node.pageSyncStatus=node.pageSnapshot?'ready':'idle';
      if(node.kind==='page')recoverPageDrafts(node);
      if(node.queue?.length){node.queuePaused=true;for(const q of node.queue)if(q.status==='sending'){q.status='uncertain';q.error='The app closed while delivering this message. Review it before sending again.'}}
      for(const m of node.messages)if(m.deliveryStatus==='sending'){m.deliveryStatus='uncertain';m.deliveryError='The app closed before Codex acknowledged this steering message.'}
    }
  }
  touch({delayMs=220}={}){this.dirty=true;this.persistence={saving:true,error:null};clearTimeout(this.timer);this.timer=setTimeout(()=>{try{this.flush()}catch(error){this.persistence={saving:false,error:error.message};this.onPersistenceChange?.()}},delayMs);this.timer.unref?.()}
  flush(){
    clearTimeout(this.timer);if(!this.dirty && fs.existsSync(this.file))return;
    validateState(this.state);
    const temp=`${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temp,JSON.stringify(this.state,null,2),{mode:0o600});
    const fd=fs.openSync(temp,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
    if(fs.existsSync(this.file)){
      try{validateState(JSON.parse(fs.readFileSync(this.file,'utf8')));fs.copyFileSync(this.file,this.backup);fs.chmodSync(this.backup,0o600)}catch{/* Keep the last readable backup. */}
    }
    fs.renameSync(temp,this.file);fs.chmodSync(this.file,0o600);this.dirty=false;this.persistence={saving:false,error:null};this.onPersistenceChange?.();
  }
  snapshot(){return structuredClone({...this.state,recoveryNotice:this.recoveryNotice,persistence:this.persistence})}
  board(boardId){const b=this.state.boards.find(b=>b.id===boardId);if(!b)throw Error('Canvas not found');return b}
  node(boardId,nodeId){const board=this.board(boardId);const node=board.nodes.find(n=>n.id===nodeId);if(!node)throw Error('Card not found');return {board,node}}
}
