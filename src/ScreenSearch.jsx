import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { activeScreenMatchIndex, findScreenMatches, literalMatches, nextScreenMatchIndex, prepareScreenSearchItems } from './screen-search.mjs';
import './screen-search.css';

const matchesHighlight = 'tangent-find-matches';
const activeHighlight = 'tangent-find-active';
const attribute = value => `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;

function visible(element) {
  if (!element || element.closest('[inert],[hidden],[aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function priority(element) {
  const floating = element.closest('.floating-side-chat');
  if (floating) return 300 + Number.parseInt(getComputedStyle(floating).zIndex, 10) || 300;
  if (element.closest('.chat-fullscreen,.chat-focus-toolbar')) return 250;
  if (element.closest('.page-discussion-panel')) return 200;
  if (element.closest('.page-reader-shell,.page-floating-toolbar')) return 150;
  return 0;
}

export function screenSearchSource(item) {
  const node = attribute(item.nodeId);
  let selector;
  if (item.kind === 'message') selector = `[data-node-id=${node}][data-message-id=${attribute(item.messageId)}] .message-text`;
  else if (item.kind === 'message-quote') selector = `[data-node-id=${node}][data-message-id=${attribute(item.messageId)}] .message-quoted-passage`;
  else if (item.kind === 'page-comment') selector = `[data-testid=${attribute(`page-focus-${item.nodeId}`)}] [data-page-comment-id=${attribute(item.commentThreadId)}] [data-page-comment-message-id=${attribute(item.commentMessageId)}] .original-comment-body`;
  else if (item.kind === 'page-comment-quote') selector = `[data-testid=${attribute(`page-focus-${item.nodeId}`)}] [data-page-comment-id=${attribute(item.commentThreadId)}] .original-comment-anchor`;
  else if (item.blockId === '__title__') selector = `.rich-page-document[data-node-id=${node}] .page-document-title`;
  else if (item.kind === 'page-block') selector = `[data-node-id=${node}][data-testid=${attribute(`page-block-${item.blockId}`)}]`;
  else if (item.kind === 'title') selector = `[data-testid=${attribute(`title-${item.nodeId}`)}], [data-testid=${attribute(`floating-chat-title-${item.nodeId}`)}], [data-testid=${attribute(`page-title-menu-${item.nodeId}`)}] > span`;
  else if (item.kind === 'draft') selector = `[data-testid=${attribute(`composer-${item.nodeId}`)}], [data-testid=${attribute(`page-ask-input-${item.nodeId}`)}], [data-testid=${attribute(`page-focus-${item.nodeId}`)}] [data-testid="comment-question"]`;
  else if (item.kind === 'note') selector = `[data-testid=${attribute(`note-${item.nodeId}`)}]`;
  else if (item.kind === 'document') selector = `[data-testid=${attribute(`document-editor-${item.nodeId}`)}], [data-testid=${attribute(`document-preview-${item.nodeId}`)}]`;
  if (!selector) return null;
  const candidates = [...document.querySelectorAll(selector)];
  if (item.kind === 'title' && document.querySelector(`[data-testid=${attribute(`chat-fullscreen-${item.nodeId}`)}]`)) {
    candidates.push(...document.querySelectorAll('.chat-focus-title-pill > span'));
  }
  const source = candidates.filter(visible).sort((a, b) => priority(b) - priority(a))[0];
  if (!source && item.blockId === '__title__') return screenSearchSource({ ...item, kind: 'title', blockId: undefined });
  return source || null;
}

function sourceText(element, kind) {
  if (element?.matches('input,textarea')) return { text: element.value, fragments: [] };
  if (!element) return { text: '', fragments: [] };
  const fragments = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,iframe,svg,[hidden],[inert],[aria-hidden="true"],[data-screen-search-root]') || !['title','page-comment-quote'].includes(kind) && parent.closest('button')) return NodeFilter.FILTER_REJECT;
      if (kind === 'message' && parent.closest('.message-quoted-passage')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '', node;
  while ((node = walker.nextNode())) {
    const start = text.length;
    text += node.nodeValue;
    fragments.push({ node, start, end: text.length });
  }
  return { text, fragments };
}

function textRanges(element, query, kind) {
  const { text, fragments } = sourceText(element, kind);
  return literalMatches(text, query).flatMap(match => {
    const first = fragments.find(fragment => fragment.end > match.start);
    const last = fragments.find(fragment => fragment.end >= match.end);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, match.start - first.start);
    range.setEnd(last.node, match.end - last.start);
    return [range];
  });
}

function scrollMatch(element, range) {
  // Scroll the actual passage, including a match deep inside a long paragraph.
  // Native selection and the editor's caret remain untouched.
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`)) continue;
    const target = range?.getBoundingClientRect() || element.getBoundingClientRect();
    const frame = parent.getBoundingClientRect();
    const scaleY = frame.height / (parent.offsetHeight || frame.height) || 1;
    const scaleX = frame.width / (parent.offsetWidth || frame.width) || 1;
    const top = target.top < frame.top + 18 ? target.top - frame.top - 18 : target.bottom > frame.bottom - 18 ? target.bottom - frame.bottom + 18 : 0;
    const left = target.left < frame.left + 12 ? target.left - frame.left - 12 : target.right > frame.right - 12 ? target.right - frame.right + 12 : 0;
    if (top && parent.scrollHeight > parent.clientHeight) parent.scrollTop += top / scaleY;
    if (left && parent.scrollWidth > parent.clientWidth) parent.scrollLeft += left / scaleX;
  }
}

