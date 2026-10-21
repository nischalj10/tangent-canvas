import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Shield, ShieldCheck, Sparkles } from 'lucide-react';
import './permission-chooser.css';

export const PERMISSION_CHOICES = [
  { value:'full', label:'Full access', description:'Unrestricted access to files and the internet', Icon:ShieldCheck },
  { value:'ask', label:'Ask for approval', description:'Ask before changes outside the read-only sandbox', Icon:Shield },
  { value:'auto', label:'Approve for me', description:'Codex reviews approval requests for risk', Icon:Sparkles },
];
const choiceFor = value => PERMISSION_CHOICES.find(choice => choice.value === value) || PERMISSION_CHOICES[0];

// Reused by ordinary, floating, focused, and Page discussion composers. These
// values select native Codex policies; the UI never implements an approval bypass.
export default function PermissionChooser({ value='full', onChange, disabled=false, running=false, activeValue, testId='permission-chooser', label='Permissions for this chat' }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const selected = choiceFor(value);
  const active = choiceFor(activeValue || (running ? 'full' : value));
  const deferred = running && active.value !== selected.value;
  const close = (returnFocus=false) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus({ preventScroll:true });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = menu.current?.getBoundingClientRect();
      if (!anchor || !popup) return;
      const gutter = 12;
      const above = anchor.top - popup.height - 8;
      const top = above >= 54 ? above : Math.min(innerHeight-popup.height-gutter, anchor.bottom+8);
      setPosition({ left:Math.max(gutter, Math.min(innerWidth-popup.width-gutter, anchor.left)), top:Math.max(gutter,top) });
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener('resize',place);
    window.addEventListener('scroll',place,true);
    return () => { observer.disconnect(); window.removeEventListener('resize',place); window.removeEventListener('scroll',place,true); };
  },[open,running,selected.value,active.value]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) close(); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();event.stopImmediatePropagation();close(true);
    };
    document.addEventListener('pointerdown',outside,true);
    window.addEventListener('keydown',escape,true);
    const focus = requestAnimationFrame(() => menu.current?.querySelector('[aria-checked="true"]')?.focus({ preventScroll:true }));
    return () => { cancelAnimationFrame(focus); document.removeEventListener('pointerdown',outside,true); window.removeEventListener('keydown',escape,true); };
  },[open]);
  const Icon = selected.Icon;
  return <>
    <button ref={trigger} type="button" className={`permission-chooser-trigger is-${selected.value}`} data-testid={testId} data-permission-mode={selected.value} aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
      title={running ? `${selected.label} for the next turn · Current turn: ${active.label}` : selected.description}
      onClick={() => { setPosition(null); setOpen(current => !current); }}>
      <Icon size={12}/><span>{selected.label}</span>{deferred && <small>Next turn</small>}<ChevronDown size={9}/>
    </button>
    {open && createPortal(<div ref={menu} className="permission-chooser-menu" role="menu" aria-label={label} data-testid={`${testId}-menu`} style={position || {left:0,top:0,visibility:'hidden'}}
      onKeyDown={event => {
        const items = [...menu.current.querySelectorAll('[role="menuitemradio"]')];
        const index = items.indexOf(document.activeElement);
        if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
          event.preventDefault();event.stopPropagation();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : (index+(event.key === 'ArrowDown' ? 1 : -1)+items.length)%items.length;
          items[next]?.focus();
        }
        if (event.key === 'Tab') close();
      }}>
      <p className="permission-chooser-heading">Permissions</p>
      {PERMISSION_CHOICES.map(choice => <button key={choice.value} type="button" role="menuitemradio" aria-checked={selected.value === choice.value} data-testid={`${testId}-option-${choice.value}`} className={`permission-choice is-${choice.value}`} disabled={disabled}
        onClick={() => { close(true); onChange?.(choice.value); }}>
        <span className="permission-choice-symbol"><choice.Icon size={17}/></span><span><strong>{choice.label}</strong><small>{choice.description}</small></span>{selected.value === choice.value && <Check size={15}/>}
      </button>)}
      {running && <p className="permission-chooser-current" data-testid={`${testId}-current`}>Changes apply to the next turn.<br/>Current turn: <strong>{active.label}</strong></p>}
    </div>,document.body)}
  </>;
}
