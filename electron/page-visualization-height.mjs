// Shared, privilege-free protocol for opaque Page figure frames.
export const PAGE_VISUALIZATION_TOKEN_PREFIX = 'tangent-page-visualization:';
export const PAGE_VISUALIZATION_HEIGHT = 'tangent-page-visualization:height';
export const PAGE_VISUALIZATION_MEASURE = 'tangent-page-visualization:measure';
export const PAGE_VISUALIZATION_MIN_HEIGHT = 80;
export const PAGE_VISUALIZATION_MAX_HEIGHT = 20000;

export function pageVisualizationSource(value) {
  return typeof value === 'string' && /^tangent-page-media:\/\/[a-f0-9]{64}\.html$/i.test(value);
}

export function readPageVisualizationHeight(event, source, token, { min = PAGE_VISUALIZATION_MIN_HEIGHT, max = PAGE_VISUALIZATION_MAX_HEIGHT } = {}) {
  if (!source || event?.source !== source || typeof token !== 'string' || !token) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== PAGE_VISUALIZATION_HEIGHT || data.token !== token) return null;
  if (typeof data.height !== 'number' || !Number.isFinite(data.height) || data.height <= 0 || typeof data.width !== 'number' || !Number.isFinite(data.width) || data.width <= 0 || data.width > 100000) return null;
  const lower = Number.isFinite(min) ? Math.max(1, Math.ceil(min)) : PAGE_VISUALIZATION_MIN_HEIGHT;
  const upper = Number.isFinite(max) ? Math.max(lower, Math.floor(max)) : PAGE_VISUALIZATION_MAX_HEIGHT;
  return { height: Math.min(upper, Math.max(lower, Math.ceil(data.height))), sourceHeight: Math.ceil(data.height), width: data.width, limited: data.height > upper };
}

// Appended only to the served wrapper. Authenticated archived HTML stays byte-identical.
// The child has an opaque origin and receives no app preload, tokens or native API.
export function injectPageVisualizationHeightBridge(html) {
  if (typeof html !== 'string') throw new TypeError('Page visualization HTML must be text');
  if (/<script\b[^>]*\bdata-tangent-page-height-bridge(?:\s|=|>)/i.test(html)) return html;
  const script = `<script data-tangent-page-height-bridge>(function(){
'use strict';
var prefix=${JSON.stringify(PAGE_VISUALIZATION_TOKEN_PREFIX)}, kind=${JSON.stringify(PAGE_VISUALIZATION_HEIGHT)}, request=${JSON.stringify(PAGE_VISUALIZATION_MEASURE)};
var token=window.name.indexOf(prefix)===0?window.name.slice(prefix.length):'';
if(window.parent===window)return;
var queued=false,lastHeight=0,lastWidth=0;
function number(value){var n=parseFloat(value);return Number.isFinite(n)?n:0;}
function measure(){
 queued=false;if(!token)return;var body=document.body,root=document.documentElement;if(!body||!root)return;
 var scrollY=window.scrollY||0,bodyStyle=getComputedStyle(body),height=0;
 // Intrinsic child extents allow a long step to shrink again. Root/body
 // scrollHeight alone is floored by the current iframe viewport and cannot.
 var elements=body.querySelectorAll('*');
 for(var i=0;i<elements.length;i++){
  var el=elements[i];if(!(el instanceof HTMLElement)&&el.tagName.toLowerCase()!=='svg')continue;
  if(/^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT)$/.test(el.tagName))continue;
  var style=getComputedStyle(el);if(style.display==='none'||style.position==='fixed')continue;
  var rect=el.getBoundingClientRect();if(rect.width===0&&rect.height===0)continue;
  height=Math.max(height,rect.bottom+scrollY+number(style.marginBottom));
 }
 // Include direct text nodes and body padding for fragment-only visualizations.
 try{var range=document.createRange();range.selectNodeContents(body);var rect=range.getBoundingClientRect();height=Math.max(height,rect.bottom+scrollY);range.detach();}catch(_){}
 // Body auto-height includes inline line-box descenders that child rects omit.
 // Count that intrinsic extent before using overflow; otherwise inline SVG
 // baselines can alternate between a short viewport and its scrollHeight.
 height=Math.max(height+number(bodyStyle.paddingBottom),body.getBoundingClientRect().bottom+scrollY)+number(bodyStyle.marginBottom);
 var viewport=window.innerHeight||root.clientHeight;
 // Genuine overflow still counts; viewport-sized floors must not prevent shrink.
 if(root.scrollHeight>viewport+2)height=Math.max(height,root.scrollHeight);
 if(body.scrollHeight>viewport+2)height=Math.max(height,body.scrollHeight+number(bodyStyle.marginTop)+number(bodyStyle.marginBottom));
 height=Math.max(1,Math.ceil(height));var width=Math.max(1,root.clientWidth||window.innerWidth||1);
 if(Math.abs(height-lastHeight)<=1&&Math.abs(width-lastWidth)<=1)return;
 lastHeight=height;lastWidth=width;
 window.parent.postMessage({type:kind,token:token,height:height,width:width},'*');
}
function schedule(){if(!queued){queued=true;requestAnimationFrame(measure);}}
var observer;
function start(){
 if(document.body&&typeof ResizeObserver==='function'){observer=new ResizeObserver(schedule);observer.observe(document.body);observer.observe(document.documentElement);}
 if(document.body&&typeof MutationObserver==='function')new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style','class','hidden','open','width','height']});
 schedule();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
window.addEventListener('resize',schedule);document.addEventListener('load',schedule,true);
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(schedule,function(){});
window.addEventListener('message',function(event){if(event.source===window.parent&&event.data&&event.data.type===request&&typeof event.data.token==='string'&&/^[a-zA-Z0-9-]{16,128}$/.test(event.data.token)){token=event.data.token;lastHeight=0;schedule();}});
})();</script>`;
  const closes = [...html.matchAll(/<\/body\s*>/gi)];
  const last = closes.at(-1);
  return last ? html.slice(0, last.index) + script + html.slice(last.index) : html + script;
}
