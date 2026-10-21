import test from 'node:test';
import assert from 'node:assert/strict';
import {zoomActionForInput} from '../electron/zoom-shortcuts.mjs';

test('native Page zoom accepts browser keyboard variants once on key-down',()=>{
  const mac={type:'keyDown',meta:true};
  for(const input of [{key:'=',code:'Equal'},{key:'+',code:'Equal',shift:true},{key:'+',code:'NumpadAdd'},{key:'Add'}])assert.equal(zoomActionForInput({...mac,...input},'darwin'),'zoom-in');
  for(const input of [{key:'-',code:'Minus'},{key:'_',code:'Minus',shift:true},{key:'Subtract',code:'NumpadSubtract'}])assert.equal(zoomActionForInput({...mac,...input},'darwin'),'zoom-out');
  assert.equal(zoomActionForInput({...mac,key:'0',code:'Digit0'},'darwin'),'zoom-reset');
  for(const input of [{type:'keyUp',key:'+'},{key:'+',alt:true},{key:'0',shift:true},{key:'x'},{key:'+',meta:false,control:true}])assert.equal(zoomActionForInput({...mac,...input},'darwin'),null);
  assert.equal(zoomActionForInput({type:'keyDown',key:'-',control:true},'win32'),'zoom-out');
  assert.equal(zoomActionForInput({type:'keyDown',key:'=',meta:true},'linux'),null);
});
