// Search logical reading surfaces without touching their histories or DOM.
// The renderer can normalize Markdown and filter visible-only discussion items.
export function buildScreenSearchScope({board,fullChatId=null,pageId=null,pageView='full',floating=[],discussionChatId=null}={}){
  const nodes=(Array.isArray(board?.nodes)?board.nodes:[]).filter(node=>node&&typeof node.id==='string'&&!node.archived);
  const byId=new Map(nodes.map(node=>[node.id,node])),items=[],seen=new Set();
  const conversation=node=>node&&['chat','comment'].includes(node.kind);
  const editableKinds=new Set(['title','note','document','draft','page-block']);
  const add=item=>{
    // An empty durable value can already contain fresh unsaved text in its
    // editor. Keep its stable address for the live DOM index to read on input.
    if(typeof item.text!=='string'||!item.text.trim()&&!editableKinds.has(item.kind)||seen.has(item.id))return;
    seen.add(item.id);items.push(item);
  };
  const pageTitle=node=>{
    const draft=node.pageDrafts?.__title__?.markdown;
    if(typeof draft==='string')return draft;
    return typeof node.pageSnapshot?.title==='string'?node.pageSnapshot.title:node.title;
  };
  const addPageBlocks=(node,options)=>{
    const blocks=(Array.isArray(node.pageSnapshot?.blocks)?node.pageSnapshot.blocks:[]).filter(block=>block&&typeof block.id==='string');
    const positions=new Map(blocks.map((block,index)=>[block.id,index])),covered=new Set();
    for(const block of blocks){
      if(!block||typeof block.id!=='string'||covered.has(block.id))continue;
      const draft=node.pageDrafts?.[block.id],targets=draft?.targets;
      // A rich draft may own several newly split canonical paragraphs. Index
      // its joined replacement once, but never hide stale/unrelated targets.
      if(typeof draft?.markdown==='string'&&Array.isArray(targets)&&targets.length>1&&targets[0]?.id===block.id){
        const start=positions.get(block.id);
        if(targets.every((target,index)=>positions.get(target?.id)===start+index))
          targets.slice(1).forEach(target=>covered.add(target.id));
      }
      add({id:`${node.id}:page-block:${block.id}`,nodeId:node.id,blockId:block.id,kind:'page-block',text:typeof draft?.markdown==='string'?draft.markdown:block.markdown,...options});
    }
  };
  const addPageComments=node=>{
    const original=node.pageSnapshot?.comments,threads=Array.isArray(original)?original:Array.isArray(original?.threads)?original.threads:[];
    for(const [threadIndex,thread]of threads.entries()){
      if(!thread)continue;
      const commentThreadId=typeof thread.id==='string'?thread.id:String(threadIndex);
      const blockId=thread.selectionContext?.start?.blockId||thread.target?.anchor?.blockId||thread.target?.blockId||thread.blockId;
      const anchor=typeof blockId==='string'?{blockId}:{};
      const prefix=`${node.id}:page-comment:${commentThreadId}`;
      add({id:`${prefix}:quote`,nodeId:node.id,commentThreadId,...anchor,kind:'page-comment-quote',text:thread.selectionContext?.text||thread.quote,markdown:false,visibleOnly:true});
      for(const [messageIndex,message]of (Array.isArray(thread.messages)?thread.messages:[]).entries()){
        if(!message||message.deletedAt)continue;
        const commentMessageId=typeof message.id==='string'?message.id:String(messageIndex);
        // Metadata, authors, tool payloads and deleted messages are not rendered
        // comment text. The DOM decides whether a collapsed reply is visible.
        add({id:`${prefix}:message:${commentMessageId}`,nodeId:node.id,commentThreadId,commentMessageId,...anchor,kind:'page-comment',text:message.body,visibleOnly:true});
      }
    }
  };
  const addNode=(node,{titleOnly=false,visibleOnly=false,pageDraftVisibleOnly=false}={})=>{
    if(!node||node.archived)return;
    const options=visibleOnly?{visibleOnly:true}:{};
    add({id:`${node.id}:title`,nodeId:node.id,kind:'title',text:node.kind==='page'?pageTitle(node):node.title,markdown:false,...(node.kind==='page'?{blockId:'__title__'}:{}),...options});
    if(titleOnly)return;
    const messageIds=new Map();
    for(const [index,message]of (Array.isArray(node.messages)?node.messages:[]).entries()){
      if(!message||!['user','assistant'].includes(message.role))continue;
      const messageId=typeof message.id==='string'?message.id:String(index),occurrence=messageIds.get(messageId)||0;
      messageIds.set(messageId,occurrence+1);
      const entryId=`${node.id}:message:${messageId}${occurrence?`:duplicate:${occurrence}`:''}`;
      if(message.role==='user')add({id:`${entryId}:quote`,nodeId:node.id,messageId,kind:'message-quote',text:message.quote,markdown:false,...options});
      add({id:entryId,nodeId:node.id,messageId,kind:'message',text:message.text,...options});
    }
    if(node.kind==='note')add({id:`${node.id}:note`,nodeId:node.id,kind:'note',text:node.noteText,markdown:false,...options});
    if(node.kind==='document')add({id:`${node.id}:document`,nodeId:node.id,kind:'document',text:node.documentMarkdown,...options});
    if(node.kind==='page'){addPageBlocks(node,options);addPageComments(node)}
    add({id:`${node.id}:draft`,nodeId:node.id,kind:'draft',text:node.draft,markdown:false,...options,...(pageDraftVisibleOnly?{visibleOnly:true}:{})});
  };
  const addFloating=()=>{
    for(const view of Array.isArray(floating)?floating:[]){
      const node=byId.get(view?.nodeId);
      if(conversation(node))addNode(node,{titleOnly:view.minimized===true});
    }
  };

  if(fullChatId!==null){
    const node=byId.get(fullChatId);if(conversation(node))addNode(node);
    addFloating();return{label:'This conversation',items};
  }
  if(pageId!==null&&pageView!=='half'){
    const node=byId.get(pageId);if(node?.kind==='page')addNode(node,{pageDraftVisibleOnly:true});
    const discussion=byId.get(discussionChatId);if(conversation(discussion))addNode(discussion,{visibleOnly:true});
    addFloating();return{label:'This Page',items};
  }
  nodes.forEach(node=>addNode(node));
  // Half-view retains the complete canvas scope; item IDs suppress duplicate
  // references when the same conversation also appears in a floating window.
  addFloating();
  return{label:'Canvas',items};
}
