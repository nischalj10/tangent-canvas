import test from 'node:test';
import assert from 'node:assert/strict';
import { activeScreenMatchIndex, findScreenMatches, literalMatches, nextScreenMatchIndex, prepareScreenSearchItems, searchableText } from '../src/screen-search.mjs';

test('find treats punctuation and expressions as case insensitive literal text', () => {
  assert.deepEqual(literalMatches('DNA (A+G) dna (a+g) [.*]', '(a+g)'), [{ start: 4, end: 9 }, { start: 14, end: 19 }]);
  assert.deepEqual(literalMatches('DNA (A+G) dna (a+g) [.*]', '[.*]'), [{ start: 20, end: 24 }]);
  assert.deepEqual(literalMatches('aaa', 'aa'), [{ start: 0, end: 2 }]);
  assert.deepEqual(literalMatches('anything', ''), []);
});

test('find preserves source offsets for Unicode case folding and UTF-16 text', () => {
  assert.deepEqual(literalMatches('İ i DNA 🧬 dna', 'dna'), [{ start: 4, end: 7 }, { start: 11, end: 14 }]);
  assert.deepEqual(literalMatches('🧬🧬', '🧬'), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test('Markdown index contains visible formatting text without link destinations or image prompts', () => {
  const item = { kind: 'message', text: '### **DNA** and *RNA*\n\n[Source](https://secret.example) ![Long generation prompt](asset.png)\n\n`A+G`\n\n```txt\ncode DNA\n```' };
  assert.equal(searchableText(item), 'DNA and RNA\n\nSource \n\nA+G\n\ncode DNA');
  assert.equal(findScreenMatches([item], 'secret').length, 0);
  assert.equal(findScreenMatches([item], 'generation prompt').length, 0);
  assert.equal(findScreenMatches([item], 'DNA and RNA').length, 1);
});

test('plaintext stays literal and queries cannot create inline HTML', () => {
  assert.equal(searchableText({ kind: 'title', text: '**literal** <script>x</script>' }), '**literal** <script>x</script>');
  assert.equal(searchableText({ kind: 'message', markdown: false, text: 'x ** y' }), 'x ** y');
  assert.equal(findScreenMatches([{ id: 'unsafe', kind: 'note', text: '<img src=x onerror=alert(1)>' }], '<img')[0].start, 0);
});

test('every occurrence keeps navigation identity and card/message metadata', () => {
  const items = prepareScreenSearchItems([
    { id: 'message:m1', nodeId: 'n1', messageId: 'm1', kind: 'message', text: '**DNA** → DNA' },
    { id: 'block:b1', nodeId: 'page', blockId: 'b1', kind: 'page-block', text: 'DNA &amp; RNA' },
  ]);
  const matches = findScreenMatches(items, 'dna');
  assert.deepEqual(matches.map(({ key, nodeId, occurrence, start, end }) => ({ key, nodeId, occurrence, start, end })), [
    { key: 'message:m1:0', nodeId: 'n1', occurrence: 0, start: 0, end: 3 },
    { key: 'message:m1:1', nodeId: 'n1', occurrence: 1, start: 6, end: 9 },
    { key: 'block:b1:0', nodeId: 'page', occurrence: 0, start: 0, end: 3 },
  ]);
  assert.equal(matches[0].messageId, 'm1');
  assert.equal(matches[2].blockId, 'b1');
  assert.equal(matches[2].query, 'dna');
});

test('streaming new occurrences retains active result and navigation wraps both ways', () => {
  const first = findScreenMatches([{ id: 'm', kind: 'message', text: 'DNA DNA' }], 'DNA');
  const streaming = findScreenMatches([{ id: 'm', kind: 'message', text: 'DNA DNA DNA' }], 'DNA');
  assert.equal(activeScreenMatchIndex(streaming, first[1].key), 1);
  assert.equal(activeScreenMatchIndex(first, 'missing', 8), 1);
  assert.equal(activeScreenMatchIndex([], 'missing'), -1);
  assert.equal(nextScreenMatchIndex(2, 1, 3), 0);
  assert.equal(nextScreenMatchIndex(0, -1, 3), 2);
  assert.equal(nextScreenMatchIndex(0, 1, 0), -1);
});
