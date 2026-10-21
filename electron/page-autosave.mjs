const clone=value=>structuredClone(value);
const statuses=new Set(['pending','saving','offline','conflict','uncertain','local-error']);
const editable=block=>block?.id==='__title__'||block?.kind==='markdown'&&!block.metadata?.image&&!/(?:library-file|project-file|visualize)\\?:|<(?:iframe|script|style|svg|object|embed)\b/i.test(block.markdown);
const blockAt=(snapshot,id)=>id==='__title__'&&snapshot?.titleHash?{id,kind:'markdown',hash:snapshot.titleHash,markdown:snapshot.title,metadata:{}}:snapshot?.blocks.find(block=>block.id===id);
function sourceAt(snapshot,id,targets){
  if(id==='__title__'||!targets?.length)return blockAt(snapshot,id);
  const positions=targets.map(target=>snapshot?.blocks?.findIndex(block=>block.id===target.id));
  if(positions.some((position,index)=>position<0||position===undefined||index>0&&position!==positions[index-1]+1))return null;
  const blocks=positions.map(position=>snapshot.blocks[position]);
  if(blocks.some(block=>!editable(block)))return null;
  const trailing=new Set(blocks.slice(1).map(block=>block.id));
  if(blocks.slice(1).some(block=>Object.keys(block.metadata||{}).length)||snapshot.comments?.some(thread=>[thread.target?.blockId,thread.target?.anchor?.blockId,thread.target?.head?.blockId,thread.selectionContext?.start?.blockId,thread.selectionContext?.end?.blockId].some(id=>trailing.has(id))))return null;
  return{...blocks[0],markdown:blocks.map(block=>block.markdown).join('\n\n'),targets:blocks.map(block=>({id:block.id,hash:block.hash}))};
}

function span(base,next){
  let start=0,end=base.length,tail=next.length;
  while(start<end&&start<tail&&base[start]===next[start])start++;
  while(end>start&&tail>start&&base[end-1]===next[tail-1]){end--;tail--}
  return{start,end,text:next.slice(start,tail)};
}
/** Conservative three-way merge: never guess through overlapping edits. */
export function mergePageMarkdown(base,local,remote){
  if(local===remote||local===base)return{ok:true,markdown:remote};
  if(remote===base)return{ok:true,markdown:local};
  const a=span(base,local),b=span(base,remote);
  const pointA=a.start===a.end,pointB=b.start===b.end;
  const overlap=pointA&&pointB?a.start===b.start:pointA?a.start>b.start&&a.start<b.end:pointB?b.start>a.start&&b.start<a.end:a.start<b.end&&b.start<a.end;
  if(overlap)return{ok:false};
  const edits=[a,b].sort((x,y)=>x.start-y.start||(x.end-x.start)-(y.end-y.start));
  let markdown='',offset=0;
  for(const edit of edits){markdown+=base.slice(offset,edit.start)+edit.text;offset=edit.end}
  return{ok:true,markdown:markdown+base.slice(offset)};
}

