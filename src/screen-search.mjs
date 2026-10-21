import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const markdownKinds = new Set(['message', 'page-block', 'page-comment', 'document']);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Match the text a reader sees, without treating Markdown or a query as HTML.
// Image alt text and link destinations are deliberately absent from the index.
export function searchableText(item) {
  const value = String(item.text ?? '');
  if (item.markdown === false || !markdownKinds.has(item.kind)) return value;
  const inline = tokens => (tokens || []).map(token => {
    if (token.type === 'image') return '';
    if (token.children) return inline(token.children);
    if (token.type === 'text' || token.type === 'code_inline') return token.content;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
    return '';
  }).join('');
  const parts = [];
  for (const token of markdown.parse(value, {})) {
    if (token.type === 'inline') parts.push(inline(token.children));
    else if (token.type === 'fence' || token.type === 'code_block') parts.push(token.content.replace(/\n$/, ''));
  }
  return parts.join('\n\n');
}

export function literalMatches(text, query) {
  const value = String(text ?? ''), needle = String(query ?? '');
  if (!needle) return [];
  const expression = new RegExp(escapeRegExp(needle), 'giu');
  return Array.from(value.matchAll(expression), match => ({ start: match.index, end: match.index + match[0].length }));
}

export function prepareScreenSearchItems(items = []) {
  return items.map(item => ({ ...item, searchText: searchableText(item) }));
}

export function findScreenMatches(items, query) {
  if (!query) return [];
  return (items || []).flatMap((item, itemIndex) => literalMatches(item.searchText ?? searchableText(item), query).map((match, occurrence) => ({
    ...item,
    ...match,
    query,
    occurrence,
    key: `${item.id ?? `${item.nodeId}:${item.kind}:${item.messageId ?? item.blockId ?? itemIndex}`}:${occurrence}`,
  })));
}

// Keep the same occurrence selected while a streaming answer adds text. If that
// occurrence disappeared, retain the nearby position rather than jumping away.
export function activeScreenMatchIndex(matches, key, previousIndex = 0) {
  if (!matches.length) return -1;
  const current = matches.findIndex(match => match.key === key);
  return current >= 0 ? current : Math.min(Math.max(previousIndex, 0), matches.length - 1);
}

export function nextScreenMatchIndex(index, direction, count) {
  return count ? ((index + direction) % count + count) % count : -1;
}
