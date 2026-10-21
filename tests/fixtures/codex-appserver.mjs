#!/usr/bin/env node
// Deterministic RPC peer for hidden Electron UI tests. Production cannot load it.
import fs from 'node:fs';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {pageToolFixture} from './page-tools.mjs';
const file=process.env.TANGENT_FIXTURE_STATE;
let threads={};try{threads=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
if(!threads['external-source'])threads['external-source']={id:'external-source',name:'An existing Codex conversation',preview:'Original conversation stays unchanged',cwd:'/tmp',createdAt:Date.now()/1000,updatedAt:Date.now()/1000,historyMode:'legacy',turns:[{id:'external-turn',status:'completed',items:[{id:'external-u',type:'userMessage',content:[{type:'text',text:'Remember imported_marker=EXTERNAL-42.'}]},{id:'external-a',type:'agentMessage',text:'Remembered EXTERNAL-42.'}]}]};
const send=f=>process.stdout.write(JSON.stringify(f)+'\n');
const ephemeralThreads=new Set(),summaryThreads=new Set();
const save=()=>{if(file){const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;fs.writeFileSync(temp,JSON.stringify(Object.fromEntries(Object.entries(threads).filter(([id])=>!ephemeralThreads.has(id)))));fs.renameSync(temp,file)}};
const waiting=new Map(),timers=new Map();
function finish(thread,turn,text,status='completed'){
  if(turn.status!=='inProgress')return;
  const item={id:`a-${turn.id}`,type:'agentMessage',text,phase:'final'};
  turn.items.push(item);send({method:'item/started',params:{threadId:thread.id,turnId:turn.id,item:{...item,text:''}}});
  send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:text.slice(0,Math.ceil(text.length/2))}});
  setTimeout(()=>{if(turn.status!=='inProgress')return;send({method:'item/agentMessage/delta',params:{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:text.slice(Math.ceil(text.length/2))}});send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});turn.status=status;save();send({method:'turn/completed',params:{threadId:thread.id,turn}})},60);
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  const f=JSON.parse(line),p=f.params||{};if(!f.method){const pending=waiting.get(f.id);if(pending){waiting.delete(f.id);pending(f)}return}if(f.id===undefined)return;
  if(process.env.TANGENT_FIXTURE_RPC_LOG)fs.appendFileSync(process.env.TANGENT_FIXTURE_RPC_LOG,JSON.stringify({method:f.method,...(f.method==='thread/start'&&p.ephemeral&&p.model==='gpt-6-luna'?{summary:true,model:p.model,effort:p.config?.model_reasoning_effort,serviceTier:p.serviceTier,ephemeral:p.ephemeral,sandbox:p.sandbox,approvalPolicy:p.approvalPolicy}:{}),...(f.method==='turn/start'&&summaryThreads.has(p.threadId)?{summary:true,model:p.model,effort:p.effort,serviceTierForTurn:p.serviceTierForTurn}:{}),...(p.threadId?{threadId:p.threadId}:{}),...(f.method==='mcpServer/tool/call'?{server:p.server,tool:p.tool,pageId:p.arguments?.page_id}:{} )})+'\n');
  const ok=result=>send({id:f.id,result});const fail=message=>send({id:f.id,error:{code:-32602,message}});
  if(f.method==='initialize')return ok({userAgent:'deterministic-ui-fixture'});
  if(f.method==='mcpServer/tool/call'){try{const result=pageToolFixture(p);if(result===undefined)return fail('Test Pages connector is not configured.');return Promise.resolve(result).then(ok,error=>fail(error.message||'Test Pages connector failed.'))}catch(error){return fail(error.message||'Test Pages connector failed.')}}
  if(f.method==='account/read')return ok({account:{type:'chatgpt',planType:'pro'},requiresOpenaiAuth:true});
  if(f.method==='model/list')return ok({data:[{id:'fixture-model',model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]},{id:'fixture-model-two',model:'gpt-6-sol',displayName:'GPT-6 Sol',isDefault:false,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]},{id:'gpt-6-luna',model:'gpt-6-luna',displayName:'GPT-6 Luna',isDefault:false,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'minimal'},{reasoningEffort:'low'},{reasoningEffort:'medium'}],serviceTiers:[{id:'priority',name:'Fast',description:'Fixture Fast mode'}]}]});
  if(f.method==='thread/start'){const id=randomUUID();if(p.ephemeral)ephemeralThreads.add(id);if(p.ephemeral&&p.model==='gpt-6-luna')summaryThreads.add(id);threads[id]={id,turns:[],historyMode:'legacy',cwd:p.cwd,createdAt:Date.now()/1000,updatedAt:Date.now()/1000};save();return ok({thread:threads[id],model:p.model,serviceTier:p.serviceTier,reasoningEffort:p.config?.model_reasoning_effort})}
  if(f.method==='thread/read'||f.method==='thread/resume')return threads[p.threadId]?ok({thread:threads[p.threadId]}):fail('Thread not found');
  if(f.method==='thread/list')return ok({data:Object.values(threads).filter(t=>!p.searchTerm||`${t.name||''} ${t.preview||''}`.toLowerCase().includes(p.searchTerm.toLowerCase())),nextCursor:null});
  if(f.method==='thread/fork'){
    const source=threads[p.threadId];if(!source)return fail('Source not found');
    const index=p.lastTurnId?source.turns.findIndex(t=>t.id===p.lastTurnId):source.turns.length-1;if(index<0&&p.lastTurnId)return fail('Turn not found');
    const thread={...structuredClone(source),id:randomUUID(),turns:structuredClone(source.turns.slice(0,index+1))};threads[thread.id]=thread;save();return ok({thread});
  }
  if(f.method==='thread/goal/get')return ok({goal:null});
  if(f.method==='thread/goal/clear'||f.method==='thread/archive'||f.method==='thread/unsubscribe')return ok({});
  if(f.method==='thread/name/set'){threads[p.threadId].name=p.name;save();return ok({})}
  if(f.method==='turn/start'){
    const thread=threads[p.threadId],text=p.input.map(i=>i.text||'').join('\n');
    if(summaryThreads.has(p.threadId)){
      if(text.includes('CARD_SUMMARY_ERROR_TEST'))return fail('Simulated summary failure');
      const title=text.match(/Title: ([^\n]*)/)?.[1]||'Canvas card',turn={id:randomUUID(),status:'inProgress',items:[]};
      thread.turns.push(turn);ok({turn});send({method:'turn/started',params:{threadId:thread.id,turn}});
      const timer=setTimeout(()=>finish(thread,turn,`Summary: ${title}.`),text.includes('CARD_SUMMARY_SLOW_TEST')?900:100);timers.set(turn.id,timer);return;
    }
    if(text.includes('THROW_TEST'))return fail('Simulated connection failure');
    const turn={id:randomUUID(),status:'inProgress',startedAt:Date.now()/1000,items:[{id:randomUUID(),type:'userMessage',content:p.input}]};thread.turns.push(turn);thread.preview=text;save();ok({turn});
    send({method:'turn/started',params:{threadId:thread.id,turn}});
    if(text.includes('INLINE_IMAGE_TEST')){
      const item={type:'imageGeneration',id:randomUUID(),status:'completed',savedPath:process.env.TANGENT_TEST_IMAGE,revisedPrompt:'A generated inline image',result:''};
      const comment={id:`intro-${turn.id}`,type:'agentMessage',text:'Here is the illustration you requested.'};turn.items.push(comment);send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item:comment}});
      const timer=setTimeout(()=>{if(turn.status!=='inProgress')return;turn.items.push(item);save();send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});finish(thread,turn,'The image belongs to the second question.');},500);timers.set(turn.id,timer);return;
    }
    if(text.includes('SLOW_TEST')){const timer=setTimeout(()=>finish(thread,turn,'Slow answer finished.'),15000);timers.set(turn.id,timer);return}
    if(text.includes('APPROVAL_MCP_TEST')){
      const requestId=randomUUID();waiting.set(requestId,response=>finish(thread,turn,response.result?.action==='accept'?'Connected tool permission accepted.':'Connected tool permission declined.'));
      return send({id:requestId,method:'mcpServer/elicitation/request',params:{threadId:thread.id,turnId:turn.id,serverName:'codex_apps',mode:'form',message:'Do you approve running tool "chatgpt_space.create_page"?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_params:{title:'A deterministic private test Page',api_key:'fixture-secret-must-be-redacted'}}}});
    }
    if(text.includes('APPROVAL_TEST')||text.includes('QUESTION_TEST')){
      const requestId=randomUUID();waiting.set(requestId,response=>finish(thread,turn,text.includes('QUESTION_TEST')?'Your answer was received.':response.result?.decision==='accept'?'Permission accepted.':'Permission declined.'));
      return send({id:requestId,method:text.includes('QUESTION_TEST')?'item/tool/requestUserInput':'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn.id,itemId:randomUUID(),command:'echo test-only',cwd:thread.cwd,reason:'Deterministic UI approval test',questions:[{id:'choice',header:'Choose',question:'Which direction?',options:[{label:'Explore',description:'Continue exploring'},{label:'Finish',description:'Finish this task'}]}]}});
    }
    if(text.includes('DOCUMENT_TEST')){
      const requestId=randomUUID(),image=process.env.TANGENT_TEST_IMAGE;
      send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item:{type:'imageGeneration',id:randomUUID(),status:'completed',savedPath:image,revisedPrompt:'A test image',result:''}}});
      waiting.set(requestId,response=>finish(thread,turn,response.result?.success?'Created the document with its inline image.':'Document tool failed.'));
      return send({id:requestId,method:'item/tool/call',params:{threadId:thread.id,turnId:turn.id,callId:requestId,namespace:null,tool:'canvas_document',arguments:{action:'create',title:'An illustrated document',markdown:`# An illustrated document\n\nA real document card.\n\n![Canvas illustration](${image})\n\n## Next steps\n\nKeep exploring.`}}});
    }
    const exact=text.match(/Reply exactly:\s*([^\n]+)$/i);
    const context=thread.turns.flatMap(t=>t.items).map(i=>i.text||(i.content||[]).map(x=>x.text||'').join(' ')).join(' ');
    const markers=[...new Set(context.match(/(?:MARBLE|ORBIT|BRONZE|EXTERNAL)-\d+/g)||[])];
    return finish(thread,turn,text.includes('TEST_CONTEXT')?`Visible markers: ${markers.join(', ')||'NONE'}`:exact?exact[1]:`A thoughtful answer to your question.`);
  }
  if(f.method==='turn/steer'){
    // Optional file control exposes real asynchronous delivery states to hidden
    // renderer tests. Existing fixtures retain immediate accepted steering.
    let control={};try{if(process.env.TANGENT_FIXTURE_STEER_CONTROL)control=JSON.parse(fs.readFileSync(process.env.TANGENT_FIXTURE_STEER_CONTROL,'utf8'))}catch{}
    const deliver=()=>{
      const thread=threads[p.threadId],turn=thread?.turns.find(t=>t.id===p.expectedTurnId&&t.status==='inProgress');
      if(!turn)return fail('The expected turn is no longer active.');
      if(control.mode==='reject')return fail('Simulated steering rejection.');
      const text=(p.input||[]).map(i=>i.text||'').join('\n');if(!text.trim())return fail('Steering input cannot be empty.');
      const user={id:randomUUID(),clientId:p.clientUserMessageId||null,type:'userMessage',content:p.input};turn.items.push(user);save();
      ok({turnId:turn.id});send({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item:user}});
      clearTimeout(timers.get(turn.id));
      const exact=text.match(/Reply exactly:\s*([^\n]+)$/i);
      const timer=setTimeout(()=>finish(thread,turn,exact?exact[1]:'The active turn followed your new direction.'),250);timers.set(turn.id,timer);
    };
    if(Number(control.delayMs)>0)setTimeout(deliver,Math.min(5000,Number(control.delayMs)));else deliver();return;
  }
  if(f.method==='turn/interrupt'){
    const thread=threads[p.threadId],turn=thread?.turns.find(t=>t.id===p.turnId);clearTimeout(timers.get(p.turnId));if(turn){turn.status='interrupted';send({method:'turn/completed',params:{threadId:thread.id,turn}});save()}return ok({});
  }
  return fail(`Unsupported fixture method ${f.method}`);
});
