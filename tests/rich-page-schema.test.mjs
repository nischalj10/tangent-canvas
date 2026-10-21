import test from 'node:test';
import assert from 'node:assert/strict';
import{richMarkdownParser,richMarkdownSerializer,sourceDocument,parseSourceBlock,serializeSourceNode,blockIsOpaque,safeLink}from'../src/rich-page-schema.mjs';

test('rich Page marks, nested lists and table cells survive serialization without rewriting source metadata',()=>{
  const markdown='## A heading\n\n**bold** *italic* <u>underlined</u> ~~removed~~ `code` [link](https://example.com)\n\n* One\n  * Nested\n\n| Name | Value |\n| --- | --- |\n| DNA | **A** |';
  const parsed=richMarkdownParser.parse(markdown),serialized=richMarkdownSerializer.serialize(parsed);
  assert.deepEqual(richMarkdownParser.parse(serialized).toJSON(),parsed.toJSON());
  const source={id:'canonical-id',hash:'original-hash',kind:'markdown',markdown,metadata:{keep:'original'}};
  const node=parseSourceBlock(source);assert.equal(node.attrs.sourceId,source.id);assert.equal(node.attrs.sourceHash,source.hash);assert.deepEqual(source.metadata,{keep:'original'});assert.match(serializeSourceNode(node),/<u>underlined<\/u>/);
});

test('empty editable title and empty paragraph remain valid editor documents',()=>{
  const doc=sourceDocument({title:'',titleHash:'title-hash',blocks:[{id:'empty-block',hash:'empty-hash',kind:'markdown',markdown:''}]});
  assert.equal(doc.firstChild.textContent,'');assert.equal(doc.lastChild.firstChild.type.name,'paragraph');doc.check();
});

test('original media stays opaque and dangerous link schemes never become active rich links',()=>{
  for(const markdown of ['![Image](library-file:file_1)','[Figure](visualize:abc)','<iframe src="https://example.com"></iframe>'])assert.equal(blockIsOpaque({kind:'markdown',markdown}),true);
  assert.equal(blockIsOpaque({kind:'markdown',markdown:'Text with <u>underline</u> and **bold**.'}),false);
  for(const value of ['javascript:alert(1)','data:text/html,abc','file:///private/data'])assert.equal(safeLink(value),false);
  for(const value of ['https://example.com','http://localhost','mailto:test@example.com'])assert.equal(safeLink(value),true);
});
