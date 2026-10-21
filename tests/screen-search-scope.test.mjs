import test from 'node:test';
import assert from 'node:assert/strict';
import {buildScreenSearchScope} from '../src/screen-search-scope.mjs';

const deepFreeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(deepFreeze)}return value};
const chat=(id,extra={})=>({id,kind:'chat',title:`Title ${id}`,messages:[{id:'shared-native-message',role:'assistant',text:`Answer ${id}`}],draft:'',...extra});
const page=(id,extra={})=>({id,kind:'page',title:`Card ${id}`,messages:[],draft:'',pageSnapshot:{title:`Page ${id}`,blocks:[{id:'intro',markdown:`Intro ${id}`},{id:'body',markdown:`Body ${id}`}],comments:[]},...extra});
const texts=scope=>scope.items.map(item=>item.text);

test('canvas search includes offscreen and collapsed cards, local content and drafts, but excludes archived and hidden payloads',()=>{
  const board=deepFreeze({nodes:[chat('a',{collapsed:true,position:{x:99999,y:-99999},draft:'Unsent draft',activities:[{details:'HIDDEN TOOL PAYLOAD'}],generatedImages:[{prompt:'HIDDEN IMAGE PROMPT'}]}),chat('b'),{id:'note',kind:'note',title:'Plain title **literal**',noteText:'Plain note **literal**',messages:[],draft:''},{id:'doc',kind:'document',title:'Local research',documentMarkdown:'# Local **document**',messages:[],draft:''},page('p'),chat('archived',{archived:true})]});
  const scope=buildScreenSearchScope({board});assert.equal(scope.label,'Canvas');
  for(const expected of ['Answer a','Answer b','Unsent draft','Plain note **literal**','# Local **document**','Intro p','Body p'])assert.ok(texts(scope).includes(expected));
  assert.ok(scope.items.every(item=>item.nodeId!=='archived'));assert.ok(texts(scope).every(text=>!text.includes('HIDDEN')));
  assert.equal(new Set(scope.items.map(item=>item.id)).size,scope.items.length);
  assert.equal(scope.items.find(item=>item.kind==='note').markdown,false);assert.equal(scope.items.find(item=>item.kind==='draft').markdown,false);
  assert.ok(scope.items.filter(item=>item.kind==='title').every(item=>item.markdown===false));
});

test('full-screen conversation search includes only that chat and its open floating conversations',()=>{
  const board={nodes:[chat('main'),chat('floating'),chat('minimized'),chat('background'),page('p'),chat('archived',{archived:true})]};
  const scope=buildScreenSearchScope({board,fullChatId:'main',pageId:'p',floating:[{nodeId:'floating',minimized:false},{nodeId:'minimized',minimized:true},{nodeId:'archived',minimized:false},{nodeId:'missing'}]});
  assert.equal(scope.label,'This conversation');assert.deepEqual([...new Set(scope.items.map(item=>item.nodeId))],['main','floating','minimized']);
  assert.ok(texts(scope).includes('Answer main'));assert.ok(texts(scope).includes('Answer floating'));assert.ok(!texts(scope).includes('Answer minimized'));
  assert.equal(scope.items.filter(item=>item.nodeId==='minimized').length,1);
});

test('full Page search excludes background cards and conditionally indexes the supplied discussion as visible-only',()=>{
  const board={nodes:[page('p'),page('other'),chat('discussion',{draft:'Pending discussion input'}),chat('floating'),chat('background')]};
  const scope=buildScreenSearchScope({board,pageId:'p',pageView:'full',discussionChatId:'discussion',floating:[{nodeId:'floating',minimized:false}]});
  assert.equal(scope.label,'This Page');assert.deepEqual([...new Set(scope.items.map(item=>item.nodeId))],['p','discussion','floating']);
  assert.ok(scope.items.filter(item=>item.nodeId==='discussion').every(item=>item.visibleOnly===true));
  assert.ok(scope.items.filter(item=>item.nodeId!=='discussion'&&!(item.nodeId==='p'&&item.kind==='draft')).every(item=>!item.visibleOnly));
  assert.equal(scope.items.find(item=>item.nodeId==='p'&&item.kind==='draft').visibleOnly,true,'Page Ask input must be filtered when its panel is closed');
  const closed=buildScreenSearchScope({board,pageId:'p',pageView:'full'});assert.ok(closed.items.every(item=>item.nodeId==='p'));
});

test('half Page view searches the entire canvas while deduplicating floating and discussion references',()=>{
  const board={nodes:[page('p'),chat('discussion'),chat('floating'),chat('background')]};
  const scope=buildScreenSearchScope({board,pageId:'p',pageView:'half',discussionChatId:'discussion',floating:[{nodeId:'floating',minimized:false},{nodeId:'p'}]});
  assert.equal(scope.label,'Canvas');assert.ok(texts(scope).includes('Answer background'));
  assert.equal(new Set(scope.items.map(item=>item.id)).size,scope.items.length);assert.ok(scope.items.every(item=>!item.visibleOnly));
});

