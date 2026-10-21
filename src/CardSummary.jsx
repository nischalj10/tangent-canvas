import React, {useState} from 'react';
import {CircleAlert, LoaderCircle, RotateCw, Sparkles} from 'lucide-react';
import './card-summary.css';

const working=status=>status==='queued'||status==='running';
const modelLabel=summary=>summary?.fast?'GPT-6 Luna · Low · Fast':'';

export default function CardSummary({node,boardId,invoke}){
  const [requesting,setRequesting]=useState(false);
  const [requestError,setRequestError]=useState('');
  const summary=node.summary;
  const pending=requesting||working(summary?.status);
  const error=requestError||(summary?.status==='error'?(summary.error||'The summary could not be generated.'):'');
  const text=summary?.text?.trim();
  if(!text&&!pending&&!error)return null;
  const regenerate=async event=>{
    event.stopPropagation();setRequestError('');setRequesting(true);
    try{if(await invoke('node/summarize',{boardId,nodeId:node.id,force:true})===null)throw Error('The summary could not start. Try again.')}
    catch(error){setRequestError(error.message||'The summary could not start. Try again.')}
    finally{setRequesting(false)}
  };
  return <div className={`card-summary nodrag nopan ${pending?'is-working':''} ${error?'has-error':''}`} data-testid={`card-summary-${node.id}`} role="note" aria-label="Card summary" aria-busy={pending} onDoubleClick={event=>event.stopPropagation()}>
    <span className="card-summary-symbol" aria-hidden="true">{pending?<LoaderCircle size={13} className="spin"/>:error?<CircleAlert size={13}/>:<Sparkles size={13}/>}</span>
    <div className="card-summary-content">
      <p className="card-summary-text" data-testid={`summary-text-${node.id}`} title={text||error||undefined}>{text||(pending?'Summarizing this card…':'Couldn’t summarize this card.')}</p>
      {error&&text&&<span className="card-summary-error" role="status" data-testid={`summary-status-${node.id}`}>Couldn’t refresh. <button type="button" onClick={regenerate} disabled={pending} title={error}>Retry</button></span>}
      {error&&!text&&<span className="card-summary-error card-summary-error-detail" role="status" data-testid={`summary-status-${node.id}`} title={error}>Try again when you’re ready.</span>}
    </div>
    <button type="button" className="card-summary-regenerate" data-testid={`summary-regenerate-${node.id}`} title={pending?'Summarizing…':`${error?'Retry summary':'Regenerate summary'}${modelLabel(summary)?` · ${modelLabel(summary)}`:''}`} aria-label={`${error?'Retry':'Regenerate'} summary for ${node.title||'this card'}`} onClick={regenerate} disabled={pending}>
      <RotateCw size={13} aria-hidden="true"/>
    </button>
  </div>;
}

export function BoardSummaryControl({board,invoke}){
  const [requesting,setRequesting]=useState(false);
  const [requestError,setRequestError]=useState('');
  const run=board.summaryRun;
  const pending=requesting||run?.status==='running';
  const total=run?.total||0,completed=run?.completed||0,failed=run?.failed||0;
  const summarized=Math.max(0,completed-(run?.skipped||0));
  const cards=board.nodes.filter(node=>!node.archived);
  const fast=cards.some(node=>node.summary?.fast);
  const progress=run?.status==='running'&&total?`${Math.min(total,completed+failed)}/${total}`:'';
  const status=pending?`Summarizing cards${progress?` ${progress}`:'…'}`:run?.status==='partial'?`${summarized} summarized · ${failed} need a retry`:run?.status==='error'?'Summaries need a retry':run?.status==='completed'?`${summarized} ${summarized===1?'card':'cards'} summarized`:'';
  const summarize=async()=>{
    setRequestError('');setRequesting(true);
    try{if(await invoke('board/summarize',{boardId:board.id})===null)throw Error('Summaries could not start. Try again.')}
    catch(error){setRequestError(error.message||'Summaries could not start. Try again.')}
    finally{setRequesting(false)}
  };
  return <div className="board-summary-control">
    <button type="button" className="dock-button board-summary-button" data-testid="summarize-cards" aria-label="Summarize cards" aria-busy={pending} disabled={pending||!cards.length} title={requestError||`${pending?status:'Two-line summaries for your canvas cards'}${fast?' · GPT-6 Luna · Low · Fast':''}`} onClick={summarize}>
      {pending?<LoaderCircle size={16} className="spin" aria-hidden="true"/>:<Sparkles size={16} aria-hidden="true"/>}
      <span>{pending?`Summarizing${progress?` ${progress}`:'…'}`:'Summarize cards'}</span>
    </button>
    <span className="board-summary-status" role="status" aria-live="polite" data-testid="card-summary-progress">{requestError||status}</span>
  </div>;
}
