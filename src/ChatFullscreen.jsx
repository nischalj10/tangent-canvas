import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, MessageCircle, Minimize2, X } from 'lucide-react';
import './chat-fullscreen.css';

// A focused presentation of the same durable canvas conversation. The Page and
// floating-window layouts remain in place behind it, ready to return unchanged.
export default function ChatFullscreen({ node, status, onBack, children, overlays }) {
  const [toolbarSlot, setToolbarSlot] = useState(null);
  useEffect(() => { setToolbarSlot(document.getElementById('page-toolbar-slot')); }, []);
  const toolbar = <div className="chat-focus-toolbar" aria-label="Conversation controls">
    <div className="chat-focus-title-pill">
      {node.kind === 'comment' ? <MessageCircle size={17}/> : <GitBranch size={17}/>}
      <span title={node.title}>{node.title}</span>
    </div>
    <div className="chat-focus-actions">{status}<div className="chat-focus-window-pill">
      <button type="button" data-testid="chat-focus-back" title="Exit full screen" aria-label="Exit conversation full screen" onClick={onBack}><Minimize2 size={18}/></button>
      <button type="button" data-testid="chat-focus-close" title="Close full screen" aria-label="Close conversation full screen" onClick={onBack}><X size={19}/></button>
    </div></div>
  </div>;
  return <>
    {toolbarSlot ? createPortal(toolbar, toolbarSlot) : null}
    <section className="chat-fullscreen" data-testid={`chat-fullscreen-${node.id}`} data-node-id={node.id} aria-label={`Conversation: ${node.title}`}>
      <div className="chat-focus-column">{children}</div>
      {overlays}
    </section>
  </>;
}
