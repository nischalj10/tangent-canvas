// Draft text stays local to its composer. Only bounded recovery checkpoints
// cross the desktop bridge, and shutdown waits for those checkpoints to settle.
const flushers=new Set();
const writesInFlight=new Set();
const keyedTails=new Map();
const keyedAcknowledgements=new Map();

function releaseKey(key,acknowledgement){
  if(!acknowledgement.members&&!keyedTails.has(key)&&keyedAcknowledgements.get(key)===acknowledgement)
    keyedAcknowledgements.delete(key);
}

function track(promise){
  writesInFlight.add(promise);
  const settled=()=>writesInFlight.delete(promise);
  promise.then(settled,settled);
  return promise;
}

export function createDraftPersistence({key,read,write,initial='',onError,idleMs=750,maxWaitMs=2000}){
  if(typeof read!=='function'||typeof write!=='function')throw new TypeError('Draft persistence needs read and write functions.');
  if(!Number.isFinite(idleMs)||idleMs<0||!Number.isFinite(maxWaitMs)||maxWaitMs<0)throw new RangeError('Draft save intervals must be finite and non-negative.');
  let saved=initial,tail=Promise.resolve(),idleTimer=null,maxTimer=null,disposed=false,disposal=null,registered=true;
  const keyed=key!==undefined;
  let acknowledgement;
  if(keyed){
    acknowledgement=keyedAcknowledgements.get(key);
    if(!acknowledgement){acknowledgement={value:initial,members:0};keyedAcknowledgements.set(key,acknowledgement)}
    acknowledgement.members++;
  }
  const report=error=>{try{onError?.(error)}catch{/* Preserve the actual save failure if its presenter also fails. */}};
  const cancel=()=>{clearTimeout(idleTimer);clearTimeout(maxTimer);idleTimer=null;maxTimer=null};
  const flush=(...args)=>{
    cancel();
    let value;
    try{value=args.length&&args[0]!==undefined?args[0]:read()}
    catch(error){report(error);return Promise.reject(error)}
    const force=args[1]?.force===true;
    // Compare only after the preceding acknowledgement. A failed write has not
    // saved its value, and an explicit empty draft must follow a pending write.
    // Canvas, floating and full-screen composers can briefly overlap during a
    // view change. Their writes share the logical card's ordering and receipt.
    const previous=keyed?(keyedTails.get(key)||Promise.resolve()):tail;
    const operation=previous.then(async()=>{
      if(!force&&value===(keyed?acknowledgement.value:saved))return;
      try{await write(value);if(keyed)acknowledgement.value=value;else saved=value}
      catch(error){report(error);throw error}
    });
    tail=operation.catch(()=>{});
    if(keyed){
      const currentTail=tail;keyedTails.set(key,currentTail);
      currentTail.then(()=>{
        if(keyedTails.get(key)===currentTail)keyedTails.delete(key);
        releaseKey(key,acknowledgement);
      });
    }
    return track(operation);
  };
  const registeredFlush=(force=false)=>flush(undefined,{force}).then(()=>{
    if(disposed&&registered){
      registered=false;flushers.delete(registeredFlush);
      if(keyed){acknowledgement.members--;releaseKey(key,acknowledgement)}
    }
  });
  const fromTimer=()=>{flush().catch(()=>{})};
  const schedule=()=>{
    if(disposed)return;
    clearTimeout(idleTimer);idleTimer=setTimeout(fromTimer,idleMs);
    if(maxTimer===null)maxTimer=setTimeout(fromTimer,maxWaitMs);
  };
  const dispose=()=>{
    if(disposal)return disposal;
    disposed=true;cancel();
    disposal=registeredFlush().catch(error=>{disposal=null;throw error});
    // Keep a failed final checkpoint registered: shutdown can retry a disposed
    // composer's recovery text even after its React view has gone away.
    return disposal;
  };
  flushers.add(registeredFlush);
  return{schedule,cancel,flush,dispose};
}

export async function flushPendingDrafts(){
  const visited=new Set(),observed=new Set(),errors=[];
  // Include views registered while a previous checkpoint was waiting, and
  // writes already issued by views which have since disposed themselves.
  while(true){
    const requests=[];
    for(const flush of flushers)if(!visited.has(flush)){visited.add(flush);requests.push(flush(true))}
    for(const operation of writesInFlight)if(!observed.has(operation))requests.push(operation);
    const pending=[...new Set(requests)].filter(operation=>!observed.has(operation));
    if(!pending.length)break;
    pending.forEach(operation=>observed.add(operation));
    const results=await Promise.allSettled(pending);
    for(const result of results)if(result.status==='rejected'&&!errors.includes(result.reason))errors.push(result.reason);
  }
  if(errors.length)throw new AggregateError(errors,'Some message drafts could not be saved.');
}
