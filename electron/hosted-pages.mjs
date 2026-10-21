import electron from 'electron';

const PARTITION='persist:tangent-chatgpt-pages';
const AUTH_HOSTS=new Set(['auth.openai.com','auth0.openai.com','accounts.openai.com','account.openai.com','login.openai.com']);
const SSO_HOSTS=new Set(['accounts.google.com','appleid.apple.com']);
const PAGE_PATH=/^\/space\/page_[A-Za-z0-9_-]{8,128}\/?$/;
const clone=value=>structuredClone(value);

/** Only an actual ChatGPT Page may become a hosted canvas card. */
export function validatePageUrl(value){
  let url;try{url=new URL(value)}catch{throw Error('Use a ChatGPT Page link beginning with https://chatgpt.com/space/page_.')}
  if(url.protocol!=='https:'||url.hostname!=='chatgpt.com'||url.port||url.username||url.password||!PAGE_PATH.test(url.pathname)||url.search||url.hash)throw Error('Use the direct https://chatgpt.com/space/page_… link for this Page.');
  return`https://chatgpt.com${url.pathname.replace(/\/$/,'')}`;
}
export function isHostedNavigationAllowed(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(u.hostname==='chatgpt.com'||AUTH_HOSTS.has(u.hostname))}catch{return false}
}
function externalHttps(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null}catch{return null}}
function isAuthenticationPopup(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(AUTH_HOSTS.has(u.hostname)||SSO_HOSTS.has(u.hostname)||u.hostname==='chatgpt.com'&&/^\/auth(?:\/|$)/.test(u.pathname))}catch{return false}}
function isPopupNavigationAllowed(value){try{const u=new URL(value);return isHostedNavigationAllowed(value)||u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&SSO_HOSTS.has(u.hostname)}catch{return false}}
function publicUrl(value){try{const u=new URL(value);return`${u.origin}${u.pathname}`}catch{return''}}
function authHint(value){try{const u=new URL(value);return AUTH_HOSTS.has(u.hostname)||u.hostname==='chatgpt.com'&&/^\/auth(?:\/|$)/.test(u.pathname)?'Sign in to ChatGPT in this Page panel. This app keeps its own sign-in.':undefined}catch{return undefined}}

/** Clip the native surface without changing the underlying document viewport. */
export function calculateHostedBounds(bounds,contentSize,clipBounds){
  if(!bounds||!['x','y','width','height'].every(k=>Number.isFinite(bounds[k])))return null;
  if(bounds.width<1||bounds.height<1)return null;
  const full={x:Math.round(bounds.x),y:Math.round(bounds.y),width:Math.min(20000,Math.round(bounds.width)),height:Math.min(20000,Math.round(bounds.height))};
  let left=0,top=0,right=contentSize[0],bottom=contentSize[1];
  if(clipBounds&&['x','y','width','height'].every(k=>Number.isFinite(clipBounds[k]))){left=Math.max(left,Math.ceil(clipBounds.x));top=Math.max(top,Math.ceil(clipBounds.y));right=Math.min(right,Math.floor(clipBounds.x+clipBounds.width));bottom=Math.min(bottom,Math.floor(clipBounds.y+clipBounds.height));}
  left=Math.max(left,full.x);top=Math.max(top,full.y);right=Math.min(right,full.x+full.width);bottom=Math.min(bottom,full.y+full.height);
  if(right<=left||bottom<=top)return null;
  return{container:{x:left,y:top,width:right-left,height:bottom-top},page:{x:full.x-left,y:full.y-top,width:full.width,height:full.height}};
}

/**
 * A real top-level ChatGPT surface, hosted inside a clipped native canvas card.
 * It has no preload, Node, cookie bridge, injected DOM, or shared browser profile.
 * Dependency injection keeps ownership/security/layout tests independent of Electron.
 */
