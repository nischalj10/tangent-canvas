import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp, Maximize2, MessageCircle, X } from 'lucide-react';
import './floating-side-chat.css';
import {cardAttention,cardAttentionDescription} from './card-attention.mjs';

const margin=12;
const headerTop=()=>Math.max(46,parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--workspace-header-height'))||46)+8;
function fit(box,minimized){
  const top=headerTop(),width=Math.min(Math.max(360,box.width),innerWidth-margin*2),height=Math.min(Math.max(260,box.height),innerHeight-top-margin);
  return{width,height,x:Math.min(Math.max(margin,box.x),Math.max(margin,innerWidth-width-margin)),y:Math.min(Math.max(top,box.y),Math.max(top,innerHeight-(minimized?49:height)-margin))};
}
const defaultBox=index=>{const width=Math.min(460,innerWidth-margin*2),height=Math.min(680,innerHeight-headerTop()-margin);return{x:innerWidth-width-24-(index%7)*32,y:innerHeight-height-24-(index%7)*28,width,height}};

// Geometry belongs to this floating view, independently of the durable canvas
// card. Pointer capture keeps dragging reliable over Page images and iframes.
export default function FloatingSideChat({ node,chats,minimized,onSelect,onMinimize,onClose,onCanvas,onFullScreen,status,children,geometry,onGeometryChange,onActivate,stackIndex=0,spawnIndex=0 }) {
  const frame=useRef(null),gesture=useRef(null),latest=useRef(null);
  const[box,setBox]=useState(()=>fit(geometry||defaultBox(spawnIndex),minimized)),[dragging,setDragging]=useState(false);
  const current=useRef(box);latest.current={minimized,onGeometryChange};
  const place=(next,commit=false)=>{const fitted=fit(next,latest.current.minimized);current.current=fitted;setBox(fitted);if(commit)latest.current.onGeometryChange?.(fitted);return fitted};
  useLayoutEffect(()=>{place(geometry||current.current);},[geometry?.x,geometry?.y,geometry?.width,geometry?.height,minimized]);
  useEffect(()=>{const resize=()=>place(current.current,true);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[]);
  const finish=event=>{
    const active=gesture.current;if(!active||event?.pointerId!==undefined&&event.pointerId!==active.pointerId)return;
    gesture.current=null;setDragging(false);place(current.current,true);
    try{if(active.target.hasPointerCapture(active.pointerId))active.target.releasePointerCapture(active.pointerId)}catch{}
  };
  useEffect(()=>{const blur=()=>finish();window.addEventListener('blur',blur);return()=>window.removeEventListener('blur',blur)},[]);
  const begin=(event,kind)=>{
    if(event.button!==0||event.isPrimary===false||kind==='drag'&&event.target.closest('button,select,input,textarea,a,[role="button"],.floating-chat-resize'))return;
    event.preventDefault();event.stopPropagation();
    gesture.current={kind,pointerId:event.pointerId,target:event.currentTarget,clientX:event.clientX,clientY:event.clientY,box:{...current.current}};
    event.currentTarget.setPointerCapture(event.pointerId);setDragging(kind==='drag');
  };
  const move=event=>{
    const active=gesture.current;if(!active||active.pointerId!==event.pointerId)return;
    const dx=event.clientX-active.clientX,dy=event.clientY-active.clientY,start=active.box;
    if(active.kind==='drag')place({...start,x:start.x+dx,y:start.y+dy});
    else{
      const right=start.x+start.width,bottom=start.y+start.height;
      const width=Math.min(Math.max(360,start.width-dx),right-margin),height=Math.min(Math.max(260,start.height-dy),bottom-headerTop());
      place({x:right-width,y:bottom-height,width,height});
    }
  };
  const pointer={onPointerMove:move,onPointerUp:finish,onPointerCancel:finish,onLostPointerCapture:finish};
  return <section ref={frame} style={{left:box.x,top:box.y,right:'auto',bottom:'auto',width:box.width,height:minimized?49:box.height,zIndex:35+Math.min(50,stackIndex)}} onPointerDownCapture={onActivate} className={`floating-side-chat ${minimized?'is-minimized':''} ${dragging?'is-dragging':''}`} data-testid={`floating-side-chat-${node.id}`} data-node-id={node.id} data-attention={cardAttention(node)} aria-description={cardAttentionDescription(node)} aria-label={`Side conversation: ${node.title}`}>
    {!minimized&&<span className="floating-chat-resize" data-testid={`floating-chat-resize-${node.id}`} title="Resize side conversation" onPointerDown={event=>begin(event,'resize')} {...pointer}/>}
    <header className="floating-chat-toolbar" data-testid={`floating-chat-drag-${node.id}`} onPointerDown={event=>begin(event,'drag')} {...pointer}>
      <MessageCircle size={15} aria-hidden="true"/>
      <span className="floating-chat-title" title={node.title} data-testid={`floating-chat-title-${node.id}`}>{node.title}</span>
      <label className="floating-chat-history-control"><select aria-label="Side conversation" data-testid="floating-chat-history" value={node.id} onChange={event=>onSelect(event.target.value)}>{chats.map(chat=><option key={chat.id} value={chat.id}>{chat.title}</option>)}</select><ChevronDown size={12} aria-hidden="true"/></label>
      {status}
      {onFullScreen&&<button className="icon-button" type="button" title="Open chat full screen" aria-label="Open chat full screen" data-testid={`floating-chat-fullscreen-${node.id}`} onClick={onFullScreen}><Maximize2 size={15}/></button>}
      <button className="icon-button" type="button" title="Show conversation on canvas" aria-label="Show conversation on canvas" data-testid={`floating-chat-canvas-${node.id}`} onClick={onCanvas}><ArrowUpRight size={15}/></button>
      <button className="icon-button" type="button" title={minimized?'Expand side conversation':'Minimize side conversation'} aria-label={minimized?'Expand side conversation':'Minimize side conversation'} aria-expanded={!minimized} data-testid={`floating-chat-collapse-${node.id}`} onClick={onMinimize}>{minimized?<ChevronDown size={15}/>:<ChevronUp size={15}/>}</button>
      <button className="icon-button" type="button" title="Close side conversation" aria-label="Close side conversation" data-testid={`floating-chat-close-${node.id}`} onClick={onClose}><X size={15}/></button>
    </header>
    <div className="floating-chat-content" hidden={minimized}>{children}</div>
  </section>;
}
