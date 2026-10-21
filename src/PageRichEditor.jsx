import React,{useLayoutEffect,useEffect,useRef,useState} from 'react';
import{createRoot}from'react-dom/client';
import{createPortal}from'react-dom';
import{EditorState,Plugin,PluginKey,TextSelection}from'prosemirror-state';
import{EditorView,Decoration,DecorationSet}from'prosemirror-view';
import{keymap}from'prosemirror-keymap';
import{baseKeymap,toggleMark,setBlockType,wrapIn,lift,chainCommands,exitCode}from'prosemirror-commands';
import{history,undo,redo}from'prosemirror-history';
import{wrapInList,splitListItem,liftListItem,sinkListItem}from'prosemirror-schema-list';
import{inputRules,wrappingInputRule,textblockTypeInputRule,undoInputRule}from'prosemirror-inputrules';
import{gapCursor}from'prosemirror-gapcursor';
import{dropCursor}from'prosemirror-dropcursor';
import{tableEditing,addRowAfter,addColumnAfter,deleteRow,deleteColumn,deleteTable}from'prosemirror-tables';
import{Bold,Italic,Underline,Strikethrough,Code,Link,List,ListOrdered,Quote,Undo2,Redo2,MessageCircle,GitBranch,Table2,Check,LoaderCircle,CloudOff,AlertCircle,X}from'lucide-react';
import{pageEditorSchema as schema,sourceDocument,sourceNodes,parseSourceBlock,serializeSourceNode,sourceEditorJSON,safeLink}from'./rich-page-schema.mjs';
import{resolvePagePassage,pagePassageContext}from'./page-passage-anchor.mjs';
import{createDraftPersistence}from'./draft-persistence.mjs';
import'prosemirror-view/style/prosemirror.css';
import'prosemirror-tables/style/tables.css';
import'prosemirror-gapcursor/style/gapcursor.css';
import'./page-editor.css';

const labels={saved:'Saved to ChatGPT',pending:'Saved on this Mac',saving:'Saving…',offline:'Offline — saved on this Mac',conflict:'Changes need review',uncertain:'Cloud save needs review','local-error':'Could not save on this Mac'};
const quoteKey=new PluginKey('page-quoted-passage');
const positions=doc=>[...sourceNodes(doc).values()];
const sourceAt=(doc,pos)=>{const p=doc.resolve(Math.min(Math.max(0,pos),doc.content.size));return p.depth?{node:p.node(1),offset:p.before(1)}:positions(doc).find(item=>pos>=item.offset&&pos<=item.offset+item.node.nodeSize)};
const sameIds=(a,b)=>a.childCount===b.childCount&&positions(a).every((item,i)=>item.node.attrs.sourceId===b.child(i).attrs.sourceId);