export default function ScreenSearch({ scope, onNavigate, onClose, requestId }) {
  const input = useRef(null), bar = useRef(null), navigate = useRef(onNavigate), current = useRef(null), lastIndex = useRef(0), userInteraction = useRef(0);
  const fieldSelections = useRef(new Map());
  const focusOrigin = useRef(document.activeElement);
  const [query, setQuery] = useState(''), [activeKey, setActiveKey] = useState(null), [visibilityRevision, setVisibilityRevision] = useState(0);
  const [stepRequest, setStepRequest] = useState(0);
  const [error, setError] = useState('');
  navigate.current = onNavigate;
  const prepared = useMemo(() => prepareScreenSearchItems(scope?.items), [scope?.items]);
  const indexed = useMemo(() => prepared.flatMap(item => {
    const source = screenSearchSource(item);
    if (item.visibleOnly && !source) return [];
    // ProseMirror can hold a richer edit than the last persisted snapshot. Read
    // its visible block directly; no persistence delay or Markdown roundtrip is
    // needed before a just-typed passage can be found.
    if (source && (item.kind === 'page-block' || item.kind === 'page-comment-quote' || item.blockId === '__title__' || source.matches('input,textarea'))) {
      return [{ ...item, searchText: sourceText(source, item.kind).text }];
    }
    return [item];
  }), [prepared, visibilityRevision]);
  const matches = useMemo(() => findScreenMatches(indexed, query), [indexed, query]);
  const index = activeScreenMatchIndex(matches, activeKey, lastIndex.current), hit = matches[index];
  current.current = { matches, index, hit, query, stepRequest };

  useEffect(() => { input.current?.focus(); input.current?.select(); }, [requestId]);
  useEffect(() => { lastIndex.current = Math.max(index, 0); }, [index]);

  const restoreField = element => {
    const saved = fieldSelections.current.get(element);
    element.removeAttribute('data-screen-search-hit');
    if (!saved) return;
    // Never replace a caret the user has moved, or apply old offsets after an
    // edit. Native selection marking itself neither edits nor focuses a field.
    if (!saved.userTouched && element.isConnected && element.value === saved.value && element.selectionStart === saved.appliedStart && element.selectionEnd === saved.appliedEnd) {
      try { element.setSelectionRange(saved.start, saved.end, saved.direction); } catch {}
    }
    fieldSelections.current.delete(element);
  };
  const markField = (element, active, state) => {
    const field = element?.matches('input,textarea') ? element : null;
    for (const previous of fieldSelections.current.keys()) if (previous !== field) restoreField(previous);
    if (!field || !active) return;
    const range = literalMatches(field.value, state.query)[active.occurrence];
    if (!range) { restoreField(field); return; }
    const token = `${active.key}:${state.query}:${state.stepRequest}`;
    let saved = fieldSelections.current.get(field);
    if (saved?.userTouched && saved.token === token) return;
    if (!saved || saved.userTouched) {
      saved = { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection || 'none', value: field.value, userTouched: false };
      fieldSelections.current.set(field, saved);
    }
    saved.token = token;
    saved.appliedStart = range.start; saved.appliedEnd = range.end;
    field.setAttribute('data-screen-search-hit', 'active');
    if (field.selectionStart !== range.start || field.selectionEnd !== range.end) {
      try { field.setSelectionRange(range.start, range.end); } catch {}
    }
  };

  const paint = () => {
    const state = current.current;
    markField(state.hit ? screenSearchSource(state.hit) : null, state.hit, state);
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    const all = [], selected = [], visited = new Set();
    for (const match of state.matches) {
      if (visited.has(match.id)) continue;
      visited.add(match.id);
      const source = screenSearchSource(match);
      if (!source) continue;
      const ranges = textRanges(source, state.query, match.kind);
      all.push(...ranges);
      if (state.hit?.id === match.id && ranges[state.hit.occurrence]) selected.push(ranges[state.hit.occurrence]);
    }
    CSS.highlights.set(matchesHighlight, new Highlight(...all));
    CSS.highlights.set(activeHighlight, new Highlight(...selected));
  };
  const paintRef = useRef(paint); paintRef.current = paint;

  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { setVisibilityRevision(value => value + 1); paintRef.current(); });
    };
    const observer = new MutationObserver(records => {
      const relevant = records.filter(record => !bar.current?.contains(record.target));
      if (!relevant.length) return;
      refresh();
    });
    const touchedField = event => {
      const saved = fieldSelections.current.get(event.target);
      if (saved) saved.userTouched = true;
    };
    const changedInput = event => { touchedField(event); if (!bar.current?.contains(event.target)) refresh(); };
    const interacted = event => {
      touchedField(event);
      if (event.type === 'keydown' && event.key === 'Tab' || !bar.current?.contains(event.target)) userInteraction.current++;
    };
    const blurred = () => { userInteraction.current++; };
    const findStep = event => {
      const state = current.current, direction = Number(event.detail) < 0 ? -1 : 1;
      const next = nextScreenMatchIndex(state.index, direction, state.matches.length);
      if (next >= 0) { lastIndex.current = next; setActiveKey(state.matches[next].key); setStepRequest(value => value + 1); }
    };
    observer.observe(document.getElementById('root') || document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'inert', 'aria-hidden'] });
    document.addEventListener('input', changedInput, true);
    document.addEventListener('pointerdown', interacted, true);
    document.addEventListener('keydown', interacted, true);
    window.addEventListener('blur', blurred);
    window.addEventListener('tangent:find-step', findStep);
    return () => {
      const focused = document.activeElement, restoreFocus = focused === document.body || bar.current?.contains(focused);
      observer.disconnect(); cancelAnimationFrame(frame);
      document.removeEventListener('input', changedInput, true);
      document.removeEventListener('pointerdown', interacted, true);
      document.removeEventListener('keydown', interacted, true);
      window.removeEventListener('blur', blurred);
      window.removeEventListener('tangent:find-step', findStep);
      for (const field of fieldSelections.current.keys()) restoreField(field);
      CSS.highlights?.delete(matchesHighlight); CSS.highlights?.delete(activeHighlight);
      const origin = focusOrigin.current;
      if (restoreFocus && origin?.isConnected && visible(origin)) origin.focus?.({ preventScroll: true });
    };
  }, []);

  useEffect(() => { paintRef.current(); }, [matches, index]);
  useEffect(() => {
    let cancelled = false, firstFrame = 0, secondFrame = 0;
    const ownedFocus = bar.current?.contains(document.activeElement), interaction = userInteraction.current;
    setError('');
    if (!hit) return;
    Promise.resolve().then(() => navigate.current?.(hit)).then(() => {
      if (cancelled) return;
      firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => {
        if (cancelled) return;
        const active = current.current.hit;
        if (active?.key !== hit.key || active.query !== hit.query) return;
        const source = screenSearchSource(active);
        if (source) scrollMatch(source, textRanges(source, active.query, active.kind)[active.occurrence]);
        paintRef.current();
        const focused = document.activeElement;
        if (ownedFocus && interaction === userInteraction.current && !bar.current?.contains(focused) && (focused === document.body || focused?.matches('input,textarea,[contenteditable="true"]') || focused?.closest('.ProseMirror'))) {
          input.current?.focus({ preventScroll: true });
        }
      }); });
    }).catch(() => { if (!cancelled) setError('Could not reveal this result.'); });
    return () => { cancelled = true; cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); };
  }, [hit?.key, query, stepRequest]);

  const step = direction => {
    const next = nextScreenMatchIndex(index, direction, matches.length);
    if (next >= 0) { lastIndex.current = next; setActiveKey(matches[next].key); setStepRequest(value => value + 1); }
  };
  return <section ref={bar} role="search" aria-label={`Find in ${scope?.label || 'this view'}`} className="screen-search nodrag nopan" data-testid="screen-search" data-screen-search-root="" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
  }}>
    <Search size={16} aria-hidden="true"/>
    <input ref={input} type="search" autoComplete="off" spellCheck={false} aria-label={`Find in ${scope?.label || 'this view'}`} placeholder={`Find in ${scope?.label || 'this view'}`} value={query} data-testid="screen-search-input" onChange={event => { lastIndex.current = 0; setActiveKey(null); setQuery(event.target.value); }} />
    <span className={`screen-search-count ${query && !matches.length ? 'is-empty' : ''}`} role="status" aria-live="polite" data-testid="screen-search-count">{query ? matches.length ? `${index + 1} of ${matches.length}` : 'No results' : ''}</span>
    <span className="screen-search-divider" aria-hidden="true"/>
    <button type="button" title="Previous result (Shift Enter)" aria-label="Previous result" disabled={!matches.length} data-testid="screen-search-previous" onClick={() => step(-1)}><ChevronUp size={17}/></button>
    <button type="button" title="Next result (Enter)" aria-label="Next result" disabled={!matches.length} data-testid="screen-search-next" onClick={() => step(1)}><ChevronDown size={17}/></button>
    <button type="button" title="Close find (Escape)" aria-label="Close find" data-testid="screen-search-close" onClick={onClose}><X size={16}/></button>
    {error && <span className="screen-search-error" role="status">{error}</span>}
  </section>;
}
