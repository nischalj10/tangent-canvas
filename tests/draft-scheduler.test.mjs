import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftPersistence,flushPendingDrafts} from '../src/draft-persistence.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve}};
function scheduler(t,options){
  const value=createDraftPersistence(options);
  t.after(()=>value.dispose().catch(()=>{}));
  return value;
}

test('local typing saves only the latest value after the idle interval',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let draft='a';const writes=[];
  const save=scheduler(t,{read:()=>draft,write:async value=>writes.push(value)});
  save.schedule();t.mock.timers.tick(600);await tick();assert.deepEqual(writes,[]);
  draft='ab';save.schedule();t.mock.timers.tick(749);await tick();assert.deepEqual(writes,[]);
  draft='abc';t.mock.timers.tick(1);await tick();assert.deepEqual(writes,['abc']);
  t.mock.timers.tick(10000);await tick();assert.deepEqual(writes,['abc'],'The max-wait timer must be removed after an idle flush');
});

test('continuous input has a bounded checkpoint even when the idle timer keeps resetting',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let draft='0';const writes=[];
  const save=scheduler(t,{read:()=>draft,write:async value=>writes.push(value)});
  save.schedule();
  for(let i=1;i<=3;i++){t.mock.timers.tick(500);draft=String(i);save.schedule();await tick()}
  t.mock.timers.tick(499);await tick();assert.deepEqual(writes,[]);
  t.mock.timers.tick(1);await tick();assert.deepEqual(writes,['3']);
  draft='next window';save.schedule();t.mock.timers.tick(750);await tick();assert.deepEqual(writes,['3','next window']);
});

test('writes serialize and duplicate values are skipped only after the earlier acknowledgement',async t=>{
  let draft='first';const gate=deferred(),writes=[];
  const save=scheduler(t,{read:()=>draft,write:async value=>{writes.push(value);if(value==='first')await gate.promise}});
  const first=save.flush(),duplicate=save.flush();draft='newer';const next=save.flush();
  await tick();assert.deepEqual(writes,['first']);
  gate.resolve();await Promise.all([first,duplicate,next]);assert.deepEqual(writes,['first','newer']);
  await save.flush();assert.deepEqual(writes,['first','newer']);
  await save.flush('');assert.deepEqual(writes,['first','newer',''],'An explicit empty acknowledgement must not fall back to read()');
  draft='';
});

test('a remounted chat cannot save newer text ahead of an old view waiting for its prior acknowledgement',async t=>{
  const gate=deferred(),writes=[];let oldDraft='previous checkpoint';
  const old=scheduler(t,{key:'remounted-card',read:()=>oldDraft,write:async value=>{writes.push(value);if(value==='previous checkpoint')await gate.promise}});
  const previous=old.flush();await tick();
  oldDraft='old view final draft';const disposed=old.dispose();
  const replacement=scheduler(t,{key:'remounted-card',read:()=>'new view later draft',write:async value=>writes.push(value)});
  const newest=replacement.flush();await tick();
  const beforeAcknowledgement=[...writes];
  gate.resolve();await Promise.all([previous,disposed,newest]);
  assert.deepEqual(beforeAcknowledgement,['previous checkpoint'],'The replacement must wait for all earlier writes belonging to the same logical card');
  assert.deepEqual(writes,['previous checkpoint','old view final draft','new view later draft']);
});

test('views of the same chat share acknowledged values so clearing and retyping cannot become stale no-ops',async t=>{
  let firstDraft='',secondDraft='';const writes=[];
  const first=scheduler(t,{key:'shared-card-ack',read:()=>firstDraft,write:async value=>writes.push(value)});
  const second=scheduler(t,{key:'shared-card-ack',read:()=>secondDraft,write:async value=>writes.push(value)});
  firstDraft='changed in first view';await first.flush();
  await second.flush('');assert.deepEqual(writes,['changed in first view',''],'The second view must clear text even though its own initial draft was empty');
  await first.flush();assert.deepEqual(writes,['changed in first view','','changed in first view'],'A value saved before another view cleared it is no longer a duplicate');
  secondDraft=firstDraft;await second.flush();assert.equal(writes.length,3,'Both views must recognize the same latest acknowledgement');
});