test('joined rich Page drafts replace their canonical span once, including multiple independent drafts',()=>{
  const node=page('p',{pageSnapshot:{title:'Canonical title',blocks:[{id:'a',markdown:'Old first'},{id:'a-created',markdown:'Old second'},{id:'b',markdown:'Old third'},{id:'b-created',markdown:'Old fourth'},{id:'untouched',markdown:'Untouched paragraph'}],media:[{prompt:'HIDDEN MEDIA PROMPT'}]},pageDrafts:{__title__:{markdown:'Locally edited title'},a:{blockId:'a',markdown:'New first\n\nNew second',editorJSON:{hidden:'DO NOT INDEX EDITOR PAYLOAD'},targets:[{id:'a'},{id:'a-created'}]},b:{blockId:'b',markdown:'New third\n\nNew fourth',targets:[{id:'b'},{id:'b-created'}]}}});
  const board=deepFreeze({nodes:[node]});const scope=buildScreenSearchScope({board,pageId:'p'}),blocks=scope.items.filter(item=>item.kind==='page-block');
  assert.deepEqual(blocks.map(item=>[item.blockId,item.text]),[['a','New first\n\nNew second'],['b','New third\n\nNew fourth'],['untouched','Untouched paragraph']]);
  assert.equal(scope.items.find(item=>item.kind==='title').text,'Locally edited title');assert.ok(texts(scope).every(text=>!text.includes('HIDDEN')&&!text.includes('EDITOR PAYLOAD')));
});

test('stale or non-contiguous draft targets never hide unrelated canonical blocks',()=>{
  const node=page('p',{pageSnapshot:{title:'Title',blocks:[{id:'a',markdown:'First'},{id:'middle',markdown:'Keep middle'},{id:'later',markdown:'Keep later'}]},pageDrafts:{a:{markdown:'Local first',targets:[{id:'a'},{id:'later'}]}}});
  const scope=buildScreenSearchScope({board:{nodes:[node]}});assert.ok(texts(scope).includes('Local first'));assert.ok(texts(scope).includes('Keep middle'));assert.ok(texts(scope).includes('Keep later'));
});

test('two Pages with identical canonical block IDs retain independent local drafts and search identities',()=>{
  const board=deepFreeze({nodes:[page('one',{pageDrafts:{intro:{markdown:'Only the first Page draft'}}}),page('two',{pageDrafts:{intro:{markdown:'Only the second Page draft'}}})]});
  const before=JSON.stringify(board),scope=buildScreenSearchScope({board});
  const drafts=scope.items.filter(item=>item.kind==='page-block'&&item.blockId==='intro');
  assert.deepEqual(drafts.map(item=>[item.nodeId,item.text]),[['one','Only the first Page draft'],['two','Only the second Page draft']]);
  assert.notEqual(drafts[0].id,drafts[1].id);assert.equal(JSON.stringify(board),before,'Building the search scope must not rewrite Page history or draft ownership');
});

test('scope item identity is stable across text edits, unique between cards, and contains native message provenance',()=>{
  const board={nodes:[chat('a'),chat('b')]};const first=buildScreenSearchScope({board});
  const edited=structuredClone(board);edited.nodes[0].messages[0].text='Edited answer';const second=buildScreenSearchScope({board:edited});
  assert.deepEqual(first.items.map(item=>item.id),second.items.map(item=>item.id));
  const messages=second.items.filter(item=>item.kind==='message');assert.equal(messages.length,2);assert.notEqual(messages[0].id,messages[1].id);assert.equal(messages[0].messageId,'shared-native-message');
});

test('visible user-message quotations have separate plain-text search entries without indexing hidden assistant quote payloads',()=>{
  const board=deepFreeze({nodes:[chat('quoted-chat',{messages:[{id:'user-question',role:'user',quote:'Visible quoted **literal** passage',text:'Explain this selection'},{id:'assistant-answer',role:'assistant',quote:'HIDDEN ASSISTANT QUOTE',text:'An actual visible answer'},{id:'empty-quote',role:'user',quote:'',text:'No quotation'}]})]});
  const scope=buildScreenSearchScope({board,fullChatId:'quoted-chat'}),quotes=scope.items.filter(item=>item.kind==='message-quote');
  assert.deepEqual(quotes,[{id:'quoted-chat:message:user-question:quote',nodeId:'quoted-chat',messageId:'user-question',kind:'message-quote',text:'Visible quoted **literal** passage',markdown:false}]);
  assert.ok(scope.items.some(item=>item.kind==='message'&&item.messageId==='user-question'&&item.text==='Explain this selection'));
  assert.ok(texts(scope).every(text=>!text.includes('HIDDEN ASSISTANT QUOTE')));
  assert.ok(scope.items.indexOf(quotes[0])<scope.items.findIndex(item=>item.kind==='message'&&item.messageId==='user-question'),'Quotation order follows its placement above the user message body');
});