export function validatePageDrafts(node){
  if(node.pageDrafts!==undefined&&(!node.pageDrafts||typeof node.pageDrafts!=='object'||Array.isArray(node.pageDrafts)))throw Error('Invalid Page drafts');
  for(const[id,draft]of Object.entries(node.pageDrafts||{})){
    if(!draft||draft.blockId!==id||typeof draft.baseHash!=='string'||typeof draft.baseMarkdown!=='string'||typeof draft.markdown!=='string'||typeof draft.sessionId!=='string'||!Number.isSafeInteger(draft.clientRevision)||draft.clientRevision<1||!Number.isSafeInteger(draft.revision)||draft.revision<1||!statuses.has(draft.status))throw Error('Invalid durable Page draft');
    if(draft.inFlight&&(typeof draft.inFlight.markdown!=='string'||typeof draft.inFlight.localMarkdown!=='string'||!Number.isSafeInteger(draft.inFlight.revision)))throw Error('Invalid Page save checkpoint');
    if(draft.targets&&(!Array.isArray(draft.targets)||!draft.targets.length||draft.targets[0].id!==id||draft.targets.some(target=>typeof target.id!=='string'||typeof target.hash!=='string')))throw Error('Invalid Page draft source span');
  }
  if(node.pageEditVersions!==undefined&&(!node.pageEditVersions||typeof node.pageEditVersions!=='object'||Array.isArray(node.pageEditVersions)))throw Error('Invalid Page draft version ledger');
  for(const version of Object.values(node.pageEditVersions||{}))if(!version||typeof version.sessionId!=='string'||!Number.isSafeInteger(version.clientRevision)||version.clientRevision<1||!Array.isArray(version.retiredSessions)||version.retiredSessions.some(id=>typeof id!=='string'))throw Error('Invalid Page draft version ledger');
  if(node.pageEditMappings!==undefined&&(!node.pageEditMappings||typeof node.pageEditMappings!=='object'||Array.isArray(node.pageEditMappings)))throw Error('Invalid Page source mappings');
  for(const mapping of Object.values(node.pageEditMappings||{}))if(!mapping||typeof mapping.sessionId!=='string'||typeof mapping.editorHash!=='string'||typeof mapping.localMarkdown!=='string'||typeof mapping.markdown!=='string'||!Array.isArray(mapping.targets)||!mapping.targets.length||mapping.targets.some(target=>typeof target.id!=='string'||typeof target.hash!=='string'))throw Error('Invalid Page source mapping');
}
export function recoverPageDrafts(node){
  validatePageDrafts(node);
  for(const draft of Object.values(node.pageDrafts||{}))if(draft.inFlight||draft.status==='saving'){
    draft.status='uncertain';draft.error='The app closed before this Page save was confirmed. Check the cloud version before continuing.';
  }
  projectPageSave(node);
}
export function projectPageSave(node){
  const drafts=Object.values(node.pageDrafts||{});
  const order=['local-error','uncertain','conflict','offline'];
  const blocked=order.find(status=>drafts.some(draft=>draft.status===status));
  node.pageSaveStatus=blocked||(drafts.some(draft=>draft.inFlight||draft.status==='saving')?'saving':drafts.length?'pending':'saved');
  const error=drafts.find(draft=>draft.status===blocked)?.error;
  if(error)node.pageSaveError=error;else delete node.pageSaveError;
  return{status:node.pageSaveStatus,drafts:clone(node.pageDrafts||{}),...(node.pageSaveError?{error:node.pageSaveError}:{})};
}