export class HostedPagesManager{
  constructor({window,getNode,onStatus=()=>{},electron:platform=electron,partition=PARTITION}){
    if(!window?.contentView||typeof getNode!=='function')throw Error('A window and canvas card lookup are required.');
    this.window=window;this.getNode=getNode;this.onStatus=onStatus;this.platform=platform;this.partition=partition;
    this.current=null;this.cachedKey=null;this.cachedStatus=null;this.view=null;this.container=null;this.lastLayout=null;this.destroyed=false;this.lastGestureAt=0;this.popups=new Set();this.viewportSync=null;this.showTask=null;this.visibilityCheck=null;this.loadAttempt=0;
    this.profile=platform.session.fromPartition(partition);
    this.profile.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    this.profile.setPermissionCheckHandler?.(()=>false);
    this.onResize=()=>this.lastLayout&&this.layout(this.lastLayout);
    // macOS emits show before isVisible() changes; realize after that transition.
    this.onShow=()=>{if(!this.showTask)this.showTask=setImmediate(()=>{this.showTask=null;this.activateCurrent();this.syncViewport()})};
    this.onWindowClosed=()=>this.destroy();window.on?.('resize',this.onResize);window.on?.('show',this.onShow);window.once?.('closed',this.onWindowClosed);
  }
  status(){return this.current?clone(this.current.status):null}
  isWindowVisible(){return this.window.isVisible?.()!==false}
  emit(patch={}){
    if(!this.current||this.destroyed)return;
    Object.assign(this.current.status,patch);
    this.current.status.deferred=!this.isWindowVisible();if(this.current.status.deferred)this.current.status.loading=false;
    if(this.current.status.deferred)this.waitForVisible();
    if(this.cachedKey===this.current.key)this.cachedStatus=this.status();this.onStatus(this.status());
  }
  waitForVisible(){
    if(this.destroyed||!this.current||this.visibilityCheck)return;
    // showInactive does not emit "show" on every supported macOS/Electron build.
    // Inspect only parent visibility while deferred; never touch its native child.
    this.visibilityCheck=setTimeout(()=>{this.visibilityCheck=null;if(!this.current||this.destroyed)return;if(this.isWindowVisible()){this.activateCurrent();this.syncViewport()}else this.waitForVisible()},100);
    this.visibilityCheck.unref?.();
  }
  open({boardId,nodeId}){
    if(this.destroyed||this.window.isDestroyed?.())throw Error('The Page window is closed.');
    const node=this.getNode(boardId,nodeId);if(!node||node.archived)throw Error('Page card not found.');
    const pageUrl=validatePageUrl(node.pageUrl),key=JSON.stringify([boardId,nodeId,pageUrl]);
    if(this.current?.key===key){if(this.current.status.error)this.current.needsReload=true;if(this.isWindowVisible())this.activateCurrent();else this.emit();return this.status()}
    const retryCached=this.cachedKey===key&&Boolean(this.cachedStatus?.error);
    this.current={key,boardId,nodeId,pageUrl,needsReload:retryCached,status:{boardId,nodeId,url:pageUrl,title:node.title||'ChatGPT Page',loading:this.isWindowVisible(),deferred:!this.isWindowVisible(),error:undefined,authHint:undefined}};
    this.lastLayout=null;
    if(this.isWindowVisible())this.activateCurrent();else this.emit();
    return this.status();
  }
  activateCurrent(){
    // Creating or resizing a native child under a hidden macOS window can stall
    // AppKit/Chromium. Keep requests as data until the parent is actually visible.
    if(this.destroyed||!this.current)return;
    if(!this.isWindowVisible()){this.waitForVisible();return}
    if(this.visibilityCheck){clearTimeout(this.visibilityCheck);this.visibilityCheck=null}
    const{key,boardId,nodeId,pageUrl}=this.current,node=this.getNode(boardId,nodeId);
    if(!node||node.archived){this.close();return}
    if(this.cachedKey!==key||!this.view||this.view.webContents.isDestroyed())this.releaseView();
    if(this.view){
      if(this.current.needsReload)this.loadOriginal();
      else{const currentUrl=this.view.webContents.getURL();this.emit({url:publicUrl(currentUrl)||pageUrl,authHint:authHint(currentUrl),loading:this.view.webContents.isLoading?.()||false})}
      if(this.lastLayout)this.layout(this.lastLayout);
      return;
    }
    const{View,WebContentsView}=this.platform;
    this.container=new View();this.container.setVisible(false);this.container.setBackgroundColor?.('#ffffffff');this.container.setBorderRadius?.(10);
    this.view=new WebContentsView({webPreferences:{session:this.profile,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,spellcheck:true,backgroundThrottling:false}});
    // Chromium may keep a hidden child's initial viewport until it is revealed.
    // Start with useful bounds, then resync the actual card at document/reveal time.
    const initialSize=this.window.getContentSize();
    const initialBounds={x:0,y:0,width:Math.max(1,Math.min(20000,initialSize[0])),height:Math.max(1,Math.min(20000,initialSize[1]))};
    this.container.setBounds(initialBounds);this.view.setBounds(initialBounds);this.container.addChildView(this.view);this.window.contentView.addChildView(this.container);this.cachedKey=key;
    const wc=this.view.webContents,belongs=()=>!this.destroyed&&this.view?.webContents===wc&&this.current?.key===key;
    const updateUrl=url=>{if(belongs())this.emit({url:publicUrl(url),authHint:authHint(url)})};
    wc.on('did-start-loading',()=>belongs()&&this.emit({loading:true,error:undefined}));
    wc.on('dom-ready',()=>belongs()&&this.syncViewport());
    wc.on('did-finish-load',()=>belongs()&&this.syncViewport());
    wc.on('did-stop-loading',()=>{if(belongs()){if(this.isWindowVisible())updateUrl(wc.getURL());this.emit({loading:false})}});
    wc.on('did-navigate',(_event,url)=>updateUrl(url));
    wc.on('did-navigate-in-page',(_event,url,isMainFrame)=>{if(isMainFrame!==false)updateUrl(url)});
    wc.on('page-title-updated',(_event,title)=>belongs()&&this.emit({title:String(title||'ChatGPT Page').replace(/[\x00-\x1f]/g,'').slice(0,180)}));
    wc.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(belongs()&&isMainFrame!==false&&code!==-3)this.emit({loading:false,error:`This Page could not load (${String(description||code).slice(0,120)}). Try opening it again.`})});
    wc.on('render-process-gone',()=>belongs()&&this.emit({loading:false,error:'The Page stopped responding. Close and reopen this Page panel.'}));
    const gesture=(_event,input)=>{if(['mouseDown','keyDown','rawKeyDown'].includes(input?.type))this.lastGestureAt=Date.now()};
    wc.on('input-event',gesture);wc.on('before-input-event',gesture);
    const navigate=(event,legacyUrl)=>{
      const url=event.url||legacyUrl;if(isHostedNavigationAllowed(url))return;
      event.preventDefault();
      if(isAuthenticationPopup(url)){if(belongs())this.emit({authHint:'This sign-in step needs a separate sign-in window. Try email sign-in or the provider’s popup option.'});return}
      if(this.hasRecentGesture())this.openExternal(url);
    };
    wc.on('will-navigate',navigate);wc.on('will-redirect',navigate);
    wc.setWindowOpenHandler(details=>{
      if(!belongs())return{action:'deny'};
      if(this.hasRecentGesture()){
        this.lastGestureAt=0;
        if(isAuthenticationPopup(details.url))return{action:'allow',overrideBrowserWindowOptions:{parent:this.window,show:this.window.isVisible?.()===true,width:560,height:760,autoHideMenuBar:true,webPreferences:{session:this.profile,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false}}};
        if(!this.isWindowVisible())return{action:'deny'};
        if(isHostedNavigationAllowed(details.url))wc.loadURL(details.url).catch(()=>{});
        else this.openExternal(details.url);
      }
      return{action:'deny'};
    });
    wc.on('did-create-window',popup=>{
      if(!belongs()){popup.close();return}
      this.popups.add(popup);
      const popupContents=popup.webContents;
      popupContents.setWindowOpenHandler(()=>({action:'deny'}));
      const restrict=(event,legacyUrl)=>{if(!isPopupNavigationAllowed(event.url||legacyUrl)){event.preventDefault();if(belongs())this.emit({authHint:'This sign-in provider is not supported in the Page panel. Use another sign-in option.'})}};
      popupContents.on('will-navigate',restrict);popupContents.on('will-redirect',restrict);
      popupContents.on('will-attach-webview',event=>event.preventDefault());
      popup.once('closed',()=>{this.popups.delete(popup);if(belongs()&&!this.releasing)this.loadOriginal()});
    });
    this.emit();
    this.loadOriginal();
    if(this.lastLayout)this.layout(this.lastLayout);
  }
  loadOriginal(){
    if(!this.current||this.destroyed)return;
    if(!this.isWindowVisible()){this.current.needsReload=true;this.emit();return}
    if(!this.view)return;
    this.current.needsReload=false;
    const key=this.current.key,wc=this.view.webContents,attempt=++this.loadAttempt;this.emit({loading:true,error:undefined,url:this.current.pageUrl,authHint:undefined});
    wc.loadURL(this.current.pageUrl).catch(error=>{if(this.loadAttempt===attempt&&this.current?.key===key&&this.view?.webContents===wc&&error?.code!=='ERR_ABORTED')this.emit({loading:false,error:'This Page could not load. Check your connection and try opening it again.'})});
  }
  reload({boardId,nodeId}){
    if(this.destroyed||this.window.isDestroyed?.())throw Error('The Page window is closed.');
    if(!this.current||this.current.boardId!==boardId||this.current.nodeId!==nodeId)throw Error('Open this Page before reloading it.');
    const node=this.getNode(boardId,nodeId);if(!node||node.archived)throw Error('Page card not found.');
    ++this.loadAttempt;
    this.current.needsReload=true;
    if(!this.isWindowVisible())this.emit({loading:false,error:undefined,authHint:undefined,url:this.current.pageUrl});
    else if(!this.view||this.cachedKey!==this.current.key||this.view.webContents.isDestroyed())this.activateCurrent();
    else this.loadOriginal();
    return this.status();
  }
  hasRecentGesture(){return this.lastGestureAt>0&&Date.now()-this.lastGestureAt<1500}
  openExternal(value){const url=externalHttps(value);if(url)this.platform.shell.openExternal(url).catch(()=>{})}
  syncViewport(){
    if(this.destroyed||!this.current||!this.lastLayout||!this.view||!this.isWindowVisible()||this.viewportSync)return;
    const view=this.view,key=this.current.key;
    this.viewportSync=setImmediate(()=>{
      this.viewportSync=null;
      if(this.destroyed||this.view!==view||this.current?.key!==key||!this.lastLayout||!this.isWindowVisible())return;
      this.layout(this.lastLayout);
      if(this.lastLayout.visible===false)return;
      const clipped=calculateHostedBounds(this.lastLayout.bounds,this.window.getContentSize(),this.lastLayout.clipBounds);
      const node=this.getNode(this.current.boardId,this.current.nodeId);
      if(!clipped||!node||node.archived)return;
      // A real native resize wakes an initially hidden renderer. Restore the exact
      // card geometry in the same callback; clipping prevents an exposed edge.
      view.setBounds({...clipped.page,width:clipped.page.width+1});
      view.setBounds(clipped.page);
      view.webContents.invalidate?.();
    });
  }
  layout(p){
    if(this.destroyed||!this.current||p.boardId!==this.current.boardId||p.nodeId!==this.current.nodeId)return;
    this.lastLayout=clone(p);
    if(!this.isWindowVisible()){if(!this.current.status.deferred)this.emit();else this.waitForVisible();return}
    if(!this.view||this.cachedKey!==this.current.key){this.activateCurrent();return}
    const node=this.getNode(p.boardId,p.nodeId);
    const clipped=node&&!node.archived&&p.visible!==false?calculateHostedBounds(p.bounds,this.window.getContentSize(),p.clipBounds):null;
    if(!clipped){this.container.setVisible(false);return}
    this.container.setBounds(clipped.container);this.view.setBounds(clipped.page);
    this.container.setBorderRadius?.(Math.round(Math.max(2,Math.min(12,10*(Number.isFinite(p.zoom)?p.zoom:1)))));
    this.view.webContents.setZoomFactor(Math.max(.2,Math.min(3,Number.isFinite(p.zoom)?p.zoom:1)));
    this.view.setVisible(true);this.container.setVisible(true);
  }
  close(){if(this.visibilityCheck){clearTimeout(this.visibilityCheck);this.visibilityCheck=null}if(this.showTask){clearImmediate(this.showTask);this.showTask=null}if(this.viewportSync){clearImmediate(this.viewportSync);this.viewportSync=null}this.container?.setVisible(false);this.current=null;this.lastLayout=null;this.lastGestureAt=0;for(const popup of [...this.popups])popup.close();this.popups.clear()}
  releaseView(){
    this.releasing=true;
    if(this.viewportSync){clearImmediate(this.viewportSync);this.viewportSync=null}
    this.container?.setVisible(false);
    for(const popup of [...this.popups])popup.close();this.popups.clear();
    if(this.container)this.window.contentView.removeChildView(this.container);
    if(this.view&&!this.view.webContents.isDestroyed())this.view.webContents.close();
    this.view=null;this.container=null;this.cachedKey=null;this.cachedStatus=null;this.lastGestureAt=0;
    this.releasing=false;
  }
  destroy(){
    if(this.destroyed)return;this.close();this.releaseView();this.destroyed=true;
    this.window.off?.('resize',this.onResize);this.window.off?.('show',this.onShow);this.window.off?.('closed',this.onWindowClosed);
  }
}
export{HostedPagesManager as HostedPages};
