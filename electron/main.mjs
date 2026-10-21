import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasStore } from './store.mjs';
import { CodexClient } from './codex.mjs';
import { CanvasService } from './service.mjs';
import { DocumentMcpBridge } from './document-mcp.mjs';
import { DOCUMENT_TOOL } from './documents.mjs';
import { PAGE_TOOL } from './pages.mjs';
import { HostedPagesManager } from './hosted-pages.mjs';
import { PageConnector } from './page-connector.mjs';
import { zoomActionForInput } from './zoom-shortcuts.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const background=process.argv.includes('--background')||process.argv.includes('--hidden');
protocol.registerSchemesAsPrivileged(['tangent-asset','tangent-page-media'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true}})));
if(process.env.TANGENT_DATA_DIR)app.setPath('userData',path.resolve(process.env.TANGENT_DATA_DIR));
app.setName('Tangent Canvas');
// Test windows may compose native Page pixels without a Dock presence or focus.
if(process.platform==='darwin'&&!app.isPackaged&&process.env.TANGENT_E2E==='1')app.setActivationPolicy('prohibited');
let window,service,hostedPages,quitting=false,readyToReveal=false,shutdownComplete=false;
let draftFlushSequence=0;
function flushRendererDrafts(target=window){
  if(!target||target.isDestroyed()||target.webContents.isDestroyed())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const id=++draftFlushSequence;
    const finish=error=>{clearTimeout(timer);ipcMain.off('tangent:drafts-flushed',receipt);error?reject(error):resolve();};
    const receipt=(event,result)=>{
      if(event.sender!==target.webContents||event.senderFrame!==target.webContents.mainFrame||result?.id!==id)return;
      finish(result.ok?null:Error(result.error||'Drafts could not be saved'));
    };
    const timer=setTimeout(()=>finish(Error('The window did not finish saving its drafts.')),5000);
    ipcMain.on('tangent:drafts-flushed',receipt);
    try{target.webContents.send('tangent:flush-drafts',id)}catch(error){finish(error)}
  });
}
function reportSaveFailure(error){
  dialog.showErrorBox('Your draft could not be saved',`Tangent stayed open to keep your work. ${error?.message||'Please try again.'}`);
}
const gotLock=process.env.TANGENT_ALLOW_MULTIPLE==='1'||app.requestSingleInstanceLock();
if(!gotLock){app.quit()}else{
  process.once('SIGTERM',()=>app.quit());process.once('SIGINT',()=>app.quit());
  app.on('second-instance',(_event,argv)=>{if(!argv.includes('--background')){window?.show();window?.focus()}});
  app.on('activate',()=>{if(readyToReveal){if(!window)createWindow();window?.show()}});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
  app.on('before-quit',event=>{
    if(shutdownComplete)return;event.preventDefault();if(quitting)return;quitting=true;
    Promise.resolve().then(async()=>{
      await flushRendererDrafts();
      service?.store.flush();
      hostedPages?.destroy();await service?.close();
      shutdownComplete=true;app.quit();
    }).catch(error=>{quitting=false;reportSaveFailure(error)});
  });
  app.whenReady().then(async()=>{
    const directory=app.getPath('userData');
    service=new CanvasService(new CanvasStore(directory),new CodexClient({cwd:directory,binary:!app.isPackaged&&process.env.TANGENT_E2E==='1'?process.env.TANGENT_TEST_CODEX_BINARY:undefined}));
    service.setPageConnector(new PageConnector({directory,binary:!app.isPackaged&&process.env.TANGENT_E2E==='1'?process.env.TANGENT_TEST_CODEX_BINARY:undefined}));
    // A private, per-card tool bridge also works with imported Codex threads.
    const bridge=new DocumentMcpBridge({tools:[DOCUMENT_TOOL,PAGE_TOOL],onToolCall:(contextId,name,args)=>service.documentToolForContext(contextId,name,args)});
    await bridge.start();service.documentBridge=bridge;
    protocol.handle('tangent-asset',request=>{
      try{
        const assetId=new URL(request.url).hostname;const file=service.assets.path(assetId);
        const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())return new Response('Image not found',{status:404});
        const mime=assetId.endsWith('.jpg')?'image/jpeg':`image/${assetId.split('.').at(-1)}`;
        return new Response(fs.readFileSync(file),{headers:{'Content-Type':mime,'Cache-Control':'private, max-age=31536000, immutable','Content-Security-Policy':"default-src 'none'"}});
      }catch{return new Response('Image not found',{status:404})}
    });
    protocol.handle('tangent-page-media',request=>service.pageMedia.response(request.url));
    const saved=service.store.state.settings;if(saved)Object.assign(service.connection,saved);
    service.on('event',event=>{if(window&&!window.isDestroyed())window.webContents.send('tangent:event',event)});
    installIPC();installMenu();createWindow();
    await service.connect();
    readyToReveal=true;
  });
}

