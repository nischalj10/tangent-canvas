import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DocumentAssets } from './documents.mjs';
import {injectPageVisualizationHeightBridge} from './page-visualization-height.mjs';

const pattern=/^[a-f0-9]{64}\.(?:png|jpg|webp|gif|html)$/;
export const pageMediaCsp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: tangent-page-media: https:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

// Some Page figures are fragments that depend on their host's typography,
// controls and color variables. Supply that environment inside the sandbox;
// keep the authenticated source bytes unchanged in the asset archive.
export function visualizationDocument(source){
  if(/<!doctype\s+html|<html(?:\s|>)/i.test(source))return source;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style data-tangent-page-host>
@layer tangent-page-host{
:root{color-scheme:light;--background:#fff;--foreground:#0d0d0d;--muted:#f9f9f9;--muted-foreground:#5d5d5d;--border:#e5e5e5;--card:#fff;--primary:#0d0d0d;--primary-foreground:#fff;--viz-series-1:#176b99;--viz-series-2:#ad6726;--viz-series-3:#6b4da6;--viz-series-4:#25866b;--viz-series-5:#ce4d62;--viz-series-6:#776637}
*{box-sizing:border-box}body{margin:0;padding:20px;background:var(--background);color:var(--foreground);font:15px/1.55 -apple-system,system-ui,"Segoe UI",Helvetica,Arial,sans-serif}h1,h2,h3{line-height:1.25;letter-spacing:-.02em}h1{font-size:26px}h2{font-size:23px}h3{font-size:18px}p{margin:10px 0}a{color:var(--viz-series-1)}hr{border:0;border-top:1px solid var(--border);margin:22px 0}svg{max-width:100%;height:auto}svg text{font-family:inherit}button,input,select,textarea{font:inherit}.text-small{font-size:13px}.text-muted{color:var(--muted-foreground)}.tabular-nums{font-variant-numeric:tabular-nums}.viz-controls{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.btn{appearance:none;cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:7px 13px;background:var(--background);color:var(--foreground);line-height:1.4}.btn:hover{background:var(--muted)}.btn[aria-pressed="true"],.btn[aria-selected="true"]{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}.btn:focus-visible{outline:2px solid var(--muted-foreground);outline-offset:3px}
}
</style></head><body>${source}</body></html>`;
}

// Only authenticated Page-reference bytes enter this content-addressed store.
// HTML is always displayed in an opaque sandbox, with no app preload or bridge.
export class PageMediaStore {
  constructor(directory){
    this.directory=path.join(directory,'page-media');
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    this.images=new DocumentAssets(directory);
  }
  import(resource){
    const mime=(resource.mime||resource.mimeType||'').split(';')[0];
    const bytes=Buffer.isBuffer(resource.bytes)?resource.bytes:typeof resource.base64==='string'?Buffer.from(resource.base64,'base64'):typeof resource.text==='string'?Buffer.from(resource.text,'utf8'):null;
    if(!bytes||!bytes.length||bytes.length>24*1024*1024)throw Error('The Page attachment is empty or exceeds 24 MB.');
    let ext,actualMime;
    if(mime==='text/html'){
      ext='html';actualMime=mime;
      if(bytes.length>4*1024*1024)throw Error('The Page figure exceeds 4 MB.');
    }else{
      const image=this.images.importImage(bytes);
      ext=image.id.split('.').at(-1);actualMime=image.mime;
      if(mime&&mime!==actualMime)throw Error('The Page image format does not match its metadata.');
    }
    const hash=createHash('sha256').update(bytes).digest('hex'),id=`${hash}.${ext}`;
    const file=this.path(id);
    let valid=false;
    try{const stat=fs.lstatSync(file);valid=stat.isFile()&&!stat.isSymbolicLink()&&createHash('sha256').update(fs.readFileSync(file)).digest('hex')===hash}catch{}
    if(!valid){
      const temporary=`${file}.tmp-${process.pid}-${Date.now()}`;
      try{fs.writeFileSync(temporary,bytes,{mode:0o600});fs.renameSync(temporary,file)}finally{fs.rmSync(temporary,{force:true})}
    }
    return{id,url:`tangent-page-media://${id}`,mime:actualMime,kind:ext==='html'?'visualization':'image',bytes:bytes.length};
  }
  path(id){if(!pattern.test(id))throw Error('Invalid Page attachment');return path.join(this.directory,id)}
  response(url){
    try{
      const parsed=new URL(url),id=parsed.hostname;
      if(parsed.protocol!=='tangent-page-media:'||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash||parsed.pathname&&parsed.pathname!=='/')throw Error('Invalid attachment URL');
      const file=this.path(id),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink())throw Error('Missing attachment');
      const bytes=fs.readFileSync(file);
      if(createHash('sha256').update(bytes).digest('hex')!==id.slice(0,64))throw Error('Attachment changed');
      const ext=id.split('.').at(-1),mime=ext==='html'?'text/html; charset=utf-8':ext==='jpg'?'image/jpeg':`image/${ext}`;
      return new Response(ext==='html'?injectPageVisualizationHeightBridge(visualizationDocument(bytes.toString('utf8'))):bytes,{headers:{'Content-Type':mime,'Cache-Control':ext==='html'?'private, no-cache':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','Content-Security-Policy':ext==='html'?pageMediaCsp:"default-src 'none'"}});
    }catch{return new Response('Page attachment not found',{status:404})}
  }
}