/** Durable, per-source-block drafts. The service supplies authenticated IO. */
export class PageAutosave{
  constructor({store,getPage,read,write,cache,operation,changed,debounceMs=600,retryMs=5000}){
    Object.assign(this,{store,getPage,read,write,cache,operation,changed,debounceMs,retryMs});
    this.timers=new Map();this.running=new Map();this.pageTails=new Map();this.closed=false;
  }
  key(p){return`${p.boardId}:${p.nodeId}`}
  persist(board,node){
    projectPageSave(node);this.changed(board);
    try{this.store.flush()}catch(error){
      for(const draft of Object.values(node.pageDrafts||{}))if(['pending','saving'].includes(draft.status)){draft.status='local-error';draft.error='This edit could not be saved on this Mac. Retry local saving before cloud sync.'}
      projectPageSave(node);this.store.persistence={saving:false,error:error.message};this.store.onPersistenceChange?.();throw error;
    }
  }
  projection(node){return projectPageSave(node)}
  nextRevision(node){node.pageEditRevision=Math.max(node.pageEditRevision||0,...Object.values(node.pageDrafts||{}).map(draft=>draft.revision),0)+1;return node.pageEditRevision}
  draft(p){
    if(this.closed)throw Error('The Page editor is closing. Your text has not been sent.');
    const{board,node}=this.getPage(p),previous=node.pageDrafts?.[p.blockId],mapping=node.pageEditMappings?.[p.blockId];
    const scoped=mapping?.sessionId===p.sessionId?mapping:null;
    const targets=previous?.targets||scoped?.targets;
    const observed=sourceAt(node.pageSnapshot,p.blockId,targets);
    const block=observed||((previous||scoped)?{id:p.blockId,kind:'markdown',hash:previous?.baseHash||scoped?.targets?.[0]?.hash,markdown:previous?.baseMarkdown??scoped?.markdown,metadata:{}}:null);
    if(!node.pageSnapshot?.canWrite)throw Error('This Page is read only.');
    if(typeof p.markdown!=='string'||Buffer.byteLength(p.markdown)>262144||Buffer.from(p.markdown).toString('utf8')!==p.markdown)throw Error('This Page block is too large or contains invalid text.');
    if(p.blockId==='__title__'&&/[\r\n]/.test(p.markdown))throw Error('Keep the Page title on one line.');
    if(typeof p.sessionId!=='string'||!p.sessionId||p.sessionId.length>128||!Number.isSafeInteger(p.clientRevision)||p.clientRevision<1)throw Error('The editor draft version is missing.');
    if(typeof p.expectedHash!=='string'||!p.expectedHash)throw Error('The observed source block hash is missing.');
    if(p.editorJSON!==undefined&&Buffer.byteLength(JSON.stringify(p.editorJSON))>524288)throw Error('This rich-text draft is too large.');
    node.pageDrafts??={};node.pageEditVersions??={};
    const ledger=node.pageEditVersions[p.blockId];
    if(previous&&previous.sessionId!==p.sessionId||ledger?.retiredSessions?.includes(p.sessionId))throw Error('This Page is open in a newer editing session. Reload its local draft.');
    if(ledger?.sessionId===p.sessionId&&p.clientRevision<=ledger.clientRevision){
      if(previous?.status==='local-error'&&p.clientRevision===previous.clientRevision&&p.markdown===previous.markdown){previous.status='pending';delete previous.error;this.persist(board,node);this.schedule(p)}
      return{accepted:false,...this.projection(node),draft:clone(node.pageDrafts[p.blockId]||null)};
    }
    if(!block||!editable(block))throw Error('This source block is not directly editable.');
    const baseConflict=!observed||!previous&&![block.hash,scoped?.editorHash,scoped?.targets?.[0]?.hash].includes(p.expectedHash);
    const draft={...(previous||{}),blockId:p.blockId,baseHash:previous?.baseHash||scoped?.targets?.[0]?.hash||block.hash,baseMarkdown:previous?.baseMarkdown??scoped?.markdown??block.markdown,editorHash:previous?.editorHash||scoped?.editorHash||p.expectedHash,targets:clone(targets||[{id:p.blockId,hash:block.hash}]),markdown:p.markdown,sessionId:p.sessionId,clientRevision:p.clientRevision,revision:this.nextRevision(node),updatedAt:Date.now(),status:previous&&['conflict','uncertain'].includes(previous.status)?previous.status:'pending'};
    if(!previous&&scoped){const merged=mergePageMarkdown(scoped.localMarkdown,p.markdown,scoped.markdown);if(merged.ok)draft.markdown=merged.markdown;else this.conflict(draft,block)}
    if(baseConflict){draft.status='conflict';draft.error='The cloud source changed before this edit was received. Your local text is saved; review both versions.';draft.remoteHash=observed?.hash??null;draft.remoteMarkdown=observed?.markdown??null}
    if(p.editorJSON!==undefined&&draft.markdown===p.markdown)draft.editorJSON=clone(p.editorJSON);else delete draft.editorJSON;
    if(!['conflict','uncertain'].includes(draft.status)){delete draft.error;delete draft.remoteHash;delete draft.remoteMarkdown}
    node.pageDrafts[p.blockId]=draft;
    node.pageEditVersions[p.blockId]={sessionId:p.sessionId,clientRevision:p.clientRevision,retiredSessions:ledger?.sessionId&&ledger.sessionId!==p.sessionId?[...(ledger.retiredSessions||[]),ledger.sessionId].slice(-64):ledger?.retiredSessions||[]};
    try{this.persist(board,node)}catch(error){draft.status='local-error';draft.error='This edit could not be saved on this Mac. Retry local saving before cloud sync.';projectPageSave(node);this.cancel(p);throw error}
    if(draft.status==='pending')this.schedule(p);
    return{accepted:true,...this.projection(node),draft:clone(draft)};
  }
  schedule(p,delay=this.debounceMs){
    if(this.closed)return;
    const key=this.key(p);clearTimeout(this.timers.get(key));
    const timer=setTimeout(()=>{this.timers.delete(key);this.flush(p).catch(()=>{})},delay);timer.unref?.();this.timers.set(key,timer);
  }
  cancel(p){const key=this.key(p);clearTimeout(this.timers.get(key));this.timers.delete(key)}
  resume(){for(const board of this.store.state.boards)for(const node of board.nodes)if(node.kind==='page'&&!node.archived&&Object.values(node.pageDrafts||{}).some(draft=>['pending','offline'].includes(draft.status)))this.schedule({boardId:board.id,nodeId:node.id})}
  flush(p,{reconcile=false}={}){
    this.cancel(p);
    const{node}=this.getPage(p),key=this.key(p);
    if(this.running.has(key))return this.running.get(key);
    const tail=this.pageTails.get(node.pageUrl)||Promise.resolve();
    const task=tail.catch(()=>{}).then(()=>{
      if(this.closed)return this.projection(node);
      const current=this.getPage(p);return this.operation(current.node,()=>this.save(p,current,{reconcile}));
    });
    this.running.set(key,task);this.pageTails.set(node.pageUrl,task);
    const done=()=>{
      if(this.running.get(key)===task)this.running.delete(key);
      if(this.pageTails.get(node.pageUrl)===task)this.pageTails.delete(node.pageUrl);
      if(!this.closed&&!node.archived&&Object.values(node.pageDrafts||{}).some(draft=>draft.status==='pending'))this.schedule(p);
    };
    task.then(done,done);return task;
  }
  conflict(draft,block,message='This passage changed in both places. Choose which version to keep.'){
    draft.status='conflict';draft.error=message;draft.remoteHash=block?.hash??null;draft.remoteMarkdown=block?.markdown??null;delete draft.inFlight;
  }
  acknowledge(node,attempt,block){
    const draft=node.pageDrafts[attempt.blockId];if(!draft||draft.sessionId!==attempt.sessionId)return;
    if(attempt.blockId!=='__title__'){
      const targets=block.targets||[{id:block.id,hash:block.hash}];
      node.pageEditMappings??={};node.pageEditMappings[attempt.blockId]={sessionId:attempt.sessionId,editorHash:attempt.editorHash||draft.editorHash||attempt.expectedHash,localMarkdown:attempt.localMarkdown,markdown:block.markdown,targets:clone(targets)};
      draft.targets=clone(targets);
    }
    if(draft.revision===attempt.revision||draft.markdown===block.markdown){delete node.pageDrafts[attempt.blockId];node.pageLastSavedAt=Date.now();return}
    const merged=mergePageMarkdown(attempt.localMarkdown,draft.markdown,block.markdown);
    delete draft.inFlight;
    if(!merged.ok){this.conflict(draft,block);return}
    if(merged.markdown!==draft.markdown){draft.markdown=merged.markdown;delete draft.editorJSON;draft.revision=this.nextRevision(node)}
    draft.baseHash=block.hash;draft.baseMarkdown=block.markdown;draft.status='pending';delete draft.error;delete draft.remoteHash;delete draft.remoteMarkdown;
  }
  async save(p,{board,node},{reconcile}){
    const candidates=()=>Object.values(node.pageDrafts||{}).filter(draft=>['pending','offline'].includes(draft.status)||reconcile&&draft.status==='uncertain');
    if(!candidates().length)return this.projection(node);
    let current;
    try{current=await this.read(board,node)}catch(error){
      if(this.closed)return this.projection(node);
      for(const draft of candidates())if(draft.status!=='uncertain'){draft.status='offline';draft.error='Saved on this Mac. Cloud sync will retry when the Page connection is available.'}
      this.persist(board,node);if(candidates().some(draft=>draft.status==='offline'))this.schedule(p,this.retryMs);return this.projection(node);
    }
    if(this.closed||node.archived)return this.projection(node);
    await this.cache(board,node,current);
    const attempts=[];let totalBytes=0;
    for(const draft of candidates()){
      const block=sourceAt(current,draft.blockId,draft.targets);
      if(draft.status==='uncertain'){
        const attempt=draft.inFlight;
        if(block&&attempt&&block.markdown===attempt.markdown)this.acknowledge(node,attempt,block);
        else this.conflict(draft,block,'The previous save could not be confirmed. Review the cloud and local versions before continuing.');
        continue;
      }
      if(!editable(block)){this.conflict(draft,block,'This source block was removed or changed into content this editor must preserve.');continue}
      const merged=mergePageMarkdown(draft.baseMarkdown,draft.markdown,block.markdown);
      if(!merged.ok){this.conflict(draft,block);continue}
      if(merged.markdown===block.markdown){this.acknowledge(node,{...draft,localMarkdown:draft.markdown},block);continue}
      const bytes=Buffer.byteLength(merged.markdown);
      if(bytes>262144||(draft.targets?.length||1)>100){this.conflict(draft,block,'This passage exceeds one guarded save. Your local text is kept; reopen the canonical paragraphs before editing further.');continue}
      if(attempts.reduce((count,attempt)=>count+(attempt.targets?.length||1),0)+(draft.targets?.length||1)>100||totalBytes+bytes>262144)continue;
      totalBytes+=bytes;
      const attempt={blockId:draft.blockId,sessionId:draft.sessionId,revision:draft.revision,clientRevision:draft.clientRevision,editorHash:draft.editorHash,localMarkdown:draft.markdown,markdown:merged.markdown,expectedHash:block.hash,targets:clone(block.targets||[{id:block.id,hash:block.hash}]),startedAt:Date.now()};
      draft.inFlight=clone(attempt);draft.status='saving';delete draft.error;attempts.push(attempt);
    }
    try{this.persist(board,node)}catch(error){for(const attempt of attempts){const draft=node.pageDrafts[attempt.blockId];if(draft?.inFlight?.revision===attempt.revision)delete draft.inFlight}throw error}
    if(!attempts.length||this.closed)return this.projection(node);
    try{
      const saved=await this.write(board,node,attempts);
      if(this.closed||node.archived)return this.projection(node);
      await this.cache(board,node,saved);
      for(const attempt of attempts){const mapping=saved.editMappings?.[attempt.blockId],block=sourceAt(saved,attempt.blockId,mapping?.blocks?.map(block=>({id:block.id,hash:block.hash}))||attempt.targets);if(!block||block.markdown!==attempt.markdown)throw Object.assign(Error('The cloud save could not be verified.'),{code:'PAGE_EDIT_UNCERTAIN',snapshot:saved});this.acknowledge(node,attempt,block)}
      this.persist(board,node);return this.projection(node);
    }catch(error){
      if(this.closed||node.archived)return this.projection(node);
      if(error.snapshot)try{await this.cache(board,node,error.snapshot)}catch{}
      for(const attempt of attempts){
        const draft=node.pageDrafts[attempt.blockId];if(!draft)continue;
        if(error.code==='PAGE_CONFLICT'){
          const block=sourceAt(error.snapshot,draft.blockId,draft.targets),merged=block&&mergePageMarkdown(draft.baseMarkdown,draft.markdown,block.markdown);
          delete draft.inFlight;
          if(merged?.ok){draft.baseHash=block.hash;draft.baseMarkdown=block.markdown;if(draft.markdown!==merged.markdown){draft.markdown=merged.markdown;delete draft.editorJSON;draft.revision=this.nextRevision(node)}draft.status='pending'}else this.conflict(draft,block);
        }else if(['invalid_page_schema','page_limit_exceeded'].includes(error.code)&&error.commitStatus==='not_committed'){
          this.conflict(draft,sourceAt(current,draft.blockId,draft.targets),`The cloud could not accept this passage. Your local text is kept. ${error.message}`);
        }else if(error.mutationAttempted===false||error.commitStatus==='not_committed'){
          delete draft.inFlight;draft.status='offline';draft.error='Saved on this Mac. Cloud sync will retry when the Page connection is available.';
        }else{draft.status='uncertain';draft.error='Saved on this Mac. The cloud save was not confirmed; check it before continuing.'}
      }
      this.persist(board,node);if(Object.values(node.pageDrafts).some(draft=>draft.status==='offline'))this.schedule(p,this.retryMs);return this.projection(node);
    }
  }
  retry(p){
    const{board,node}=this.getPage(p);
    for(const draft of Object.values(node.pageDrafts||{}))if(draft.status==='local-error')draft.status=draft.inFlight?'uncertain':'pending';
    this.persist(board,node);return this.flush(p,{reconcile:true});
  }
  async resolve(p){
    const{board,node}=this.getPage(p),draft=node.pageDrafts?.[p.blockId];
    if(!draft||draft.revision!==p.revision||!['conflict','uncertain'].includes(draft.status)||!['use-cloud','keep-local'].includes(p.choice))throw Error('This draft changed. Review the latest local and cloud versions.');
    const current=await this.read(board,node);
    if(this.closed||node.archived)throw Error('This Page is no longer open.');
    await this.cache(board,node,current);
    const live=node.pageDrafts[p.blockId],block=sourceAt(current,p.blockId,draft.targets);
    if(live?.revision!==p.revision)throw Error('This draft changed while checking the cloud version. Review it again.');
    if(p.choice==='use-cloud')delete node.pageDrafts[p.blockId];
    else{
      if(!editable(block))throw Error('The original source block no longer exists or cannot be edited. Your local draft is still kept on this Mac.');
      if(live.remoteHash!==undefined&&live.remoteHash!==block.hash){this.conflict(live,block,'The cloud version changed again. Review it before replacing it.');live.revision=this.nextRevision(node);this.persist(board,node);throw Error(live.error)}
      live.baseHash=block.hash;live.baseMarkdown=block.markdown;live.status='pending';live.revision=this.nextRevision(node);delete live.inFlight;delete live.error;delete live.remoteHash;delete live.remoteMarkdown;
    }
    this.persist(board,node);if(p.choice==='keep-local')this.schedule(p,0);return{...this.projection(node),snapshot:clone(node.pageSnapshot)};
  }
  close(){this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();for(const board of this.store.state.boards)for(const node of board.nodes)if(node.kind==='page'){recoverPageDrafts(node);if(Object.keys(node.pageDrafts||{}).length)this.changed(board)}}
}
