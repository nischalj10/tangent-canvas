import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceDocument,sourceNodes} from '../src/rich-page-schema.mjs';
import {resolvePagePassage,pagePassageContext} from '../src/page-passage-anchor.mjs';

const block=(id,markdown)=>({id,hash:`hash-${id}`,kind:'markdown',markdown});
const document=blocks=>sourceDocument({title:'Passages',titleHash:'title-hash',blocks});
const base=[block('first','Before **selected text**.\n\nA second paragraph.'),block('next','## Next heading'),block('duplicate','selected text')];
const painted=(doc,passage)=>{const range=resolvePagePassage(doc,passage);assert.ok(range);return doc.textBetween(range.from,range.to,'\n')};

test('Page passage ranges survive source position shifts and formatted text nodes',()=>{
  const doc=document(base),passage={blockId:'first',quote:'selected text'};
  const range=resolvePagePassage(doc,passage);
  assert.equal(painted(doc,{...passage,range}),passage.quote);
  const updated=document([block('inserted','An insertion before the selected source.'),...base]);
  const moved=resolvePagePassage(updated,{...passage,range});
  assert.ok(moved.from>range.from);assert.equal(updated.textBetween(moved.from,moved.to,'\n'),passage.quote);
});

test('Page passages reanchor across paragraphs, canonical source blocks and headings',()=>{
  const quote='text.\nA second paragraph.\nNext heading';
  for(const blocks of [base,[block('inserted','New canonical content'),...base]])assert.equal(painted(document(blocks),{blockId:'first',quote}),quote);
});

test('A stale range cannot highlight matching text in a different canonical source',()=>{
  const doc=document(base),wrong=resolvePagePassage(doc,{blockId:'duplicate',quote:'selected text'});
  const actual=resolvePagePassage(doc,{blockId:'first',quote:'selected text',range:wrong});
  assert.ok(actual.from<wrong.from);
  assert.ok(actual.from<sourceNodes(doc).get('first').offset+sourceNodes(doc).get('first').node.nodeSize);
});

test('Removed or changed source passages clear rather than highlight unrelated text',()=>{
  const doc=document(base);
  for(const passage of [null,{blockId:'missing',quote:'selected text'},{blockId:'first',quote:'not present'},{blockId:'next',quote:'selected text'}])assert.equal(resolvePagePassage(doc,passage),null);
});

test('A repeated phrase retains its selected occurrence after text is inserted in the same source',()=>{
  const doc=document([block('repeated','DNA and DNA')]);
  const start=sourceNodes(doc).get('repeated').offset+2;
  const passage={blockId:'repeated',quote:'DNA',range:{from:start+8,to:start+11}};
  passage.context=pagePassageContext(doc,passage);
  assert.deepEqual(passage.context,{before:'DNA and ',after:''});
  const updated=document([block('repeated','Prefix. DNA and DNA')]);
  assert.deepEqual(resolvePagePassage(updated,passage),{from:start+16,to:start+19});
});
