import {canonicalPageUrl} from '../electron/pages.mjs';

// Live verification must target a Page deliberately supplied by its operator.
// Never publish or silently fall back to a developer's private Page.
export function requireLivePageUrl(environment=process.env){
  const url=environment.TANGENT_LIVE_PAGE_URL?.trim();
  const id=environment.TANGENT_LIVE_PAGE_ID?.trim();
  if(!url&&!id)throw Error('Set TANGENT_LIVE_PAGE_URL or TANGENT_LIVE_PAGE_ID before running live Page verification.');
  const canonical=(value,name)=>{
    try{return canonicalPageUrl(value)}catch{throw Error(`${name} must identify a ChatGPT Page at https://chatgpt.com/space/page_…`)}
  };
  const fromUrl=url?canonical(url,'TANGENT_LIVE_PAGE_URL'):null;
  const fromId=id?canonical(`https://chatgpt.com/space/${id}`,'TANGENT_LIVE_PAGE_ID'):null;
  if(fromUrl&&fromId&&fromUrl!==fromId)throw Error('TANGENT_LIVE_PAGE_URL and TANGENT_LIVE_PAGE_ID must identify the same Page.');
  return fromUrl||fromId;
}
