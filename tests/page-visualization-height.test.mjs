import test from 'node:test';
import assert from 'node:assert/strict';
import { injectPageVisualizationHeightBridge, pageVisualizationSource, readPageVisualizationHeight, PAGE_VISUALIZATION_HEIGHT } from '../electron/page-visualization-height.mjs';

test('figure heights accept only the exact child window and navigation token, with finite bounded dimensions',()=>{
 const source={},other={},token='a-random-frame-token';
 const event={source,data:{type:PAGE_VISUALIZATION_HEIGHT,token,height:1234.2,width:760}};
 assert.deepEqual(readPageVisualizationHeight(event,source,token),{height:1235,sourceHeight:1235,width:760,limited:false});
 assert.equal(readPageVisualizationHeight(event,other,token),null);
 assert.equal(readPageVisualizationHeight({...event,source:other},source,token),null);
 assert.equal(readPageVisualizationHeight(event,source,'stale-navigation-token'),null);
 assert.equal(readPageVisualizationHeight(event,null,token),null);
 for(const value of [null,[],{},'1234',{...event.data,type:'app/invoke'},{...event.data,token:''},{...event.data,height:NaN},{...event.data,height:Infinity},{...event.data,height:-1},{...event.data,height:'400'},{...event.data,width:Infinity},{...event.data,width:0}])assert.equal(readPageVisualizationHeight({...event,data:value},source,token),null);
 assert.deepEqual(readPageVisualizationHeight({...event,data:{...event.data,height:500000}},source,token),{height:20000,sourceHeight:500000,width:760,limited:true});
 assert.equal(readPageVisualizationHeight({...event,data:{...event.data,height:12}},source,token).height,80);
});

test('height bridge adds inert source instrumentation to served HTML without altering archived content or exposing an app bridge',()=>{
 const original='<!doctype html><html><head><title>Actual figure</title></head><body><svg viewBox="0 0 10 40"></svg><script>window.step=1</script></body></html>';
 const served=injectPageVisualizationHeightBridge(original);
 assert.ok(served.startsWith('<!doctype html>'));
 assert.ok(served.includes('<svg viewBox="0 0 10 40"></svg><script>window.step=1</script>'));
 assert.equal(served.replace(/<script data-tangent-page-height-bridge>[\s\S]*?<\/script>/,''),original);
 assert.equal(injectPageVisualizationHeightBridge(served),served);
 assert.ok(served.includes('ResizeObserver'));
 assert.ok(served.includes('MutationObserver'));
 assert.ok(served.includes('document.fonts.ready'));
 assert.ok(served.includes('event.source===window.parent'));
 assert.ok(served.includes('window.name'));
 assert.ok(!/window\.tangent|require\(|ipcRenderer|nodeIntegration/.test(served));
 assert.throws(()=>injectPageVisualizationHeightBridge(null),TypeError);
});

test('visualization renderer admits only content-addressed managed HTML, without query paths or external navigation',()=>{
 assert.equal(pageVisualizationSource(`tangent-page-media://${'a'.repeat(64)}.html`),true);
 for(const source of [`https://example.com/figure.html`,`tangent-page-media://${'a'.repeat(64)}.html?token=anything`,`tangent-page-media://${'a'.repeat(64)}.png`,`tangent-page-media://short.html`,`javascript:alert(1)`])assert.equal(pageVisualizationSource(source),false);
});
