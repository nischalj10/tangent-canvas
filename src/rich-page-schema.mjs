import {Schema, Fragment} from 'prosemirror-model';
import {schema as markdownSchema, MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer} from 'prosemirror-markdown';
import {tableNodes} from 'prosemirror-tables';
import MarkdownIt from 'markdown-it';

export const safeLink=value=>/^(?:https?:|mailto:)/i.test(String(value||''));
const sourceSpec={
  content:'block*',defining:true,isolating:true,
  attrs:{sourceId:{default:''},sourceHash:{default:''},opaque:{default:false},markdown:{default:''},kind:{default:'markdown'}},
  parseDOM:[{tag:'section[data-page-block-id]',getAttrs:dom=>({sourceId:dom.dataset.pageBlockId,sourceHash:dom.dataset.blockHash||''})}],
  toDOM:node=>['section',{'data-page-block-id':node.attrs.sourceId},0],
};
let nodes=markdownSchema.spec.nodes.addBefore('paragraph','source_block',sourceSpec);
nodes=nodes.addBefore('source_block','page_title',{content:'text*',marks:'',defining:true,isolating:true,attrs:{sourceId:{default:'__title__'},sourceHash:{default:''}},toDOM:()=>['h1',{class:'page-document-title'},0]});
for(const[name,spec]of Object.entries(tableNodes({tableGroup:'block',cellContent:'block+'})))nodes=nodes.addToEnd(name,spec);
nodes=nodes.update('image',{...nodes.get('image'),parseDOM:[{tag:'img[src]',getAttrs:dom=>safeLink(dom.getAttribute('src'))?{src:dom.getAttribute('src'),alt:dom.getAttribute('alt'),title:dom.getAttribute('title')}:false}]});
const marks=markdownSchema.spec.marks
  .update('link',{...markdownSchema.spec.marks.get('link'),parseDOM:[{tag:'a[href]',getAttrs:dom=>safeLink(dom.getAttribute('href'))?{href:dom.getAttribute('href'),title:dom.getAttribute('title')}:false}]})
  .addToEnd('underline',{parseDOM:[{tag:'u'},{style:'text-decoration=underline'},{style:'text-decoration-line=underline'}],toDOM:()=>['u',0]})
  .addToEnd('strike',{parseDOM:[{tag:'s'},{tag:'del'},{style:'text-decoration=line-through'}],toDOM:()=>['s',0]});
export const richContentSchema=new Schema({nodes,marks});
export const pageEditorSchema=new Schema({nodes:nodes.update('doc',{content:'page_title source_block+'}),marks});

const tokenizer=new MarkdownIt('commonmark',{html:true,linkify:false}).enable(['table','strikethrough']);
tokenizer.core.ruler.after('inline','page-table-paragraphs',state=>{
  const out=[];
  for(const token of state.tokens){
    if(token.type==='th_close'||token.type==='td_close')out.push(new state.Token('paragraph_close','p',-1));
    out.push(token);
    if(token.type==='th_open'||token.type==='td_open')out.push(new state.Token('paragraph_open','p',1));
  }
  state.tokens=out;
});
export const richMarkdownParser=new MarkdownParser(richContentSchema,tokenizer,{
  ...defaultMarkdownParser.tokens,
  table:{block:'table'},thead:{ignore:true},tbody:{ignore:true},tr:{block:'table_row'},
  th:{block:'table_header'},td:{block:'table_cell'},s:{mark:'strike'},
  html_inline:{ignore:true},html_block:{ignore:true},
});
richMarkdownParser.tokenHandlers.html_inline=(state,token)=>{
  if(/^<u\s*>$/i.test(token.content))state.openMark(richContentSchema.marks.underline.create());
  else if(/^<\/u\s*>$/i.test(token.content))state.closeMark(richContentSchema.marks.underline);
  else if(/^<br\s*\/?>$/i.test(token.content))state.addNode(richContentSchema.nodes.hard_break,null);
  else state.addText(token.content);
};
richMarkdownParser.tokenHandlers.html_block=(state,token)=>state.addNode(richContentSchema.nodes.paragraph,null,[richContentSchema.text(token.content)]);