test('a forced acknowledgement restores a newer draft after message delivery clears backend state',async t=>{
  let backend='',draft='new text typed while delivery is pending';const writes=[];
  const save=scheduler(t,{key:'force-after-delivery',read:()=>draft,write:async value=>{writes.push(value);backend=value}});
  await save.flush();assert.equal(backend,draft);
  backend=''; // A held node/send now starts and clears the server-side draft.
  await save.flush();assert.equal(writes.length,1,'Ordinary checkpoints still skip acknowledged duplicates');
  await save.flush(draft,{force:true});assert.equal(backend,draft);assert.equal(writes.length,2);
  await save.flush();assert.equal(writes.length,2,'The forced receipt becomes the latest acknowledged value');
});

test('a forced empty draft cannot be skipped because an earlier empty value was acknowledged',async t=>{
  let backend='externally retained old message';const writes=[];
  const save=scheduler(t,{initial:'',read:()=>'',write:async value=>{writes.push(value);backend=value}});
  await save.flush('',{force:true});assert.equal(backend,'');assert.deepEqual(writes,['']);
  await save.flush('');assert.deepEqual(writes,['']);
});

test('forced checkpoints still await earlier keyed acknowledgements and issue their own write',async t=>{
  const gate=deferred(),writes=[];
  const first=scheduler(t,{key:'forced-serialized-receipt',read:()=>'same text',write:async value=>{writes.push(value);await gate.promise}});
  const second=scheduler(t,{key:'forced-serialized-receipt',read:()=>'same text',write:async value=>writes.push(value)});
  const previous=first.flush(),forced=second.flush('same text',{force:true});await tick();
  const beforeAcknowledgement=[...writes];gate.resolve();await Promise.all([previous,forced]);
  assert.deepEqual(beforeAcknowledgement,['same text']);assert.deepEqual(writes,['same text','same text']);
});

test('shutdown restores the current draft even when another command cleared its acknowledged backend value',async t=>{
  let backend='';const writes=[];
  const save=scheduler(t,{read:()=>'retained during an asynchronous message',write:async value=>{writes.push(value);backend=value}});
  await save.flush();backend='';await flushPendingDrafts();
  assert.equal(backend,'retained during an asynchronous message');assert.equal(writes.length,2);
});

test('a later disposed view reads the shared newest draft and cannot replay its old text',async t=>{
  const gate=deferred(),writes=[];let sharedDraft='initial';
  const first=scheduler(t,{key:'shared-latest-read',read:()=>sharedDraft,write:async value=>{writes.push(value);if(value==='initial')await gate.promise}});
  const older=first.flush();await tick();sharedDraft='latest in replacement';
  const replacement=scheduler(t,{key:'shared-latest-read',read:()=>sharedDraft,write:async value=>writes.push(value)});
  const latest=replacement.flush(),disposed=first.dispose();
  gate.resolve();await Promise.all([older,latest,disposed]);assert.deepEqual(writes,['initial','latest in replacement']);
});

test('different chat keys stay independent while one write is awaiting acknowledgement',async t=>{
  const gate=deferred(),writes=[];
  const slow=scheduler(t,{key:'independent-slow',read:()=>'slow',write:async value=>{writes.push(value);await gate.promise}});
  const fast=scheduler(t,{key:'independent-fast',read:()=>'fast',write:async value=>writes.push(value)});
  const pending=slow.flush();await fast.flush();const beforeAcknowledgement=[...writes];gate.resolve();await pending;assert.deepEqual(beforeAcknowledgement,['slow','fast']);
});

test('a fully disposed chat releases its shared acknowledgement before a fresh lifecycle reuses that key',async t=>{
  const writes=[];
  const first=scheduler(t,{key:'released-card',initial:'earlier lifecycle',read:()=>'earlier lifecycle',write:async value=>writes.push(value)});
  await first.dispose();await tick();
  const replacement=scheduler(t,{key:'released-card',initial:'fresh durable baseline',read:()=>'fresh durable baseline',write:async value=>writes.push(value)});
  await replacement.flush();assert.deepEqual(writes,[]);
});

test('a rejected checkpoint remains retryable and cannot poison the serialized write queue',async t=>{
  let attempts=0;const errors=[];
  const save=scheduler(t,{read:()=>'retry exact text',write:async()=>{if(++attempts===1)throw Error('Fixture unavailable')},onError:error=>errors.push(error.message)});
  await assert.rejects(save.flush(),/Fixture unavailable/);assert.equal(attempts,1);
  await save.flush();await save.flush();assert.equal(attempts,2);assert.deepEqual(errors,['Fixture unavailable']);
});

