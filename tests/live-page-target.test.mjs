import test from 'node:test';
import assert from 'node:assert/strict';
import {requireLivePageUrl} from '../scripts/live-page-target.mjs';

const id='page_ExplicitLiveFixture123456',url=`https://chatgpt.com/space/${id}`;
test('live Page verification requires an explicit operator target',()=>{
  for(const environment of [{},{TANGENT_LIVE_PAGE_URL:' '},{TANGENT_LIVE_PAGE_ID:''}])
    assert.throws(()=>requireLivePageUrl(environment),/Set TANGENT_LIVE_PAGE_URL or TANGENT_LIVE_PAGE_ID/);
});
test('live Page URL and ID inputs resolve to the same canonical Page',()=>{
  assert.equal(requireLivePageUrl({TANGENT_LIVE_PAGE_URL:` ${url}/?source=test#selection `}),url);
  assert.equal(requireLivePageUrl({TANGENT_LIVE_PAGE_ID:` ${id} `}),url);
  assert.equal(requireLivePageUrl({TANGENT_LIVE_PAGE_URL:url,TANGENT_LIVE_PAGE_ID:id}),url);
});
test('live Page verification rejects ambiguous or unsafe targets without echoing their values',()=>{
  assert.throws(()=>requireLivePageUrl({TANGENT_LIVE_PAGE_URL:url,TANGENT_LIVE_PAGE_ID:'page_DifferentFixture123456'}),/same Page/);
  for(const value of ['https://chatgpt.com.evil.test/space/page_example01','https://user:pass@chatgpt.com/space/page_example01','file:///private/page']){
    assert.throws(()=>requireLivePageUrl({TANGENT_LIVE_PAGE_URL:value}),error=>error.message.includes('TANGENT_LIVE_PAGE_URL')&&!error.message.includes(value));
  }
  assert.throws(()=>requireLivePageUrl({TANGENT_LIVE_PAGE_ID:'not-a-page'}),/TANGENT_LIVE_PAGE_ID/);
});
