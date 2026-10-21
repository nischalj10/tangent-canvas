// Test-only authenticated Pages peer. Never reads or writes a remote Page.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(value).digest('hex');
const INTERACTIVE='page_NativeInteractive123456';
const interactiveHtml='<!doctype html><meta charset="utf-8"><title>Isolated interactive fixture</title><style>body{font:16px system-ui;padding:20px}button{padding:12px}</style><h2>Interactive capability fixture</h2><button id="increment">Increment visualization</button><output id="value">0</output><script>increment.onclick=()=>value.textContent=String(Number(value.textContent)+1)</script>';
const interactiveRef='visualize:fixtureInteractive';
const syntheticBlocks=[['capability-heading-1','# Interactive capability fixture'],['capability-intro','This separate fixture tests heading navigation and interactive HTML without changing the actual biology Page.'],['capability-heading-2','## Interactive visualization'],['interactive-block',`![Interactive capability](${interactiveRef})`],['capability-heading-3','### Nested heading navigation'],['capability-tail','This is local capability-test content, separate from the original Page. '.repeat(100)]].map(([id,markdown])=>({id,kind:'markdown',hash:hash(markdown),markdown,metadata:{}}));
export function pageToolFixture(params){
  const directory=process.env.TANGENT_PAGE_FIXTURE_DIR;
  if(!directory||params.server!=='codex_apps'||!params.tool?.startsWith('chatgpt_space.'))return undefined;
  const tool=params.tool.slice('chatgpt_space.'.length),args=params.arguments||{};
  const stateFile=process.env.TANGENT_PAGE_FIXTURE_STATE,controlFile=process.env.TANGENT_PAGE_FIXTURE_CONTROL;
  const control=(()=>{try{return JSON.parse(fs.readFileSync(controlFile,'utf8'))}catch{return{}}})();
  const log=process.env.TANGENT_PAGE_FIXTURE_LOG;
  if(log)fs.appendFileSync(log,JSON.stringify({tool,server:params.server,threadId:params.threadId,pageId:args.page_id,reference:args.reference,operation:args.operations?.[0]?.op,blockId:args.operations?.[0]?.block_id,expectedHash:args.operations?.[0]?.expected_hash,...(args.operations?{operations:args.operations.map(op=>({op:op.op,blockId:op.block_id||'__title__',expectedHash:op.expected_hash||op.expected_title_hash}))}:{})})+'\n');
  const error=(code,message)=>({isError:true,content:[],structuredContent:{error:{code,message}}});
  if(control.offline)return error('FIXTURE_OFFLINE','The test Pages connection is offline. Your cached Page is still available.');
  let state;
  try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'))}catch{
    state={page:JSON.parse(fs.readFileSync(path.join(directory,'page.json'),'utf8')),comments:JSON.parse(fs.readFileSync(path.join(directory,'comments.json'),'utf8'))};
  }
  const save=()=>{if(stateFile){const temp=`${stateFile}.${process.pid}.${randomUUID()}.tmp`;fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,stateFile)}};
  const external=control.externalEdit;
  if(external&&state.appliedExternal!==JSON.stringify(external)){
    const block=state.page.content.blocks.find(b=>b.id===external.blockId);if(block){block.markdown=external.markdown;block.hash=hash(external.markdown);state.page.content.markdown=state.page.content.blocks.map(b=>b.markdown).join('\n\n');state.appliedExternal=JSON.stringify(external);save()}
  }
  const synthetic=args.page_id===INTERACTIVE;
  if(args.page_id!==state.page.content.page_id&&!synthetic)return error('NOT_FOUND','Unknown test Page.');
  const page=synthetic?{metadata:{page_id:INTERACTIVE,url:`https://chatgpt.com/space/${INTERACTIVE}`,access:{can_read:true,can_write:true}},content:{page_id:INTERACTIVE,title:'Interactive HTML capability',title_hash:hash('Interactive HTML capability'),schema_version:2,blocks:syntheticBlocks},references:[{reference:interactiveRef,mime_type:'text/html',byte_size:Buffer.byteLength(interactiveHtml)}]}:state.page;
  const ok=structuredContent=>({isError:false,content:[],structuredContent:clone(structuredContent)});
  if(tool==='read_page'){save();return ok(page)}
  if(tool==='list_page_comments')return ok(synthetic?{page_id:INTERACTIVE,threads:[],truncated:false}:state.comments);
  if(tool==='read_page_reference'){
    if(synthetic){if(args.reference!==interactiveRef)return error('NOT_FOUND','Unknown test reference.');return ok({page_id:INTERACTIVE,reference:interactiveRef,kind:'text',mime_type:'text/html',byte_size:Buffer.byteLength(interactiveHtml),sha256:hash(interactiveHtml),text:interactiveHtml,text_representation:'source',text_byte_size:Buffer.byteLength(interactiveHtml)})}
    const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8')),asset=manifest.assets.find(a=>a.reference===args.reference);
    if(!asset)return error('NOT_FOUND','Reference is not in the actual authorized test snapshot.');
    const bytes=fs.readFileSync(path.join(directory,asset.file));if(hash(bytes)!==asset.sha256)return error('BAD_FIXTURE','Original test asset digest changed.');
    const metadata={page_id:args.page_id,reference:asset.reference,mime_type:asset.mime_type,byte_size:bytes.length,sha256:asset.sha256,kind:asset.kind,text:asset.kind==='text'?bytes.toString('utf8'):null,text_representation:asset.kind==='text'?'source':null,text_byte_size:asset.kind==='text'?bytes.length:null};
    const result=ok(metadata);if(asset.kind==='image')result.content.push({type:'image',mimeType:asset.mime_type,data:bytes.toString('base64')});return result;
  }
  if(tool==='edit_page'){
    if(synthetic)return error('NOT_WRITABLE','The capability fixture is read-only.');
    const operations=args.operations||[];
    const markdownOf=op=>typeof op.markdown==='string'?op.markdown:Array.isArray(op.block_units)&&op.block_units.every(unit=>unit.kind==='markdown'&&typeof unit.markdown==='string')?op.block_units.map(unit=>unit.markdown).join('\n\n'):null;
    const editId=randomUUID(),event=(name,extra={})=>{if(log)fs.appendFileSync(log,JSON.stringify({event:name,editId,pageId:args.page_id,blockIds:operations.map(op=>op.block_id||'__title__'),at:Date.now(),...extra})+'\n')};
    event('edit-start');
    for(const op of operations){
      if(op.op==='set_title'){if(typeof op.title!=='string'||op.expected_title_hash!==state.page.content.title_hash)return error('edit_conflict','The original test title changed.');continue}
      if(op.op==='insert_markdown'){
        if(operations.length!==1||state.page.content.blocks.length||op.at?.kind!=='between_blocks'||op.at.preceding_block_id!==null||op.at.following_block_id!==null||op.block_units?.length!==1||op.block_units[0]?.kind!=='markdown'||op.block_units[0]?.markdown!=='')return error('edit_conflict','A first paragraph can be inserted only into the observed empty Page.');
        continue;
      }
      const block=state.page.content.blocks.find(b=>b.id===op.block_id);if(!block||block.hash!==op.expected_hash||!['replace_block_markdown','delete_block'].includes(op.op)||op.op==='replace_block_markdown'&&markdownOf(op)===null)return error('edit_conflict','The original test block changed.');
    }
    const results=[];
    for(const[operation_index,op]of operations.entries()){
      const result={operation_index,status:'applied',affected_blocks:[],created_block_ids:[],continuation_position:null,preceding_block_id:null};
      if(op.op==='set_title'){state.page.content.title=op.title;state.page.content.title_hash=hash(op.title);state.page.metadata.title=op.title;results.push(result);continue}
      if(op.op==='insert_markdown'){
        const created={id:`fixture-created-${randomUUID()}`,kind:'markdown',markdown:'',hash:hash(''),metadata:{}};state.page.content.blocks.push(created);result.affected_blocks=[{block_id:created.id,hash:created.hash}];result.created_block_ids=[created.id];results.push(result);continue;
      }
      const index=state.page.content.blocks.findIndex(block=>block.id===op.block_id),block=state.page.content.blocks[index];
      if(op.op==='delete_block'){state.page.content.blocks.splice(index,1);results.push(result);continue}
      const markdown=markdownOf(op);
      // Opt-in native behavior: one Markdown replacement may expand into several
      // canonical blocks. The first ID/metadata survive; receipts map the rest.
      const fragments=control.splitCanonicalBlocks?markdown.split(/\n[ \t]*\n+/).filter(Boolean):[markdown];
      const replacements=(fragments.length?fragments:['']).map((text,i)=>i?{id:`fixture-created-${randomUUID()}`,kind:'markdown',markdown:text,hash:hash(text),metadata:{}}:{...block,markdown:text,hash:hash(text)});
      state.page.content.blocks.splice(index,1,...replacements);
      result.affected_blocks=replacements.map(item=>({block_id:item.id,hash:item.hash}));result.created_block_ids=replacements.slice(1).map(item=>item.id);results.push(result);
    }
    state.page.content.markdown=state.page.content.blocks.map(b=>b.markdown).join('\n\n');save();
    event('edit-applied',{affected:results.flatMap(result=>result.affected_blocks),created:results.flatMap(result=>result.created_block_ids),mappings:results.map((result,i)=>({blockId:operations[i].block_id||'__title__',affected:result.affected_blocks,created:result.created_block_ids,deleted:operations[i].op==='delete_block'}))});
    const receipt=()=>{event('edit-receipt');return ok({operation_results:control.omitEditReceipt?[]:results})};
    const delay=Math.min(10000,Math.max(0,Number(control.editDelayMs)||0));
    return delay?new Promise(resolve=>setTimeout(()=>resolve(receipt()),delay)):receipt();
  }
  return error('UNSUPPORTED_FIXTURE',`Unsupported Page fixture tool ${tool}`);
}
