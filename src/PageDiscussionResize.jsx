import React, {useLayoutEffect, useRef, useState} from 'react';
import './page-discussion-resize.css';
import {layoutBounds} from './motion.mjs';

const DEFAULT_WIDTH=420, MIN_WIDTH=320, MAX_WIDTH=800;
const preferred=value=>Number.isInteger(value)?Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,value)):DEFAULT_WIDTH;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

export function usePageDiscussionWidth({shell,focused,visible,mode,sidebar,value,onSave,onError}) {
  const [width,setWidth]=useState(preferred(value));
  const [bounds,setBounds]=useState({min:MIN_WIDTH,max:MAX_WIDTH});
  const latest=useRef(width), confirmed=useRef(preferred(value)), pending=useRef(0), sequence=useRef(0), drag=useRef(null);
  const callbacks=useRef({onSave,onError});callbacks.current={onSave,onError};
  latest.current=width;
  useLayoutEffect(()=>{if(!pending.current&&!drag.current){confirmed.current=preferred(value);setWidth(preferred(value))}},[value]);
  useLayoutEffect(()=>{
    if(!focused||!visible||!shell.current)return;
    const region=shell.current, workspace=document.querySelector('.workspace');
    const measure=()=>{
      const rect=layoutBounds(region);
      const available=mode==='half'?rect.left-(workspace?layoutBounds(workspace).left:0)-16:region.clientWidth-320;
      const max=Math.max(0,Math.min(MAX_WIDTH,Math.floor(available)));
      setBounds(old=>old.max===max?old:{min:Math.min(MIN_WIDTH,max),max});
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(region);if(workspace)observer.observe(workspace);
    window.addEventListener('resize',measure);
    return()=>{observer.disconnect();window.removeEventListener('resize',measure)};
  },[focused,visible,mode,sidebar,shell]);
  const commit=next=>{
    next=preferred(Math.round(next));latest.current=next;setWidth(next);
    const current=++sequence.current;pending.current++;
    Promise.resolve(callbacks.current.onSave({pageDiscussionWidth:next})).then(()=>{confirmed.current=next}).catch(error=>{
      if(current===sequence.current){setWidth(confirmed.current);callbacks.current.onError(error.message||'The discussion width could not save.')}
    }).finally(()=>pending.current--);
  };
  const actual=Math.round(clamp(width,bounds.min,bounds.max));
  const cancel=element=>{
    const active=drag.current;if(!active)return;
    drag.current=null;setWidth(active.preferred);document.body.classList.remove('resizing-page-discussion');
    if(element?.hasPointerCapture(active.pointer))element.releasePointerCapture(active.pointer);
  };
  useLayoutEffect(()=>()=>{drag.current=null;document.body.classList.remove('resizing-page-discussion')},[]);
  const props={
    role:'separator',tabIndex:0,'aria-label':'Resize discussion panel','aria-orientation':'vertical',
    'aria-valuemin':bounds.min,'aria-valuemax':bounds.max,'aria-valuenow':actual,
    'aria-valuetext':`${actual} pixels`,'data-testid':'page-discussion-resize',
    title:'Drag to resize · Double-click to reset',
    onPointerDown:event=>{
      if(event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.focus();
      drag.current={pointer:event.pointerId,x:event.clientX,width:actual,preferred:latest.current};
      event.currentTarget.setPointerCapture(event.pointerId);document.body.classList.add('resizing-page-discussion');
    },
    onPointerMove:event=>{const active=drag.current;if(!active||event.pointerId!==active.pointer)return;event.preventDefault();setWidth(clamp(active.width+active.x-event.clientX,bounds.min,bounds.max))},
    onPointerUp:event=>{const active=drag.current;if(!active||event.pointerId!==active.pointer)return;event.preventDefault();const next=clamp(active.width+active.x-event.clientX,bounds.min,bounds.max);drag.current=null;document.body.classList.remove('resizing-page-discussion');if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);commit(next)},
    onPointerCancel:event=>cancel(event.currentTarget),
    onLostPointerCapture:event=>cancel(event.currentTarget),
    onDoubleClick:event=>{event.preventDefault();commit(DEFAULT_WIDTH)},
    onKeyDown:event=>{
      if(event.key==='Escape'&&drag.current){event.preventDefault();event.stopPropagation();cancel(event.currentTarget);return}
      const next=event.key==='ArrowLeft'?actual+20:event.key==='ArrowRight'?actual-20:event.key==='Home'?bounds.min:event.key==='End'?bounds.max:null;
      if(next===null)return;event.preventDefault();event.stopPropagation();commit(clamp(next,bounds.min,bounds.max));
    },
  };
  return {width:actual,grip:<div className="page-discussion-resize" {...props}><span/></div>};
}
