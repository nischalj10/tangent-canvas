const {contextBridge,ipcRenderer}=require('electron');
const draftFlushers=new Set();
ipcRenderer.on('tangent:flush-drafts',(_event,id)=>{
  Promise.all([...draftFlushers].map(flush=>Promise.resolve().then(flush))).then(
    ()=>ipcRenderer.send('tangent:drafts-flushed',{id,ok:true}),
    error=>ipcRenderer.send('tangent:drafts-flushed',{id,ok:false,error:String(error?.message||'Drafts could not be saved')})
  );
});
const allowed=new Set(['app/state','app/connection','app/reconnect','board/create','board/select','board/update','board/delete','board/summarize','node/summarize','project/choose','node/create','node/update','node/archive','node/restore','node/send','node/queue','node/steer','node/settings','queue/update','queue/remove','queue/reorder','queue/resume','queue/pause','queue/send-now','page/link','page/sync','page/initialize','page/edit-block','page/draft','page/flush','page/retry','page/resolve-draft','page/settings','page/ask','page/open','page/reload','page/layout','page/close','page/status','node/branch','node/stop','codex/threads','codex/import','codex/settings','approval/respond','question/respond','document/save','document/ask','document/attach-image','media/insert','app/reveal-data','app/export','app/open-external','app/copy-text']);
contextBridge.exposeInMainWorld('tangent',Object.freeze({
  invoke(command,payload={}){if(!allowed.has(command))return Promise.reject(new Error('Unknown action'));return ipcRenderer.invoke('tangent:invoke',command,payload)},
  subscribe(listener){const handler=(_event,payload)=>listener(payload);ipcRenderer.on('tangent:event',handler);return()=>ipcRenderer.removeListener('tangent:event',handler)},
  onAction(listener){const handler=(_event,payload)=>listener(payload);ipcRenderer.on('tangent:action',handler);return()=>ipcRenderer.removeListener('tangent:action',handler)},
  onFlushDrafts(listener){draftFlushers.add(listener);return()=>draftFlushers.delete(listener)}
}));
