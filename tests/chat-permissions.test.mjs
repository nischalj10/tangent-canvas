import test from 'node:test';
import assert from 'node:assert/strict';
import {permissionMode,chatPermissionOptions} from '../electron/chat-permissions.mjs';
import {freshState,validateState} from '../electron/store.mjs';
test('permission defaults are explicit full access and unsupported modes fail closed',()=>{
  assert.equal(permissionMode(),'full');
  assert.deepEqual(chatPermissionOptions(),{sandbox:'danger-full-access',sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never',approvalsReviewer:'user'});
  assert.deepEqual(chatPermissionOptions('ask'),{sandbox:'read-only',sandboxPolicy:{type:'readOnly',networkAccess:false},approvalPolicy:'on-request',approvalsReviewer:'user'});
  assert.equal(chatPermissionOptions('auto').approvalsReviewer,'auto_review');
  assert.throws(()=>permissionMode('always-approve'),/permission mode/);
});
test('state migration preserves explicit choices and applies the requested default to legacy chats',()=>{
  const state=freshState(),board=state.boards[0];
  board.nodes=['full','ask','auto',undefined].map((mode,i)=>({id:`chat-${i}`,kind:'chat',messages:[],position:{x:i*10,y:0},...(mode?{permissionMode:mode}:{})}));
  validateState(state);assert.deepEqual(board.nodes.map(node=>node.permissionMode),['full','ask','auto','full']);
  board.nodes[0].permissionMode='bad';assert.throws(()=>validateState(state),/permission mode/);
});
