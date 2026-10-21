import {sourceNodes} from './rich-page-schema.mjs';

export function pagePassageContext(doc, {blockId, range}) {
  const source = sourceNodes(doc).get(blockId);
  if (!source || !range) return null;
  return {
    before: doc.textBetween(source.offset + 1, range.from, '\n').slice(-96),
    after: doc.textBetween(range.to, doc.content.size, '\n').slice(0, 96),
  };
}

// A Page refresh may replace every ProseMirror position. Recover the passage
// from its canonical source block, including selections crossing block borders.
export function resolvePagePassage(doc, passage) {
  if (!passage?.quote) return null;
  const source = sourceNodes(doc).get(passage.blockId);
  if (!source || source.node.attrs.opaque) return null;
  const {quote, range, context} = passage;
  const inSource = from => from > source.offset && from < source.offset + source.node.nodeSize;
  const matches = candidate => candidate && Number.isInteger(candidate.from) && Number.isInteger(candidate.to)
    && candidate.from >= 0 && candidate.to > candidate.from && candidate.to <= doc.content.size
    && inSource(candidate.from) && doc.textBetween(candidate.from, candidate.to, '\n').trim() === quote;
  if (!context && matches(range)) return range;

  const text = [], points = [];
  let first = true;
  doc.nodesBetween(source.offset + 1, doc.content.size, (node, pos) => {
    if (node.isTextblock) {
      if (!first) { text.push('\n'); points.push(pos); }
      first = false;
    }
    if (node.isText) {
      for (let i = 0; i < node.text.length; i++) {
        text.push(node.text[i]); points.push(pos + i);
      }
    }
  });
  const joined = text.join('');
  const candidates = [];
  for (let index = joined.indexOf(quote); index >= 0; index = joined.indexOf(quote, index + 1)) {
    if (!inSource(points[index])) break;
    const candidate = {from: points[index], to: points[index + quote.length - 1] + 1};
    if (matches(candidate)) {
      if (!context) return candidate;
      const current = pagePassageContext(doc, {blockId: passage.blockId, range: candidate});
      const score = (context.before && current.before.endsWith(context.before) ? context.before.length : 0)
        + (context.after && current.after.startsWith(context.after) ? context.after.length : 0);
      candidates.push({range: candidate, score});
    }
  }
  if (candidates.length === 1) return candidates[0].range;
  candidates.sort((a, b) => b.score - a.score);
  // Ambiguous refreshes clear the paint rather than silently move it to a
  // different occurrence. The exact submitted quote remains in the chat.
  return candidates[0]?.score > 0 && candidates[0].score > candidates[1].score ? candidates[0].range : null;
}