export default function PageRichEditor({snapshot,node,board,invoke,active,renderOpaque,onAskSelection,quotedSelection,statusSlot}){
  const mount=useRef(null),viewRef=useRef(null),latest=useRef(null),records=useRef(new Map()),disposed=useRef(false),opaqueViews=useRef(new Set()),initializing=useRef(false),focusInitialized=useRef(false);
  latest.current={snapshot,node,board,invoke,active,renderOpaque,onAskSelection,quotedSelection};
  const[preparing,setPreparing]=useState(false),[selection,setSelection]=useState(null),[link,setLink]=useState(null),[tableMenu,setTableMenu]=useState(false),[localError,setLocalError]=useState(''),[pendingLocal,setPendingLocal]=useState(false),[version,setVersion]=useState(0);
  const localErrorRef=useRef('');
  const mediaKey=media=>JSON.stringify((media||[]).map(({reference,url,mime,kind})=>({reference,url,mime,kind})).sort((a,b)=>a.reference.localeCompare(b.reference)));
  const mediaSignature=useRef(mediaKey(snapshot.media));
  const [saveSlot,setSaveSlot]=useState(null);
  useLayoutEffect(()=>{setSaveSlot(active?document.getElementById(`page-save-slot-${node.id}`):null)},[active,statusSlot,node.id]);
  const fail=error=>{localErrorRef.current=error?.message||String(error);if(!disposed.current)setLocalError(localErrorRef.current)};
  const makeRecord=id=>{
    let record=records.current.get(id);if(record)return record;
    const p=latest.current,draft=p.node.pageDrafts?.[id];
    record={sessionId:draft?.sessionId||crypto.randomUUID(),revision:draft?.clientRevision||0,acknowledged:draft?.clientRevision||0,queued:null,processing:false,inFlight:null};
    record.persistence=createDraftPersistence({
      key:`page-editor:${p.board.id}:${p.node.id}:${id}:${record.sessionId}`,
      read:()=>record.revision,initial:record.acknowledged,idleMs:750,maxWaitMs:2000,onError:fail,
      write:async()=>{
        // A rejected local checkpoint retains its richest/latest payload until
        // another attempt receives the guarded durable acknowledgement.
        if(record.failed&&(!record.queued||record.failed.clientRevision>record.queued.clientRevision))record.queued=record.failed;
        await drain(record);
        if(record.failed)throw record.failure||Error('This Page edit could not be saved on this Mac.');
      },
    });
    records.current.set(id,record);return record;
  };
  const disposeRecord=record=>record.persistence?.dispose().catch(()=>{});
  const forgetRecord=id=>{const record=records.current.get(id);if(record){records.current.delete(id);disposeRecord(record)}};
  const flushRecords=()=>Promise.all([...records.current.values()].map(record=>record.persistence.flush()));
  // Own multi-paragraph receipts remain one editor container until this view is
  // rebuilt. This keeps native caret/Undo and scopes later writes to exactly the
  // cloud IDs created by our acknowledged edit, never adjacent source blocks.
  const editorSnapshot=()=>{
    const p=latest.current,byId=new Map(p.snapshot.blocks.map(block=>[block.id,block])),groups=new Map(),skipped=new Set();
    for(const[id,mapping]of Object.entries(p.node.pageEditMappings||{})){
      const draft=p.node.pageDrafts?.[id],record=records.current.get(id);
      if(mapping.sessionId!==record?.sessionId&&mapping.sessionId!==draft?.sessionId)continue;
      const targets=draft?.targets?.length?draft.targets:mapping.targets;
      if(!targets?.length||targets.some(target=>!byId.has(target.id)))continue;
      const indices=targets.map(target=>p.snapshot.blocks.findIndex(block=>block.id===target.id));
      if(indices.some((index,i)=>i>0&&index!==indices[0]+i))continue;
      groups.set(id,{...byId.get(id),markdown:targets.map(target=>byId.get(target.id).markdown).join('\n\n')});
      targets.slice(1).forEach(target=>skipped.add(target.id));
    }
    for(const[id,draft]of Object.entries(p.node.pageDrafts||{})){
      if(id==='__title__'||groups.has(id)||!draft.targets?.length||draft.targets.some(target=>!byId.has(target.id)))continue;
      const indices=draft.targets.map(target=>p.snapshot.blocks.findIndex(block=>block.id===target.id));
      if(indices.some((index,i)=>i>0&&index!==indices[0]+i))continue;
      groups.set(id,{...byId.get(id),markdown:draft.targets.map(target=>byId.get(target.id).markdown).join('\n\n')});
      draft.targets.slice(1).forEach(target=>skipped.add(target.id));
    }
    return{...p.snapshot,blocks:p.snapshot.blocks.filter(block=>!skipped.has(block.id)).map(block=>groups.get(block.id)||block)};
  };
  const updatePending=()=>{if(!disposed.current)setPendingLocal([...records.current.values()].some(record=>record.processing||record.queued||record.acknowledged<record.revision))};
  const drain=record=>{
    if(record.inFlight)return record.inFlight;
    if(!record.queued)return Promise.resolve();
    record.processing=true;updatePending();
    const operation=(async()=>{
      while(record.queued){
        const payload=record.queued;record.queued=null;
        try{
          const result=await window.tangent.invoke('page/draft',payload);
          if(result.accepted===false&&result.draft?.clientRevision>record.revision)throw Error('A newer local draft is open. Reopen this Page to continue with it.');
          record.acknowledged=Math.max(record.acknowledged,payload.clientRevision);
          if(record.failed?.clientRevision<=payload.clientRevision){delete record.failed;delete record.failure}
          if(!disposed.current&&![...records.current.values()].some(item=>item.failed)){localErrorRef.current='';setLocalError('')}
        }catch(error){record.failed=record.queued?.clientRevision>payload.clientRevision?record.queued:payload;record.queued=null;record.failure=error;throw error}
      }
    })();
    record.inFlight=operation;
    const settled=()=>{if(record.inFlight===operation)record.inFlight=null;record.processing=false;updatePending()};
    operation.then(settled,settled);
    return operation;
  };
  const persist=(source,markdown)=>{
    const p=latest.current,record=makeRecord(source.attrs.sourceId);
    const payload={boardId:p.board.id,nodeId:p.node.id,blockId:source.attrs.sourceId,expectedHash:source.attrs.sourceHash,markdown,sessionId:record.sessionId,clientRevision:++record.revision,...(source.type.name==='page_title'?{}:{editorJSON:sourceEditorJSON(source)})};
    record.queued=payload;record.localMarkdown=markdown;updatePending();record.persistence.schedule();
  };
  useEffect(()=>{if(!active)flushRecords().catch(()=>{})},[active]);
  const initializeEmpty=async()=>{
    const p=latest.current;
    if(initializing.current||p.snapshot.blocks.length||!p.active||p.snapshot.canWrite!==true)return;
    initializing.current=true;focusInitialized.current=true;setPreparing(true);
    try{await window.tangent.invoke('page/initialize',{boardId:p.board.id,nodeId:p.node.id})}
    catch(error){focusInitialized.current=false;fail(error)}
    finally{initializing.current=false;if(!disposed.current)setPreparing(false)}
  };
  const refreshSelection=view=>{
    if(disposed.current)return;
    const{from,to,empty}=view.state.selection;
    if(empty||!latest.current.active||!view.editable||!view.hasFocus()&&!document.activeElement?.closest('[data-page-rich-toolbar],[data-page-rich-link]')){setSelection(null);setTableMenu(false);return}
    try{
      const a=view.coordsAtPos(from),b=view.coordsAtPos(to),block=sourceAt(view.state.doc,from)?.node;
      const quote=view.state.doc.textBetween(from,to,'\n').trim();
      setSelection({from,to,quote,blockId:block?.attrs.sourceId,x:Math.max(12,Math.min((a.left+b.right)/2,innerWidth-12)),y:a.top,below:b.bottom,marks:(view.state.storedMarks||view.state.doc.resolve(from).marks()).map(mark=>mark.type.name)});
    }catch{setSelection(null)}
    setVersion(v=>v+1);
  };
  const openLink=view=>{
    if(!view)return false;
    const sel=view.state.selection,mark=view.state.doc.resolve(sel.from).marks().find(m=>m.type===schema.marks.link);
    setLink({from:sel.from,to:sel.to,url:mark?.attrs.href||''});return true;
  };

  useLayoutEffect(()=>{
    disposed.current=false;
    const blockView=(initial,view)=>{
      let value=initial,reactRoot;
      const dom=document.createElement('section');dom.className='linked-page-block';
      const content=document.createElement('div');content.className='page-rich-block-content';dom.append(content);
      const updateAttrs=()=>{
        const attrs=value.attrs,owner=latest.current.node.id;
        dom.id=`page-block-${owner}-${attrs.sourceId}`;dom.dataset.nodeId=owner;dom.dataset.blockId=attrs.sourceId;dom.dataset.pageBlockId=attrs.sourceId;dom.dataset.blockHash=attrs.sourceHash;dom.dataset.testid=`page-block-${attrs.sourceId}`;
        dom.classList.toggle('page-source-protected',attrs.opaque);
        if(attrs.opaque){dom.contentEditable='false';reactRoot??=createRoot(content);const block=latest.current.snapshot.blocks.find(block=>block.id===attrs.sourceId)||{id:attrs.sourceId,markdown:attrs.markdown};reactRoot.render(latest.current.renderOpaque(block))}
      };
      const refresh={refresh:updateAttrs};if(value.attrs.opaque)opaqueViews.current.add(refresh);
      updateAttrs();
      return{dom,...(!value.attrs.opaque?{contentDOM:content}:{}),update(next){if(next.type!==value.type||next.attrs.sourceId!==value.attrs.sourceId||next.attrs.opaque!==value.attrs.opaque)return false;value=next;updateAttrs();return true},stopEvent:event=>value.attrs.opaque||event.target.closest?.('button,input,textarea,select,iframe'),ignoreMutation:mutation=>value.attrs.opaque||mutation.type==='attributes'&&mutation.target===dom,destroy(){opaqueViews.current.delete(refresh);if(reactRoot){const root=reactRoot;queueMicrotask(()=>root.unmount())}}};
    };
    const schemaRules=[
      wrappingInputRule(/^\s*>\s$/,schema.nodes.blockquote),wrappingInputRule(/^\s*([-+*])\s$/,schema.nodes.bullet_list),wrappingInputRule(/^(\d+)\.\s$/,schema.nodes.ordered_list,match=>({order:+match[1]})),
      textblockTypeInputRule(/^(#{1,6})\s$/,schema.nodes.heading,match=>({level:match[1].length})),textblockTypeInputRule(/^```([\w-]+)?\s$/,schema.nodes.code_block,match=>({params:match[1]||''})),
    ];
    const editorKeys={
      'Mod-b':toggleMark(schema.marks.strong),'Mod-i':toggleMark(schema.marks.em),'Mod-u':toggleMark(schema.marks.underline),'Mod-Shift-x':toggleMark(schema.marks.strike),'Mod-`':toggleMark(schema.marks.code),
      'Mod-z':undo,'Shift-Mod-z':redo,'Mod-y':redo,'Mod-k':()=>openLink(viewRef.current),'Mod-s':()=>{flushRecords().then(()=>latest.current.invoke('page/flush',{boardId:latest.current.board.id,nodeId:latest.current.node.id})).catch(fail);return true},
      Backspace:undoInputRule,Enter:chainCommands(splitListItem(schema.nodes.list_item),exitCode),Tab:sinkListItem(schema.nodes.list_item),'Shift-Tab':liftListItem(schema.nodes.list_item),
    };
    const protectedSources=new Plugin({filterTransaction(tr,state){
      if(!tr.docChanged||tr.getMeta('page-remote'))return true;
      if(!sameIds(tr.doc,state.doc))return false;
      for(const[id,{node:old}]of sourceNodes(state.doc)){
        const next=sourceNodes(tr.doc).get(id)?.node;
        if(old.attrs.opaque&&!old.eq(next))return false;
        if(id==='__title__'&&!latest.current.snapshot.titleHash&&!old.eq(next))return false;
      }
      return true;
    }});
    const quotedPassage=new Plugin({key:quoteKey,state:{init:()=>DecorationSet.empty,apply(tr,value){const passage=tr.getMeta(quoteKey);if(passage!==undefined)return passage?DecorationSet.create(tr.doc,[Decoration.inline(passage.from,passage.to,{class:'page-quoted-highlight','data-testid':'page-quoted-highlight'})]):DecorationSet.empty;return value.map(tr.mapping,tr.doc)}},props:{decorations:state=>quoteKey.getState(state)}});
    const state=EditorState.create({schema,doc:sourceDocument(editorSnapshot(),latest.current.node.pageDrafts),plugins:[quotedPassage,inputRules({rules:schemaRules}),keymap(editorKeys),keymap(baseKeymap),history(),dropCursor(),gapCursor(),tableEditing(),protectedSources]});
    let linkGesture=null;
    const view=new EditorView(mount.current,{
      state,editable:()=>latest.current.snapshot.canWrite!==false&&latest.current.active&&latest.current.snapshot.blocks.length>0,
      attributes:{class:'page-prosemirror nodrag nopan nowheel',role:'textbox','aria-label':'Page document','aria-multiline':'true',tabindex:'0','data-testid':`page-rich-editor-${node.id}`,spellcheck:'true'},
      nodeViews:{source_block:blockView},
      dispatchTransaction(transaction){
        const previous=view.state;
        const result=previous.applyTransaction(transaction);view.updateState(result.state);
        if(transaction.docChanged&&!transaction.getMeta('page-remote')){
          const before=sourceNodes(previous.doc);
          for(const[id,{node:changed}]of sourceNodes(result.state.doc)){
            const old=before.get(id)?.node;
            if(changed.attrs.opaque||old?.content.eq(changed.content))continue;
            const markdown=serializeSourceNode(changed);
            if(markdown!==serializeSourceNode(old))persist(changed,markdown);
          }
        }
        refreshSelection(view);
      },
      handleDOMEvents:{
        pointerdown(_view,event){linkGesture={x:event.clientX,y:event.clientY,moved:false};if(!latest.current.snapshot.blocks.length&&event.target.closest?.('.linked-page-block')){event.preventDefault();initializeEmpty();return true}return false},
        pointermove(_view,event){if(linkGesture&&(Math.abs(event.clientX-linkGesture.x)>4||Math.abs(event.clientY-linkGesture.y)>4))linkGesture.moved=true;return false},
        pointercancel(){if(linkGesture)linkGesture.moved=true;return false},
        click(_view,event){
          const gesture=linkGesture;linkGesture=null;
          const anchor=event.target.closest?.('a[href]');
          if(!anchor||!safeLink(anchor.getAttribute('href')))return false;
          // Consume the real click, including in read-only Pages, so Electron's
          // native navigation cannot open a second tab after the browser handoff.
          event.preventDefault();
          if(event.button!==0||event.shiftKey||event.altKey||gesture&&(gesture.moved||Math.abs(event.clientX-gesture.x)>4||Math.abs(event.clientY-gesture.y)>4))return true;
          latest.current.invoke('app/open-external',{url:anchor.getAttribute('href')});
          return true;
        },
        keydown(_view,event){event.stopPropagation();if(!latest.current.snapshot.blocks.length&&event.key==='Enter'){event.preventDefault();initializeEmpty();return true}if(event.key==='Escape'){setLink(null);setTableMenu(false);setSelection(null);return true}return false},
        focus(){queueMicrotask(()=>refreshSelection(view));return false},
        blur(){flushRecords().catch(()=>{});queueMicrotask(()=>{if(!disposed.current)refreshSelection(view)});return false},
      },
      transformPastedHTML(html){const doc=new DOMParser().parseFromString(html,'text/html');doc.querySelectorAll('script,style,iframe,object,embed,form,meta,link').forEach(el=>el.remove());doc.querySelectorAll('*').forEach(el=>[...el.attributes].forEach(attr=>{if(attr.name.startsWith('on')||attr.name==='contenteditable')el.removeAttribute(attr.name)}));return doc.body.innerHTML},
    });
    viewRef.current=view;
    const hide=event=>{if(!event.target.closest?.('.page-rich-editor,[data-page-rich-toolbar],[data-page-rich-link]')){setSelection(null);setTableMenu(false)}};
    const reposition=()=>{if(view.hasFocus())refreshSelection(view)};
    document.addEventListener('pointerdown',hide);document.addEventListener('selectionchange',reposition);window.addEventListener('resize',reposition);document.addEventListener('scroll',reposition,true);
    return()=>{disposed.current=true;document.removeEventListener('pointerdown',hide);document.removeEventListener('selectionchange',reposition);window.removeEventListener('resize',reposition);document.removeEventListener('scroll',reposition,true);viewRef.current=null;view.destroy();const pending=[...records.current.values()];records.current.clear();pending.forEach(disposeRecord)};
  },[node.id]);

  useLayoutEffect(()=>{
    const view=viewRef.current;if(!view)return;
    view.setProps({editable:()=>snapshot.canWrite!==false&&active&&snapshot.blocks.length>0});
    const nextMediaSignature=mediaKey(snapshot.media);
    if(nextMediaSignature!==mediaSignature.current){mediaSignature.current=nextMediaSignature;opaqueViews.current.forEach(item=>item.refresh())}
    // A clean external refresh becomes a new editing baseline. Retaining an
    // earlier own-save session would incorrectly re-merge already applied cloud
    // changes. Dirty drafts keep their session and go through guarded recovery.
    for(const[id,record]of records.current){
      if(node.pageDrafts?.[id]||record.queued||record.failed||record.processing||record.acknowledged<record.revision)continue;
      const mapping=node.pageEditMappings?.[id];
      const remote=id==='__title__'?snapshot.title:mapping?.targets?.map(target=>snapshot.blocks.find(block=>block.id===target.id)?.markdown).join('\n\n');
      if(id==='__title__'?remote!==record.localMarkdown:mapping?.sessionId===record.sessionId&&remote!==mapping.markdown)forgetRecord(id);
    }
    let tr=view.state.tr;
    const current=sourceNodes(view.state.doc),wanted=sourceDocument(editorSnapshot(),node.pageDrafts);
    if(sameIds(view.state.doc,wanted)){
      for(const item of positions(view.state.doc).reverse()){
        const id=item.node.attrs.sourceId,record=records.current.get(id),desired=sourceNodes(wanted).get(id)?.node;
        if(!desired)continue;
        const newerLocal=record&&(record.queued||record.failed||record.processing||record.acknowledged<record.revision);
        const draft=node.pageDrafts?.[id];
        const staleDraft=record&&draft&&draft.clientRevision<record.revision;
        if(!newerLocal&&!staleDraft&&!item.node.content.eq(desired.content))tr.replaceWith(item.offset+1,item.offset+item.node.nodeSize-1,desired.content);
        if(JSON.stringify(item.node.attrs)!==JSON.stringify(desired.attrs))tr.setNodeMarkup(item.offset,undefined,desired.attrs);
      }
    }else if(![...records.current.values()].some(record=>record.queued||record.failed||record.processing||record.acknowledged<record.revision)&&!Object.keys(node.pageDrafts||{}).length){for(const id of [...records.current.keys()])forgetRecord(id);tr.replaceWith(0,view.state.doc.content.size,sourceDocument(snapshot,node.pageDrafts).content)}
    if(tr.docChanged)view.dispatch(tr.setMeta('page-remote',true).setMeta(quoteKey,resolvePagePassage(tr.doc,latest.current.quotedSelection)).setMeta('addToHistory',false));
    if(focusInitialized.current&&snapshot.blocks.length){focusInitialized.current=false;const first=positions(view.state.doc).find(item=>item.node.type.name==='source_block'&&!item.node.attrs.opaque);if(first){view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(first.offset+1))));view.focus()}}
  },[snapshot,node.pageDrafts,node.pageEditMappings,active]);

  useLayoutEffect(()=>{
    const view=viewRef.current;if(!view)return;
    view.dispatch(view.state.tr.setMeta(quoteKey,resolvePagePassage(view.state.doc,quotedSelection)).setMeta('addToHistory',false));
  },[quotedSelection]);
  const listCommand=type=>(state,dispatch,view)=>{
    const{$from}=state.selection;let found;
    for(let depth=$from.depth;depth>0;depth--)if(['bullet_list','ordered_list'].includes($from.node(depth).type.name)){found={node:$from.node(depth),pos:$from.before(depth)};break}
    if(found){if(found.node.type===type)return liftListItem(schema.nodes.list_item)(state,dispatch,view);if(dispatch)dispatch(state.tr.setNodeMarkup(found.pos,type,type===schema.nodes.ordered_list?{order:1}:null));return true}
    return wrapInList(type)(state,dispatch,view);
  };
  const command=(fn)=>{const view=viewRef.current;if(!view)return;fn(view.state,view.dispatch,view);view.focus();refreshSelection(view)};
  const mark=(type)=>command(toggleMark(schema.marks[type]));
  const state=viewRef.current?.state;
  const activeMark=type=>!!state&&(state.selection.empty?(state.storedMarks||state.selection.$from.marks()).some(mark=>mark.type===schema.marks[type]):state.doc.rangeHasMark(state.selection.from,state.selection.to,schema.marks[type]));
  const style=state?.selection.$from.parent.type.name==='heading'?`heading-${state.selection.$from.parent.attrs.level}`:state?.selection.$from.parent.type.name==='code_block'?'code':'paragraph';
  const status=localError?'local-error':pendingLocal?'saving':node.pageSaveStatus||'saved';
  const problems=Object.values(node.pageDrafts||{}).filter(draft=>['conflict','uncertain'].includes(draft.status));
  const retry=async()=>{try{for(const record of records.current.values())if(record.failed||record.queued)await record.persistence.flush(undefined,{force:true});await invoke('page/retry',{boardId:board.id,nodeId:node.id})}catch(error){fail(error)}};
  const ask=(action='ask')=>{const view=viewRef.current;if(!view||!selection?.quote)return;const range={from:selection.from,to:selection.to};onAskSelection({blockId:selection.blockId,quote:selection.quote,action,range,context:pagePassageContext(view.state.doc,{blockId:selection.blockId,range}),rect:{left:selection.x,top:selection.y,bottom:selection.below}});setSelection(null)};
  const action=(title,Icon,fn,pressed=false)=> <button type="button" aria-label={title} title={title} aria-pressed={pressed} onMouseDown={event=>event.preventDefault()} onClick={fn}><Icon size={16}/></button>;
  const insertTable=()=>command((state,dispatch)=>{
    const cell=header=>(header?schema.nodes.table_header:schema.nodes.table_cell).createAndFill();
    const table=schema.nodes.table.create(null,[schema.nodes.table_row.create(null,[cell(true),cell(true)]),schema.nodes.table_row.create(null,[cell(false),cell(false)])]);
    dispatch(state.tr.replaceSelectionWith(table).scrollIntoView());setTableMenu(false);return true;
  });
  const statusView = <div className={`page-cloud-status is-${status}`} role="status" aria-live="polite" data-testid={`page-save-status-${node.id}`}>
      {status==='saved'?<Check size={12}/>:status==='saving'?<LoaderCircle size={12} className="spin"/>:status==='offline'?<CloudOff size={12}/>:['conflict','uncertain','local-error'].includes(status)?<AlertCircle size={12}/>:null}
      <span>{labels[status]||labels.pending}</span>{['offline','uncertain','local-error'].includes(status)&&<button type="button" onClick={retry}>Retry save</button>}
    </div>;
  return <>
    {saveSlot?createPortal(statusView,saveSlot):statusView}
    <div className={`page-rich-editor ${!snapshot.blocks.length?'is-empty':''}`} aria-busy={preparing} data-empty-placeholder={preparing?'Opening editor…':'Start writing…'} ref={mount}/>
    {localError&&<div className="page-rich-save-error" role="alert">{localError}</div>}
    {problems.map(draft=><div className="page-rich-conflict" role="alert" data-testid="page-edit-conflict" key={draft.blockId}>
      <strong>{draft.status==='uncertain'?'Check this save':'This passage changed in both places'}</strong><p>{draft.error}</p>
      <div><label>Your changes</label><pre>{draft.markdown}</pre><label>Latest Page</label><pre>{draft.remoteMarkdown??'Check the cloud version before replacing it.'}</pre></div>
      <div className="page-rich-conflict-actions"><button onClick={()=>invoke('page/retry',{boardId:board.id,nodeId:node.id}).catch(fail)}>Check cloud version</button>{draft.status==='conflict'&&<><button onClick={()=>invoke('page/resolve-draft',{boardId:board.id,nodeId:node.id,blockId:draft.blockId,revision:draft.revision,choice:'use-cloud'}).catch(fail)}>Use latest Page</button><button onClick={()=>invoke('page/resolve-draft',{boardId:board.id,nodeId:node.id,blockId:draft.blockId,revision:draft.revision,choice:'keep-local'}).catch(fail)}>Keep my changes</button></>}</div>
    </div>)}
    {selection&&active&&!link&&createPortal(<div className="page-rich-toolbar nodrag nopan" role="toolbar" aria-label="Text formatting" data-page-rich-toolbar="" style={{left:Math.min(Math.max(12,selection.x-360),Math.max(12,innerWidth-728)),top:selection.y>=104?selection.y-48:Math.min(innerHeight-100,selection.below+8)}}>
      <select aria-label="Text style" value={style} onMouseDown={event=>event.stopPropagation()} onChange={event=>{const value=event.target.value;command(setBlockType(value.startsWith('heading')?schema.nodes.heading:value==='code'?schema.nodes.code_block:schema.nodes.paragraph,value.startsWith('heading')?{level:+value.split('-')[1]}:undefined))}}><option value="paragraph">Paragraph</option><option value="heading-1">Heading 1</option><option value="heading-2">Heading 2</option><option value="heading-3">Heading 3</option><option value="code">Code block</option></select>
      <i/>{action('Bold',Bold,()=>mark('strong'),activeMark('strong'))}{action('Italic',Italic,()=>mark('em'),activeMark('em'))}{action('Underline',Underline,()=>mark('underline'),activeMark('underline'))}{action('Strikethrough',Strikethrough,()=>mark('strike'),activeMark('strike'))}{action('Code',Code,()=>mark('code'),activeMark('code'))}{action('Link',Link,()=>openLink(viewRef.current))}<i/>
      {action('Bulleted list',List,()=>command(listCommand(schema.nodes.bullet_list)))}{action('Numbered list',ListOrdered,()=>command(listCommand(schema.nodes.ordered_list)))}{action('Quote',Quote,()=>command(wrapIn(schema.nodes.blockquote)))}{action('Table',Table2,()=>setTableMenu(value=>!value))}<i/>{action('Undo',Undo2,()=>command(undo))}{action('Redo',Redo2,()=>command(redo))}<i/><button type="button" className="page-rich-ask" aria-label="Ask Codex" data-testid="page-selection-ask" onMouseDown={event=>event.preventDefault()} onClick={()=>ask()}><MessageCircle size={15}/>Ask Codex</button><button type="button" className="page-rich-ask" aria-label="Start side chat" data-testid="page-selection-side-chat" onMouseDown={event=>event.preventDefault()} onClick={()=>ask('side-chat')}><GitBranch size={15}/>Side chat</button>
      {tableMenu&&<div className="page-rich-table-menu"><button onMouseDown={event=>event.preventDefault()} onClick={insertTable}>Insert table</button>{[['Add row',addRowAfter],['Add column',addColumnAfter],['Delete row',deleteRow],['Delete column',deleteColumn],['Delete table',deleteTable]].map(([label,fn])=><button key={label} disabled={!state||!fn(state)} onMouseDown={event=>event.preventDefault()} onClick={()=>{command(fn);setTableMenu(false)}}>{label}</button>)}</div>}
    </div>,document.body)}
    {link&&createPortal(<div className="page-rich-link-scrim" data-page-rich-link="" onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();setLink(null);viewRef.current?.focus()}}} onMouseDown={event=>{if(event.target===event.currentTarget){setLink(null);viewRef.current?.focus()}}}><form className="page-rich-link-dialog" role="dialog" aria-modal="true" aria-label="Edit link" onSubmit={event=>{event.preventDefault();const href=link.url.trim();if(href&&!safeLink(href))return;const view=viewRef.current;if(view){let tr=view.state.tr.removeMark(link.from,link.to,schema.marks.link);if(href)tr=tr.addMark(link.from,link.to,schema.marks.link.create({href}));view.dispatch(tr);view.focus()}setLink(null)}}><label>Link URL<input aria-label="Link URL" autoFocus value={link.url} placeholder="https://" onChange={event=>setLink({...link,url:event.target.value})}/></label><div><button type="button" onClick={()=>{setLink(null);viewRef.current?.focus()}}>Cancel</button><button type="submit" disabled={!!link.url.trim()&&!safeLink(link.url.trim())}>Apply link</button></div></form></div>,document.body)}
  </>;
}