test('Page comment scope indexes only original message bodies and anchor quotes, with DOM visibility required',()=>{
  const board=deepFreeze({nodes:[page('p',{pageSnapshot:{title:'Page title',blocks:[{id:'body',markdown:'Page content'}],comments:{threads:[{id:'thread-a',selectionContext:{text:'Visible anchor quotation',start:{blockId:'body'}},metadata:{raw:'HIDDEN THREAD METADATA'},messages:[{id:'first',body:'First **original comment**',author:{name:'HIDDEN AUTHOR'}},{id:'middle',body:'A middle reply revealed only after expansion'},{id:'last',body:'Latest original reply'},{id:'deleted',body:'HIDDEN DELETED COMMENT',deletedAt:'2026-10-19'}]},{id:'thread-b',quote:'Fallback anchor quote',target:{anchor:{blockId:'body'}},messages:[{id:'another',body:'Second comment thread',toolPayload:'HIDDEN TOOL PAYLOAD'}]}]}}})]});
  const scope=buildScreenSearchScope({board,pageId:'p'}),comments=scope.items.filter(item=>item.kind.startsWith('page-comment'));
  assert.equal(comments.length,6);assert.ok(comments.every(item=>item.visibleOnly===true));
  assert.ok(texts(scope).every(text=>!text.includes('HIDDEN')));
  assert.deepEqual(comments.find(item=>item.kind==='page-comment-quote'),{id:'p:page-comment:thread-a:quote',nodeId:'p',commentThreadId:'thread-a',blockId:'body',kind:'page-comment-quote',text:'Visible anchor quotation',markdown:false,visibleOnly:true});
  const first=comments.find(item=>item.commentMessageId==='first');assert.equal(first.id,'p:page-comment:thread-a:message:first');assert.equal(first.text,'First **original comment**');assert.equal(first.blockId,'body');
  assert.ok(comments.some(item=>item.commentMessageId==='middle'),'Hidden middle replies stay addressable for the DOM visibility filter after expansion');
});

test('array-format Page comments have independent stable identities across Pages and never enter a different full-screen scope',()=>{
  const comment={id:'same-thread',blockId:'same-block',messages:[{id:'same-message',body:'Shared visible wording'}]};
  const board=deepFreeze({nodes:[page('one',{pageSnapshot:{title:'One',blocks:[],comments:[comment]}}),page('two',{pageSnapshot:{title:'Two',blocks:[],comments:[structuredClone(comment)]}}),chat('chat')]});
  const canvas=buildScreenSearchScope({board}),comments=canvas.items.filter(item=>item.kind==='page-comment');
  assert.equal(comments.length,2);assert.notEqual(comments[0].id,comments[1].id);assert.ok(comments.every(item=>item.visibleOnly));
  assert.equal(buildScreenSearchScope({board,fullChatId:'chat'}).items.some(item=>item.kind==='page-comment'),false);
  assert.deepEqual(buildScreenSearchScope({board,pageId:'one'}).items.filter(item=>item.kind==='page-comment').map(item=>item.nodeId),['one']);
});

test('empty and missing scopes are safe and never fall back to hidden background history',()=>{
  assert.deepEqual(buildScreenSearchScope({board:null}),{label:'Canvas',items:[]});
  const board={nodes:[chat('background')]};assert.deepEqual(buildScreenSearchScope({board,fullChatId:'missing'}),{label:'This conversation',items:[]});
  assert.deepEqual(buildScreenSearchScope({board,pageId:'missing'}),{label:'This Page',items:[]});
});

test('empty editable sources remain addressable so freshly typed DOM text is searchable before an autosave acknowledgement',()=>{
  const board=deepFreeze({nodes:[chat('fresh-chat',{title:'',draft:'',messages:[{id:'empty-output',role:'assistant',text:''}]}),{id:'fresh-note',kind:'note',title:'',noteText:'',messages:[],draft:''},{id:'fresh-document',kind:'document',title:'',documentMarkdown:'',messages:[],draft:''},page('fresh-page',{pageSnapshot:{title:'',blocks:[{id:'empty-paragraph',markdown:''}]},draft:''})]});
  const scope=buildScreenSearchScope({board});
  for(const [nodeId,kind]of [['fresh-chat','title'],['fresh-chat','draft'],['fresh-note','note'],['fresh-document','document'],['fresh-page','title'],['fresh-page','page-block'],['fresh-page','draft']]){
    const item=scope.items.find(item=>item.nodeId===nodeId&&item.kind===kind);assert.ok(item,`${nodeId} ${kind} must have a stable live-DOM search entry`);assert.equal(item.text,'');
  }
  assert.equal(scope.items.some(item=>item.kind==='message'),false,'Empty agent output is not an editable source');
});
