import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HostedPagesManager, validatePageUrl, isHostedNavigationAllowed, calculateHostedBounds } from '../electron/hosted-pages.mjs';

const PAGE='https://chatgpt.com/space/page_HostedFixture123456ab';
class View{constructor(){this.children=[];this.visible=true;this.boundsHistory=[];}addChildView(v){this.children.push(v)}removeChildView(v){this.children=this.children.filter(c=>c!==v)}setVisible(v){this.visible=v}setBounds(b){this.bounds={...b};this.boundsHistory.push({...b})}getBounds(){return this.bounds}setBackgroundColor(){}setBorderRadius(r){assert.ok(Number.isInteger(r),'Electron native border radius requires an integer');this.radius=r}}
class Contents extends EventEmitter{constructor(){super();this.url='';this.loads=[];this.dead=false;this.invalidations=0;}loadURL(url){this.url=url;this.loads.push(url);return Promise.resolve()}getURL(){return this.url}isDestroyed(){return this.dead}isLoading(){return false}close(){this.dead=true}setZoomFactor(v){this.zoom=v}setWindowOpenHandler(fn){this.popup=fn}invalidate(){this.invalidations++}}
class WebContentsView extends View{constructor(options){super();this.options=options;this.webContents=new Contents}}
function fixture({visible=true}={}){
  const window=new EventEmitter();window.contentView=new View();window.getContentSize=()=>[1000,800];window.isDestroyed=()=>false;window.visible=visible;window.isVisible=()=>window.visible;
  const session={setPermissionRequestHandler(fn){this.permission=fn},setPermissionCheckHandler(fn){this.check=fn}};
  const partitions=[],external=[],statuses=[],nodes=new Map([['a',{pageUrl:PAGE,title:'Actual Page'}],['b',{pageUrl:PAGE.replace(/ab$/,'cd'),title:'Other Page'}]]);
  const created=[];class TrackedWebContentsView extends WebContentsView{constructor(options){super(options);created.push(this)}}
  const platform={View,WebContentsView:TrackedWebContentsView,session:{fromPartition:p=>(partitions.push(p),session)},shell:{openExternal:async url=>external.push(url)}};
  const manager=new HostedPagesManager({window,getNode:(_board,id)=>nodes.get(id),onStatus:s=>statuses.push(s),electron:platform});
  return{window,session,partitions,external,statuses,nodes,manager,created};
}
const event=(url)=>({url,preventDefault(){this.prevented=true}});