function createWindow(){
  window=new BrowserWindow({
    width:1510,height:980,minWidth:1024,minHeight:680,show:false,title:'Tangent Canvas',
    titleBarStyle:'hiddenInset',trafficLightPosition:{x:20,y:16},backgroundColor:'#ffffff',
    icon:path.join(here,'../assets/icon.png'),
    webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:true,backgroundThrottling:false}
  });
  const currentWindow=window;
  let closeAllowed=false,closing=false;
  currentWindow.on('close',event=>{
    if(quitting||shutdownComplete||closeAllowed)return;
    event.preventDefault();if(closing)return;closing=true;
    flushRendererDrafts(currentWindow).then(()=>{
      service?.store.flush();closeAllowed=true;currentWindow.close();
    }).catch(reportSaveFailure).finally(()=>{closing=false});
  });
  window.webContents.setWindowOpenHandler(({url})=>{openExternal(url);return{action:'deny'}});
  window.webContents.on('before-input-event',(event,input)=>{
    if(input.type==='keyDown'&&(input.meta||input.control)&&!input.alt){
      const key=input.key?.toLowerCase();
      if(key==='f'||key==='g'){
        event.preventDefault();
        window.webContents.send('tangent:action',key==='f'?'find':input.shift?'find-previous':'find-next');
        return;
      }
    }
    const action=zoomActionForInput(input);
    if(!action)return;
    event.preventDefault();
    window.webContents.send('tangent:action',action);
  });
  window.webContents.on('will-navigate',(event,url)=>{
    const current=window.webContents.getURL();if(url!==current){event.preventDefault();openExternal(url)}
  });
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  window.once('ready-to-show',()=>{if(!background)window.showInactive()});
  hostedPages=new HostedPagesManager({window,getNode:(boardId,nodeId)=>{const {node}=service.store.node(boardId,nodeId);if(node.kind!=='page')throw Error('Choose a ChatGPT Page card.');return node},onStatus:status=>{if(window&&!window.isDestroyed())window.webContents.send('tangent:event',{type:'page/status',nodeId:status.nodeId,status:{...status,state:status.error?'error':status.deferred?'waiting':status.authHint?'login':status.loading?'loading':'ready'}})}});
  window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)hostedPages?.close()});
  window.on('closed',()=>{hostedPages?.destroy();hostedPages=null;window=null});
  const dev=process.env.TANGENT_DEV_URL;
  if(dev&&!app.isPackaged&&/^http:\/\/127\.0\.0\.1:5178\/?$/.test(dev))window.loadURL(dev);
  else window.loadFile(path.join(here,'../dist/index.html'));
  return window;
}
function openExternal(url){
  try{const parsed=new URL(url);if(['http:','https:'].includes(parsed.protocol))shell.openExternal(parsed.href)}catch{}
}
function installIPC(){
  ipcMain.handle('tangent:invoke',async(event,command,payload)=>{
    if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('Unsupported sender');
    if(typeof command!=='string'||!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid action');
    if(command==='app/copy-text'){
      if(typeof payload.text!=='string')throw Error('Clipboard text must be a string.');
      await clipboard.writeText(payload.text);
      return {copied:true};
    }
    if(command==='page/open'){const result=hostedPages.open(payload);return{...result,state:result.error?'error':result.deferred?'waiting':result.authHint?'login':result.loading?'loading':'ready'}}
    if(command==='page/reload'){const result=hostedPages.reload(payload);return{...result,state:result.error?'error':result.deferred?'waiting':result.authHint?'login':result.loading?'loading':'ready'}}
    if(command==='page/layout'){hostedPages.layout(payload);return}
    if(command==='page/status')return hostedPages.status();
    if(command==='page/close'){const current=hostedPages.status();if(!payload.nodeId||current?.nodeId===payload.nodeId)hostedPages.close();return}
    if(['board/select','board/create','project/choose','app/export','document/attach-image'].includes(command))hostedPages.close();
    if(command==='board/delete'&&hostedPages.status()?.boardId===payload.boardId)hostedPages.close();
    if(command==='node/archive'&&hostedPages.status()?.nodeId===payload.nodeId)hostedPages.close();
    if(command==='project/choose'){
      const board=service.store.board(payload.boardId);
      const result=await dialog.showOpenDialog(window,{title:'Choose a folder for Codex',buttonLabel:'Use this folder',properties:['openDirectory','createDirectory']});
      if(result.canceled)return null;
      board.projectPath=result.filePaths[0];service.changed(board);return board.projectPath;
    }
    if(command==='app/export'){
      const board=service.store.board(payload.boardId);
      const result=await dialog.showSaveDialog(window,{title:'Export canvas',defaultPath:`${board.title.replace(/[^\w -]/g,'')||'Canvas'}.json`,filters:[{name:'Canvas JSON',extensions:['json']}]});
      if(result.canceled||!result.filePath)return null;
      fs.writeFileSync(result.filePath,JSON.stringify({version:1,board},null,2),{mode:0o600});return result.filePath;
    }
    if(command==='document/attach-image'){
      const{node}=service.store.node(payload.boardId,payload.nodeId);if(node.kind!=='document')throw Error('Choose a document first.');
      const result=await dialog.showOpenDialog(window,{title:'Add an image to this document',buttonLabel:'Add image',properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','gif']}]});
      if(result.canceled)return null;
      const asset=service.assets.importImage(result.filePaths[0]);return service.insertImage({...payload,documentId:node.id,assetId:asset.id});
    }
    if(command==='app/reveal-data'){await shell.openPath(service.store.directory);return}
    if(command==='app/open-external'){openExternal(payload.url);return}
    return service.invoke(command,payload);
  });
}
function installMenu(){
  const template=[
    {label:app.name,submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
    {label:'File',submenu:[{label:'New Canvas',accelerator:'CmdOrCtrl+Shift+N',click:()=>service.invoke('board/create')},{label:'Export Canvas…',click:()=>window?.webContents.send('tangent:action','export')},{type:'separator'},{role:'close'}]},
    {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'},{type:'separator'},{label:'Find…',accelerator:'CmdOrCtrl+F',click:()=>window?.webContents.send('tangent:action','find')},{label:'Find Next',accelerator:'CmdOrCtrl+G',click:()=>window?.webContents.send('tangent:action','find-next')},{label:'Find Previous',accelerator:'CmdOrCtrl+Shift+G',click:()=>window?.webContents.send('tangent:action','find-previous')}]},
    {label:'View',submenu:[{role:'reload'},{role:'togglefullscreen'},{type:'separator'},{label:'Zoom In',accelerator:'CmdOrCtrl+Plus',click:()=>window?.webContents.send('tangent:action','zoom-in')},{label:'Zoom Out',accelerator:'CmdOrCtrl+-',click:()=>window?.webContents.send('tangent:action','zoom-out')},{label:'Actual Size',accelerator:'CmdOrCtrl+0',click:()=>window?.webContents.send('tangent:action','zoom-reset')},{label:'Fit Canvas',accelerator:'CmdOrCtrl+Shift+0',click:()=>window?.webContents.send('tangent:action','fit')},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]},
    {label:'Window',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