test('a send acknowledgement clears a draft after an older checkpoint finishes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let draft='question being delivered';const gate=deferred(),writes=[];
  const save=scheduler(t,{read:()=>draft,write:async value=>{writes.push(value);if(value)await gate.promise}});
  save.schedule();t.mock.timers.tick(750);await tick();
  draft='';save.cancel();const accepted=save.flush('');
  gate.resolve();await accepted;t.mock.timers.tick(10000);await tick();
  assert.deepEqual(writes,['question being delivered',''],'An older checkpoint must never repopulate an accepted message');
});

test('timer failures are handled, reported once, and retried on later input',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let attempts=0;const errors=[];
  const save=scheduler(t,{read:()=>'timer retry',write:async()=>{if(++attempts===1)throw Error('Timer checkpoint failed')},onError:error=>errors.push(error.message)});
  save.schedule();t.mock.timers.tick(750);await tick();assert.deepEqual(errors,['Timer checkpoint failed']);
  save.schedule();t.mock.timers.tick(750);await tick();assert.equal(attempts,2);
});

test('cancel removes both pending timers while explicit flush still saves the latest read value',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let draft='old';const writes=[];
  const save=scheduler(t,{read:()=>draft,write:async value=>writes.push(value)});
  save.schedule();save.cancel();t.mock.timers.tick(10000);await tick();assert.deepEqual(writes,[]);
  draft='captured on flush';await save.flush();assert.deepEqual(writes,['captured on flush']);
});

test('dispose saves the final draft, clears timers, and shutdown waits for disposed in-flight work',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let draft='final unmounted text';const gate=deferred(),writes=[];
  const save=scheduler(t,{read:()=>draft,write:async value=>{writes.push(value);await gate.promise}});
  save.schedule();const disposed=save.dispose();
  let shutdownFinished=false;const shutdown=flushPendingDrafts().then(()=>{shutdownFinished=true});
  await tick();assert.deepEqual(writes,['final unmounted text']);assert.equal(shutdownFinished,false);
  gate.resolve();await Promise.all([disposed,shutdown]);
  draft='must not reschedule';save.schedule();t.mock.timers.tick(10000);await tick();assert.equal(writes.length,2,'Shutdown forces its own final receipt; disposal must leave no timers behind');
  draft='final unmounted text';
});

test('a failed final disposal remains registered so shutdown can retry its unsaved text',async t=>{
  let attempts=0;const errors=[];
  const save=scheduler(t,{read:()=>'retain after disposal',write:async()=>{if(++attempts===1)throw Error('Temporary final-save failure')},onError:error=>errors.push(error.message)});
  await assert.rejects(save.dispose(),/Temporary final-save failure/);
  await flushPendingDrafts();assert.equal(attempts,2);assert.deepEqual(errors,['Temporary final-save failure']);
  await flushPendingDrafts();assert.equal(attempts,2);
});

test('shutdown settles all drafts before reporting any failed write',async t=>{
  let attempts=0;const gate=deferred(),writes=[];
  scheduler(t,{read:()=>'fails once',write:async()=>{if(++attempts===1)throw Error('One shutdown save failed')}});
  scheduler(t,{read:()=>'takes longer',write:async value=>{writes.push(value);await gate.promise}});
  let settled=false;const result=flushPendingDrafts().then(()=>{settled=true;return null},error=>{settled=true;return error});
  await tick();assert.deepEqual(writes,['takes longer']);assert.equal(settled,false);
  gate.resolve();const error=await result;assert.ok(error instanceof AggregateError);assert.match(error.errors[0].message,/One shutdown save failed/);
  await flushPendingDrafts();assert.equal(attempts,2);
});

test('shutdown also flushes a composer registered while another save was awaiting acknowledgement',async t=>{
  const gate=deferred(),writes=[];
  scheduler(t,{read:()=>'earlier view',write:async value=>{writes.push(value);await gate.promise}});
  const shutdown=flushPendingDrafts();await tick();
  scheduler(t,{read:()=>'newly mounted view',write:async value=>writes.push(value)});
  gate.resolve();await shutdown;
  assert.deepEqual(writes,['earlier view','newly mounted view']);
});

test('read failures and failing error presenters do not create unhandled timer rejections',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let broken=true;const errors=[],writes=[];
  const save=scheduler(t,{read:()=>{if(broken)throw Error('Draft read failed');return 'recovered'},write:async value=>writes.push(value),onError:error=>{errors.push(error.message);throw Error('An error presenter also failed')}});
  save.schedule();t.mock.timers.tick(750);await tick();assert.deepEqual(errors,['Draft read failed']);
  broken=false;await save.flush();assert.deepEqual(writes,['recovered']);
});