const tableCellMarkdown=cell=>richMarkdownSerializer.serialize(cell).trim().replace(/\n\n/g,'<br>').replace(/\n/g,'<br>').replace(/(?<!\\)\|/g,'\\|');
export const richMarkdownSerializer=new MarkdownSerializer({
  ...defaultMarkdownSerializer.nodes,
  source_block(state,node){state.renderContent(node);state.closeBlock(node)},
  table(state,node){
    const rows=[];node.forEach(row=>{const cells=[];row.forEach(cell=>cells.push(tableCellMarkdown(cell)));rows.push(cells)});
    if(!rows.length)return;
    const count=Math.max(...rows.map(row=>row.length));
    const line=row=>'| '+Array.from({length:count},(_,i)=>row[i]||'').join(' | ')+' |';
    state.write(line(rows[0])+'\n'+line(Array(count).fill('---')));
    for(const row of rows.slice(1))state.write('\n'+line(row));
    state.closeBlock(node);
  },
  table_row(state,node){state.renderContent(node)},table_cell(state,node){state.renderContent(node)},table_header(state,node){state.renderContent(node)},
},{...defaultMarkdownSerializer.marks,
  underline:{open:'<u>',close:'</u>',mixable:true,expelEnclosingWhitespace:true},
  strike:{open:'~~',close:'~~',mixable:true,expelEnclosingWhitespace:true},
});

export function blockIsOpaque(block){
  // Attachment and application-specific source blocks retain their original
  // renderer/identity. Editing another paragraph never converts them to text.
  if(block.kind&&block.kind!=='markdown')return true;
  const markdown=String(block.markdown||'');
  return /!\[[\s\S]*?\]\(|(?:visualize|library-file|project-file)\\?:/.test(markdown)||/<(?!\/?u\s*>|br\s*\/?>)[A-Za-z][^>]*>/.test(markdown);
}
export function parseSourceBlock(block,draft){
  const opaque=blockIsOpaque(block),markdown=draft?.markdown??block.markdown;
  let content;
  if(!opaque){
    try{content=draft?.editorJSON?richContentSchema.nodeFromJSON(draft.editorJSON).content:richMarkdownParser.parse(markdown).content}
    catch{content=richMarkdownParser.parse(markdown).content}
    if(!content?.size)content=Fragment.from(richContentSchema.nodes.paragraph.create());
    content=Fragment.fromArray([...content.content].map(node=>pageEditorSchema.nodeFromJSON(node.toJSON())));
  }
  return pageEditorSchema.nodes.source_block.create({sourceId:block.id,sourceHash:block.hash,opaque,markdown:block.markdown,kind:block.kind||'markdown'},content);
}
export function sourceDocument(snapshot,drafts={}){
  const blocks=snapshot.blocks.map(block=>parseSourceBlock(block,drafts[block.id]));
  const titleText=drafts.__title__?.markdown??snapshot.title??'Untitled Page';
  const title=pageEditorSchema.nodes.page_title.create({sourceHash:snapshot.titleHash||''},titleText?pageEditorSchema.text(titleText):null);
  return pageEditorSchema.nodes.doc.create(null,[title,...(blocks.length?blocks:[pageEditorSchema.nodes.source_block.create({sourceId:'empty'},pageEditorSchema.nodes.paragraph.create())])]);
}
export function sourceNodes(doc){const nodes=new Map();doc.forEach((node,offset)=>nodes.set(node.attrs.sourceId,{node,offset}));return nodes}
export function serializeSourceNode(node){return node.type.name==='page_title'?node.textContent:richMarkdownSerializer.serialize(node).trimEnd()}
export function sourceEditorJSON(node){return{type:'doc',content:node.content.toJSON()||[{type:'paragraph'}]}}
