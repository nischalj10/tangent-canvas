import React, {useEffect, useState} from 'react';
import {Check, Circle, LoaderCircle} from 'lucide-react';

// Persistence receipts are deliberately local to these small indicators. A
// disk checkpoint must never replace the canvas state or rerender its chats.
function usePersistence(initial) {
  const [status,setStatus]=useState(initial);
  useEffect(()=>window.tangent?.subscribe(event=>{
    const next=event.type==='persistence'?event.persistence:event.type==='state'?event.state?.persistence:null;
    if(next)setStatus(previous=>previous?.saving===next.saving&&previous?.error===next.error?previous:next);
  }),[]);
  return status;
}

export function LocalSaveStatus({initial}) {
  const status=usePersistence(initial);
  return <span className={`saved-label ${status?.error?'save-error':''}`} role="status" title={status?.error||'Autosaves locally. Drafts save after a brief pause.'}>
    {status?.error?<><Circle size={7} fill="currentColor"/>Could not save</>:<><Check size={11}/>On this Mac</>}
  </span>;
}

export function DocumentSaveStatus({initial,conflict,saving}) {
  const status=usePersistence(initial);
  return <span className="document-save-status">
    {conflict||status?.error?'Draft not saved':saving||status?.saving?<><LoaderCircle size={10} className="spin"/>Saving</>:<><Check size={10}/>{status?'Saved':'Local document'}</>}
  </span>;
}
