import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useOnViewportChange} from '@xyflow/react';
import {Sparkles} from 'lucide-react';
import './canvas-summary-hover.css';

// This layer lives outside React Flow's transformed viewport. It reads the
// saved summary only; hovering never starts inference or changes card state.
export default function CanvasSummaryHover({board,enabled=true}) {
  const [active,setActive]=useState(null);
  const [position,setPosition]=useState(null);
  const popup=useRef(null),popupHovered=useRef(false),blocked=useRef(null),current=useRef(null),opening=useRef(null),closing=useRef(null),anchor=useRef(null),described=useRef(null);
  const latest=useRef(board);latest.current=board;
  const tooltipId='canvas-card-summary-hover';
  const clearTimers=()=>{clearTimeout(opening.current);clearTimeout(closing.current);opening.current=null;closing.current=null};
  const clearDescription=()=>{
    const previous=described.current;if(!previous)return;
    const ids=(previous.element.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==tooltipId);
    if(ids.length)previous.element.setAttribute('aria-describedby',ids.join(' '));else previous.element.removeAttribute('aria-describedby');
    described.current=null;
  };
  const dismiss=()=>{clearTimers();popupHovered.current=false;current.current=null;anchor.current=null;clearDescription();setActive(null);setPosition(null)};
  const dismissRef=useRef(dismiss);dismissRef.current=dismiss;
  const dismissForMove=useCallback(()=>dismissRef.current(),[]);
  useOnViewportChange({onChange:dismissForMove});
  useEffect(()=>{
    dismiss();blocked.current=null;if(!enabled)return;
    const surface=document.querySelector('[data-testid="canvas-surface"]');if(!surface)return;
    const nodeAt=target=>target instanceof Element?target.closest('.react-flow__node[data-id]'):null;
    const withinPopup=target=>target instanceof Node&&popup.current?.contains(target);
    const show=(element,point,immediate=false)=>{
      const node=latest.current?.nodes.find(node=>node.id===element.dataset.id&&!node.archived);
      if(!node?.summary?.text?.trim()){dismiss();return}
      clearTimers();const wasOpen=Boolean(current.current);anchor.current=element;
      opening.current=setTimeout(()=>{
        opening.current=null;
        if(!element.isConnected)return;
        clearDescription();
        const ids=new Set((element.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));ids.add(tooltipId);
        element.setAttribute('aria-describedby',[...ids].join(' '));described.current={element};
        current.current=node.id;setPosition(null);setActive({id:node.id,...point});
      },immediate||wasOpen?0:220);
    };
    const leave=()=>{clearTimeout(opening.current);opening.current=null;closing.current=setTimeout(dismiss,120)};
    const over=event=>{
      if(event.buttons)return;
      const element=nodeAt(event.target);if(!element||nodeAt(event.relatedTarget)?.dataset.id===element.dataset.id||blocked.current===element.dataset.id)return;
      if(withinPopup(event.relatedTarget)&&current.current===element.dataset.id){clearTimers();return}
      show(element,{x:event.clientX,y:event.clientY});
    };
    const out=event=>{
      const element=nodeAt(event.target);if(!element||nodeAt(event.relatedTarget)?.dataset.id===element.dataset.id||withinPopup(event.relatedTarget))return;
      if(blocked.current===element.dataset.id&&!event.buttons){
        const rect=element.getBoundingClientRect();
        if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)blocked.current=null;
      }
      leave();
    };
    const focus=event=>{
      const element=nodeAt(event.target);if(!element||event.target!==element||document.documentElement.dataset.inputModality!=='keyboard')return;
      blocked.current=null;
      const rect=element.getBoundingClientRect();show(element,{x:Math.min(rect.right,innerWidth-24),y:Math.max(72,rect.top)},true);
    };
    const blur=event=>{if(nodeAt(event.target)&&!withinPopup(event.relatedTarget)&&!popupHovered.current)leave()};
    const pointerDown=event=>{if(!withinPopup(event.target)){blocked.current=nodeAt(event.target)?.dataset.id||current.current;dismiss()}};
    const pointerMove=event=>{
      // React Flow may reconcile a captured drag without a useful pointerout.
      // Release dismissal only when the user actually moves off that card.
      if(blocked.current&&!event.buttons&&(event.movementX||event.movementY)&&nodeAt(event.target)?.dataset.id!==blocked.current)blocked.current=null;
    };
    const escape=event=>{if(event.key==='Escape'&&(current.current||opening.current)){event.preventDefault();event.stopImmediatePropagation();blocked.current=current.current||anchor.current?.dataset.id;dismiss()}};
    surface.addEventListener('pointerover',over);surface.addEventListener('pointerout',out);
    surface.addEventListener('focusin',focus);surface.addEventListener('focusout',blur);
    document.addEventListener('pointerdown',pointerDown,true);document.addEventListener('pointermove',pointerMove,true);document.addEventListener('wheel',dismiss,true);
    document.addEventListener('scroll',dismiss,true);window.addEventListener('resize',dismiss);window.addEventListener('blur',dismiss);window.addEventListener('keydown',escape,true);
    return()=>{
      clearTimers();clearDescription();current.current=null;
      surface.removeEventListener('pointerover',over);surface.removeEventListener('pointerout',out);surface.removeEventListener('focusin',focus);surface.removeEventListener('focusout',blur);
      document.removeEventListener('pointerdown',pointerDown,true);document.removeEventListener('pointermove',pointerMove,true);document.removeEventListener('wheel',dismiss,true);document.removeEventListener('scroll',dismiss,true);window.removeEventListener('resize',dismiss);window.removeEventListener('blur',dismiss);window.removeEventListener('keydown',escape,true);
    };
  },[board?.id,enabled]);
  const node=enabled?board?.nodes.find(node=>node.id===active?.id&&!node.archived):null;
  const text=node?.summary?.text?.trim();
  useEffect(()=>{if(active&&(!node||!text))dismiss()},[active?.id,Boolean(node),text]);
  useLayoutEffect(()=>{
    if(!active||!text||!popup.current)return;
    const rect=popup.current.getBoundingClientRect(),surface=document.querySelector('[data-testid="canvas-surface"]')?.getBoundingClientRect();
    const leftBound=Math.max(12,(surface?.left||0)+12),topBound=Math.max(12,(surface?.top||0)+12);
    const left=active.x+18+rect.width<=innerWidth-12?active.x+18:active.x-18-rect.width;
    const top=active.y+18+rect.height<=innerHeight-12?active.y+18:active.y-18-rect.height;
    setPosition({left:Math.max(leftBound,Math.min(innerWidth-rect.width-12,left)),top:Math.max(topBound,Math.min(innerHeight-rect.height-12,top))});
  },[active,text]);
  if(!node||!text||!active)return null;
  return createPortal(<aside ref={popup} id={tooltipId} role="tooltip" data-testid="card-summary-hover" data-node-id={node.id} className="canvas-summary-hover" style={{left:position?.left??0,top:position?.top??0,visibility:position?'visible':'hidden'}}
    onPointerEnter={()=>{popupHovered.current=true;clearTimers()}} onPointerLeave={event=>{
      popupHovered.current=false;
      if(anchor.current?.contains(event.relatedTarget)){clearTimers();return}
      closing.current=setTimeout(dismiss,120);
    }} onDoubleClick={event=>event.stopPropagation()}>
    <div className="canvas-summary-hover-heading"><Sparkles size={14} aria-hidden="true"/><span>{node.title||'Untitled card'}</span></div>
    <p data-testid="card-summary-hover-text">{text}</p>
  </aside>,document.body);
}