test('accepts direct actual Page URLs and rejects spoofed domains or local protocols',()=>{
  assert.equal(validatePageUrl(PAGE+'/'),PAGE);
  for(const url of ['http://chatgpt.com/space/page_12345678','https://chatgpt.com.evil.test/space/page_12345678','https://chatgpt.com@evil.test/space/page_12345678','https://user@chatgpt.com/space/page_12345678','https://chatgpt.com/c/12345678','file:///private/file','javascript:alert(1)',PAGE+'?token=secret'])assert.throws(()=>validatePageUrl(url));
  assert.equal(isHostedNavigationAllowed('https://chatgpt.com/auth/login?next=%2Fspace'),true);
  assert.equal(isHostedNavigationAllowed('https://auth.openai.com/authorize?state=private'),true);
  assert.equal(isHostedNavigationAllowed('https://auth.openai.com.attacker.test/'),false);
});
test('uses a separate persistent app-owned profile and sandbox with no preload',()=>{
  const f=fixture();f.manager.open({boardId:'board',nodeId:'a'});
  assert.deepEqual(f.partitions,['persist:tangent-chatgpt-pages']);const prefs=f.manager.view.options.webPreferences;
  assert.equal(prefs.session,f.session);assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.webSecurity,true);assert.equal(prefs.preload,undefined);
  let granted;f.session.permission(null,'clipboard-read',v=>granted=v);assert.equal(granted,false);assert.equal(f.session.check(),false);
  assert.equal(f.manager.container.visible,false);f.manager.destroy();
});
test('native parent clips card edges while child keeps full Page viewport',()=>{
  assert.deepEqual(calculateHostedBounds({x:-70,y:60,width:500,height:400},[1000,800],{x:200,y:100,width:700,height:600}),{container:{x:200,y:100,width:230,height:360},page:{x:-270,y:-40,width:500,height:400}});
  assert.equal(calculateHostedBounds({x:1100,y:0,width:100,height:100},[1000,800]),null);
  assert.equal(calculateHostedBounds({x:0,y:0,width:NaN,height:100},[1000,800]),null);
});
test('fractional canvas zoom always uses a valid integer native radius and still reveals the child',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});
  for(const zoom of [.99,.731,.873213]){f.manager.layout({boardId:'one',nodeId:'a',bounds:{x:200,y:100,width:600,height:500},visible:true,zoom});assert.equal(f.manager.container.radius,Math.round(10*zoom));assert.equal(f.manager.container.visible,true);assert.equal(f.manager.view.visible,true);assert.equal(f.manager.view.webContents.zoom,zoom)}f.manager.destroy();
});
test('a hidden parent defers all native creation and replays only its latest card layout after reveal',async()=>{
  const f=fixture({visible:false});const status=f.manager.open({boardId:'one',nodeId:'a'});
  assert.equal(status.deferred,true);assert.equal(status.loading,false);assert.equal(f.created.length,0);assert.equal(f.manager.view,null);assert.deepEqual(f.window.contentView.children,[]);
  const p={boardId:'one',nodeId:'a',bounds:{x:20,y:30,width:600,height:500},visible:true,zoom:.7};f.manager.layout(p);f.manager.layout({...p,bounds:{x:250,y:110,width:480,height:410},zoom:1.25});f.window.emit('resize');f.window.emit('show');
  await new Promise(setImmediate);assert.equal(f.created.length,0,'a spurious show event while still hidden cannot create a native child');
  f.window.visible=true;f.window.emit('show');await new Promise(setImmediate);
  assert.equal(f.created.length,1);assert.equal(f.manager.status().deferred,false);assert.deepEqual(f.manager.view.webContents.loads,[PAGE]);assert.deepEqual(f.manager.container.getBounds(),{x:250,y:110,width:480,height:410});assert.deepEqual(f.manager.view.getBounds(),{x:0,y:0,width:480,height:410});assert.equal(f.manager.view.webContents.zoom,1.25);f.manager.destroy();
});
test('hidden layout and replacement make no webContents or native layout calls until reveal',async()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const old=f.manager.view,wc=old.webContents,p={boardId:'one',nodeId:'a',bounds:{x:20,y:30,width:600,height:500},visible:true,zoom:1};f.manager.layout(p);
  f.window.visible=false;let hiddenCalls=0;
  for(const target of [wc,old,f.manager.container])for(const name of ['getURL','isLoading','isDestroyed','loadURL','setZoomFactor','invalidate','setBounds','setVisible','setBorderRadius'])if(typeof target[name]==='function'){const original=target[name];target[name]=function(...args){if(!f.window.visible)hiddenCalls++;return original.apply(this,args)}}
  f.manager.layout({...p,bounds:{x:200,y:100,width:550,height:430},zoom:.6});wc.emit('dom-ready');wc.emit('did-finish-load');wc.emit('did-stop-loading');f.window.emit('resize');await new Promise(setImmediate);
  assert.equal(hiddenCalls,0);assert.deepEqual(old.getBounds(),{x:0,y:0,width:600,height:500});
  f.manager.open({boardId:'one',nodeId:'b'});f.manager.layout({...p,nodeId:'b',bounds:{x:300,y:150,width:420,height:350},zoom:.8});assert.equal(hiddenCalls,0);assert.equal(f.created.length,1);assert.equal(f.manager.status().deferred,true);
  f.window.visible=true;f.window.emit('show');await new Promise(setImmediate);
  assert.equal(old.webContents.dead,true);assert.equal(f.created.length,2);assert.deepEqual(f.manager.view.webContents.loads,[f.nodes.get('b').pageUrl]);assert.deepEqual(f.manager.container.getBounds(),{x:300,y:150,width:420,height:350});assert.equal(f.manager.view.webContents.zoom,.8);f.manager.destroy();
});
test('closing, removing, or replacing a deferred request cannot resurrect an obsolete native Page',async()=>{
  const f=fixture({visible:false});f.manager.open({boardId:'one',nodeId:'a'});f.manager.close();f.window.visible=true;f.window.emit('show');await new Promise(setImmediate);assert.equal(f.created.length,0);assert.equal(f.manager.visibilityCheck,null);
  f.window.visible=false;f.manager.open({boardId:'one',nodeId:'a'});f.nodes.delete('a');f.window.visible=true;f.window.emit('show');await new Promise(setImmediate);assert.equal(f.created.length,0);assert.equal(f.manager.status(),null);
  f.window.visible=false;f.manager.open({boardId:'one',nodeId:'b'});f.manager.destroy();f.window.visible=true;f.window.emit('show');await new Promise(setImmediate);assert.equal(f.created.length,0);assert.equal(f.window.listenerCount('show'),0);assert.equal(f.manager.visibilityCheck,null);
});
test('showInactive visibility without a show event realizes a deferred Page, while missing isVisible assumes a usable parent',async()=>{
  const f=fixture({visible:false});f.manager.open({boardId:'one',nodeId:'a'});f.manager.layout({boardId:'one',nodeId:'a',bounds:{x:20,y:30,width:600,height:500},visible:true,zoom:1});assert.equal(f.created.length,0);
  f.window.visible=true;await new Promise(r=>setTimeout(r,130));assert.equal(f.created.length,1);assert.equal(f.manager.status().deferred,false);assert.deepEqual(f.manager.container.getBounds(),{x:20,y:30,width:600,height:500});assert.equal(f.manager.visibilityCheck,null);f.manager.destroy();
  const g=fixture();delete g.window.isVisible;g.manager.open({boardId:'one',nodeId:'a'});assert.equal(g.created.length,1);assert.equal(g.manager.status().deferred,false);g.manager.destroy();
});
test('layout follows active card and transient hiding does not reload or lose sign-in state',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const view=f.manager.view;
  const layout={boardId:'one',nodeId:'a',bounds:{x:250,y:110,width:600,height:500},visible:true,zoom:.7};f.manager.layout(layout);
  assert.equal(f.manager.container.visible,true);assert.equal(view.webContents.zoom,.7);
  f.manager.layout({...layout,visible:false});assert.equal(f.manager.container.visible,false);assert.equal(view.webContents.dead,false);
  f.manager.layout(layout);assert.equal(view.webContents.loads.length,1);
  f.manager.layout({...layout,nodeId:'b',bounds:{x:0,y:0,width:10,height:10}});assert.equal(f.manager.container.bounds.width,600);
  f.manager.close();f.manager.layout(layout);assert.equal(f.manager.container.visible,false);
  f.manager.open({boardId:'one',nodeId:'a'});assert.equal(f.manager.view,view);assert.equal(view.webContents.loads.length,1);f.manager.destroy();
});
test('new Page replaces old native view while retaining the same isolated sign-in profile',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const old=f.manager.view;f.manager.open({boardId:'one',nodeId:'b'});
  assert.equal(old.webContents.dead,true);assert.notEqual(f.manager.view,old);assert.equal(f.window.contentView.children.length,1);assert.equal(f.manager.container.visible,false);assert.equal(f.partitions.length,1);f.manager.destroy();
});
test('document readiness and window reveal resync the latest clipped viewport without navigation or status loops',async()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const view=f.manager.view,wc=view.webContents;
  assert.deepEqual(view.getBounds(),{x:0,y:0,width:1000,height:800});
  const p={boardId:'one',nodeId:'a',bounds:{x:-50,y:80,width:600,height:500},clipBounds:{x:200,y:100,width:700,height:600},visible:true,zoom:.7};
  f.manager.layout(p);const statusCount=f.statuses.length,loads=wc.loads.length;
  wc.emit('dom-ready');wc.emit('did-finish-load');
  await new Promise(setImmediate);
  assert.equal(wc.invalidations,1,'readiness events coalesce into one native viewport refresh');
  assert.deepEqual(view.getBounds(),{x:-250,y:-20,width:600,height:500});assert.deepEqual(f.manager.container.getBounds(),{x:200,y:100,width:350,height:480});
  assert.equal(view.visible,true);assert.equal(wc.zoom,.7);assert.equal(wc.loads.length,loads);assert.equal(f.statuses.length,statusCount);
  f.manager.layout({...p,bounds:{x:260,y:130,width:480,height:410},zoom:1.25});f.window.emit('show');
  await new Promise(setImmediate);await new Promise(setImmediate);
  assert.deepEqual(view.getBounds(),{x:0,y:0,width:480,height:410});assert.equal(wc.zoom,1.25);assert.equal(wc.invalidations,2);
  f.manager.destroy();assert.equal(f.window.listenerCount('show'),0);
});
test('a delayed viewport refresh cannot reveal a hidden, closed, or replaced Page',async()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const p={boardId:'one',nodeId:'a',bounds:{x:20,y:20,width:600,height:500},visible:true,zoom:1};f.manager.layout(p);
  const old=f.manager.view;old.webContents.emit('dom-ready');f.manager.layout({...p,visible:false});
  await new Promise(setImmediate);assert.equal(f.manager.container.visible,false);assert.equal(old.webContents.invalidations,0);
  f.manager.layout(p);old.webContents.emit('did-finish-load');f.manager.close();
  await new Promise(setImmediate);assert.equal(f.manager.container.visible,false);assert.equal(old.webContents.invalidations,0);
  f.manager.open({boardId:'one',nodeId:'a'});f.manager.layout(p);old.webContents.emit('dom-ready');f.manager.open({boardId:'one',nodeId:'b'});
  await new Promise(setImmediate);assert.equal(f.manager.container.visible,false);assert.equal(f.manager.view.webContents.invalidations,0);assert.equal(old.webContents.dead,true);f.manager.destroy();
});
test('status reports login without leaking OAuth query values or fragments',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents;
  wc.emit('did-navigate',{},'https://auth.openai.com/authorize?code=TOP_SECRET&state=PRIVATE#fragment');
  assert.equal(f.manager.status().url,'https://auth.openai.com/authorize');assert.match(f.manager.status().authHint,/Sign in/);assert.doesNotMatch(JSON.stringify(f.statuses),/TOP_SECRET|PRIVATE|fragment/);
  wc.emit('did-navigate',{},PAGE);assert.equal(f.manager.status().authHint,undefined);f.manager.destroy();
});
test('reopening a retained login panel restores its actual login hint and sanitized URL',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents;
  wc.url='https://chatgpt.com/auth/login?next=private';f.manager.close();f.manager.open({boardId:'one',nodeId:'a'});
  assert.equal(f.manager.status().url,'https://chatgpt.com/auth/login');assert.match(f.manager.status().authHint,/Sign in/);assert.equal(wc.loads.length,1);f.manager.destroy();
});
test('external navigation and popups require HTTPS plus a recent native user gesture',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents;
  const blocked=event('https://example.com/');wc.emit('will-navigate',blocked);assert.equal(blocked.prevented,true);assert.deepEqual(f.external,[]);
  assert.deepEqual(wc.popup({url:'https://example.com/'}),{action:'deny'});assert.deepEqual(f.external,[]);
  wc.emit('input-event',{}, {type:'mouseDown'});wc.popup({url:'https://example.com/article'});assert.deepEqual(f.external,['https://example.com/article']);
  wc.emit('input-event',{}, {type:'mouseDown'});wc.popup({url:'file:///private/file'});wc.emit('input-event',{}, {type:'mouseDown'});wc.popup({url:'javascript:alert(1)'});assert.equal(f.external.length,1);
  const auth=event('https://auth.openai.com/log-in');wc.emit('will-navigate',auth);assert.equal(auth.prevented,undefined);f.manager.destroy();
});
test('retry reloads an errored current or cached Page rather than retaining its failed surface',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents;
  wc.emit('did-fail-load',{},-105,'NAME_NOT_RESOLVED',PAGE,true);f.manager.open({boardId:'one',nodeId:'a'});assert.equal(wc.loads.length,2);assert.equal(f.manager.status().error,undefined);
  wc.emit('did-fail-load',{},-105,'NAME_NOT_RESOLVED',PAGE,true);f.manager.close();f.manager.open({boardId:'one',nodeId:'a'});assert.equal(wc.loads.length,3);f.manager.destroy();
});
test('explicit reload recovers a stalled retained Page at its original URL without replacing its sign-in profile',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const view=f.manager.view,wc=view.webContents;
  wc.url='https://chatgpt.com/auth/login?next=private';wc.emit('did-stop-loading');f.manager.close();f.manager.open({boardId:'one',nodeId:'a'});
  assert.equal(wc.loads.length,1,'reopening a loaded but stalled auth document retains its surface');
  const status=f.manager.reload({boardId:'one',nodeId:'a'});assert.equal(f.manager.view,view);assert.equal(wc.loads.length,2);assert.equal(wc.loads.at(-1),PAGE);assert.equal(f.partitions.length,1);assert.equal(status.url,PAGE);assert.equal(status.loading,true);assert.equal(status.deferred,false);assert.equal(status.error,undefined);assert.equal(status.authHint,undefined);
  wc.emit('did-stop-loading');assert.equal(f.manager.status().loading,false);f.manager.destroy();
});
test('reload rejects another board, another card, archived cards, and a closed current view',()=>{
  const f=fixture();assert.throws(()=>f.manager.reload({boardId:'one',nodeId:'a'}),/Open this Page/);f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents;
  assert.throws(()=>f.manager.reload({boardId:'two',nodeId:'a'}),/Open this Page/);assert.throws(()=>f.manager.reload({boardId:'one',nodeId:'b'}),/Open this Page/);assert.equal(wc.loads.length,1);
  f.nodes.get('a').archived=true;assert.throws(()=>f.manager.reload({boardId:'one',nodeId:'a'}),/not found/);assert.equal(wc.loads.length,1);f.nodes.get('a').archived=false;f.manager.close();assert.throws(()=>f.manager.reload({boardId:'one',nodeId:'a'}),/Open this Page/);f.manager.destroy();assert.throws(()=>f.manager.reload({boardId:'one',nodeId:'a'}),/closed/);
});
test('hidden reload records pending recovery without native calls and reloads once on reveal',async()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents,view=f.manager.view;f.window.visible=false;
  let hiddenCalls=0;for(const name of ['getURL','isLoading','isDestroyed','loadURL','setZoomFactor','invalidate']){const original=wc[name];wc[name]=function(...args){if(!f.window.visible)hiddenCalls++;return original.apply(this,args)}}
  const status=f.manager.reload({boardId:'one',nodeId:'a'});assert.equal(status.deferred,true);assert.equal(status.loading,false);assert.equal(status.error,undefined);assert.equal(hiddenCalls,0);assert.equal(wc.loads.length,1);assert.equal(f.manager.current.needsReload,true);
  f.window.visible=true;f.window.emit('show');await new Promise(setImmediate);assert.equal(f.manager.view,view);assert.deepEqual(wc.loads,[PAGE,PAGE]);assert.equal(f.manager.status().loading,true);assert.equal(f.manager.current.needsReload,false);f.manager.destroy();
  const g=fixture({visible:false});g.manager.open({boardId:'one',nodeId:'a'});g.manager.reload({boardId:'one',nodeId:'a'});assert.equal(g.created.length,0);g.window.visible=true;g.window.emit('show');await new Promise(setImmediate);assert.equal(g.created.length,1);assert.deepEqual(g.manager.view.webContents.loads,[PAGE]);g.manager.destroy();
});
test('pending reload ignores a superseded load failure and reports failure only for the current attempt',async()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents,failures=[];wc.loadURL=url=>{wc.url=url;wc.loads.push(url);return new Promise((_resolve,reject)=>failures.push(reject))};
  f.manager.reload({boardId:'one',nodeId:'a'});f.manager.reload({boardId:'one',nodeId:'a'});assert.equal(f.manager.status().loading,true);failures[0](Error('Old failed attempt'));await Promise.resolve();assert.equal(f.manager.status().error,undefined);assert.equal(f.manager.status().loading,true);
  failures[1](Error('Current failure'));await Promise.resolve();assert.match(f.manager.status().error,/could not load/);assert.equal(f.manager.status().loading,false);
  f.window.visible=false;f.manager.reload({boardId:'one',nodeId:'a'});assert.equal(f.manager.status().error,undefined);assert.equal(f.manager.status().deferred,true);f.manager.close();f.window.visible=true;f.window.emit('show');await new Promise(setImmediate);assert.equal(wc.loads.length,3,'closing a deferred retry cannot issue another navigation');f.manager.destroy();
});
test('canceling a hidden replacement preserves the retained original Page error for retry',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents;wc.emit('did-fail-load',{},-105,'NAME_NOT_RESOLVED',PAGE,true);
  f.window.visible=false;f.manager.open({boardId:'one',nodeId:'b'});f.manager.close();f.window.visible=true;f.manager.open({boardId:'one',nodeId:'a'});
  assert.equal(f.manager.view.webContents,wc);assert.equal(wc.loads.length,2);assert.equal(f.manager.status().error,undefined);f.manager.destroy();
});
test('Google and Apple sign-in popups require gestures and keep same sandboxed profile without foregrounding hidden app',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents;
  f.window.visible=false;
  assert.equal(wc.popup({url:'https://accounts.google.com/o/oauth2/auth?state=private'}).action,'deny');
  for(const url of ['https://accounts.google.com/o/oauth2/auth?state=private','https://appleid.apple.com/auth/authorize']){
    wc.emit('input-event',{}, {type:'mouseDown'});const permission=wc.popup({url});assert.equal(permission.action,'allow');
    const options=permission.overrideBrowserWindowOptions;assert.equal(options.show,false);assert.equal(options.parent,f.window);assert.equal(options.webPreferences.session,f.session);assert.equal(options.webPreferences.sandbox,true);assert.equal(options.webPreferences.preload,undefined);assert.equal(options.webPreferences.nodeIntegration,false);
  }
  const popup=new EventEmitter();popup.webContents=new Contents();popup.close=()=>popup.emit('closed');wc.emit('did-create-window',popup);assert.equal(f.manager.popups.size,1);
  const blocked=event('https://evil.test/');popup.webContents.emit('will-navigate',blocked);assert.equal(blocked.prevented,true);assert.match(f.manager.status().authHint,/not supported/);
  f.manager.close();assert.equal(f.manager.popups.size,0);f.manager.destroy();
});
test('unsupported same-window provider redirects produce a visible sign-in explanation',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const wc=f.manager.view.webContents;
  const redirect=event('https://accounts.google.com/signin/oauth?state=private');wc.emit('will-redirect',redirect);
  assert.equal(redirect.prevented,true);assert.match(f.manager.status().authHint,/separate sign-in window/);assert.deepEqual(f.external,[]);f.manager.destroy();
});
test('main-frame load errors are visible, stale views cannot update another card',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});const old=f.manager.view.webContents;
  old.emit('did-fail-load',{},-105,'NAME_NOT_RESOLVED',PAGE,true);assert.match(f.manager.status().error,/could not load/);
  f.manager.open({boardId:'one',nodeId:'b'});old.emit('page-title-updated',{},'Stale private title');assert.notEqual(f.manager.status().title,'Stale private title');f.manager.destroy();
  assert.equal(f.window.contentView.children.length,0);assert.equal(f.manager.status(),null);
});

test('native zoom supports the full canvas minimum of twenty percent',()=>{
  const f=fixture();f.manager.open({boardId:'one',nodeId:'a'});f.manager.layout({boardId:'one',nodeId:'a',bounds:{x:250,y:110,width:200,height:160},visible:true,zoom:.2});assert.equal(f.manager.view.webContents.zoom,.2);f.manager.destroy();
});
