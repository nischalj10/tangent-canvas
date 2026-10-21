import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {createDraftPersistence} from "./draft-persistence.mjs";
import CanvasResizeControls from "./CanvasResizeControls.jsx";
import PageRichEditor from "./PageRichEditor.jsx";
import PermissionChooser from "./PermissionChooser.jsx";
import ModelEffortChooser from "./ModelEffortChooser.jsx";
import {usePageDiscussionWidth} from "./PageDiscussionResize.jsx";
import CardSummary from "./CardSummary.jsx";
import PageVisualization from "./PageVisualization.jsx";
import { layoutBounds, useMotionPresence } from "./motion.mjs";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUpRight,
  ArrowLeft,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
  Square,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Globe,
  List,
  LoaderCircle,
  MessageCircle,
  MessageSquareText,
  Pencil,
  RotateCw,
  X,
} from "lucide-react";

const cleanReference = (value) => String(value || "").replace(/\\:/g, ":");
const shortText = (value) =>
  String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`]/g, "")
    .trim();
const PAGE_ZOOM_STEPS = [50,67,75,80,90,100,110,125,150,175,200];
const validPageZoom = value => Number.isInteger(value) ? Math.min(200,Math.max(50,value)) : 100;
const isBusy = (node) =>
  ["starting", "running", "awaiting-approval"].includes(node?.status);
const mediaSafe = (url) =>
  /^tangent-page-media:\/\/[a-f0-9]{64}\.[a-z0-9]+$/i.test(url || "");

function PageMarkdown({ markdown, media, invoke, dimensions }) {
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  const entries = Array.isArray(media)
    ? media
    : Object.entries(media || {}).map(([reference, entry]) => ({
        reference,
        ...entry,
      }));
  const signature = JSON.stringify(
    entries.map(({ reference, url, mime, kind }) => ({
      reference: cleanReference(reference),
      url,
      mime,
      kind,
    })),
  );
  const dimensionKey = JSON.stringify({
    width: Number(dimensions?.width) || undefined,
    height: Number(dimensions?.height) || undefined,
  });
  const rendering = useMemo(() => {
    const imageDimensions = JSON.parse(dimensionKey);
    const assets = new Map(
      JSON.parse(signature).flatMap((entry) => [
        [entry.reference, entry],
        [entry.url, entry],
      ]),
    );
    const assetFor = (url) => assets.get(cleanReference(url));
    const isVisualization = (asset) =>
      asset?.kind === "visualization" || asset?.mime?.startsWith("text/html");
    const renderMedia = (source, alt) => {
      const asset = assetFor(source);
      if (mediaSafe(asset?.url) && isVisualization(asset))
        return (
          <figure
            className="page-visualization"
            data-testid="page-visualization"
          >
            <PageVisualization
              src={asset.url}
              title={alt || "Original Page visualization"}
            />
          </figure>
        );
      if (mediaSafe(asset?.url))
        return (
          <figure className="page-source-image" data-testid="page-source-image">
            <img
              src={asset.url}
              alt={alt || "Image from the original Page"}
              width={imageDimensions.width}
              height={imageDimensions.height}
              loading="lazy"
            />
            {alt && !/^(?:Image from the original Page|Original Page image|Page image|Image)$/i.test(alt) && <figcaption>{alt}</figcaption>}
          </figure>
        );
      if (/^https:\/\//.test(source || ""))
        return (
          <figure className="page-source-image">
            <img
              src={source}
              alt={alt || "Page image"}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
            {alt && <figcaption>{alt}</figcaption>}
          </figure>
        );
      return (
        <span className="page-unavailable-media">
          <FileText size={15} />
          <span>
            {alt || "Source image"}
            <small>This reference is unavailable in the original Page.</small>
          </span>
        </span>
      );
    };
    return {
      urlTransform: (url) =>
        assetFor(url)
          ? cleanReference(url)
          : mediaSafe(url)
            ? url
            : /^(?:visualize|library-file|project-file):/.test(
                  cleanReference(url),
                )
              ? cleanReference(url)
              : defaultUrlTransform(url),
      components: {
        img: ({ src, alt }) => renderMedia(src, alt),
        p: ({ children, node }) =>
          node.children?.some(
            (child) =>
              child.tagName === "img" ||
              (child.tagName === "a" &&
                isVisualization(assetFor(child.properties?.href))),
          ) ? (
            <div className="page-media-paragraph">{children}</div>
          ) : (
            <p>{children}</p>
          ),
        a: ({ href, children }) => {
          if (isVisualization(assetFor(href)))
            return renderMedia(
              href,
              typeof children === "string"
                ? children
                : "Original Page visualization",
            );
          return (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (/^https?:\/\//i.test(href || ""))
                  invokeRef.current("app/open-external", { url: href });
              }}
            >
              {children}
              {/^https:\/\//.test(href || "") && (
                <ExternalLink size={10} className="inline-link-icon" />
              )}
            </a>
          );
        },
        table: ({ children }) => (
          <div className="page-table-scroll nowheel">
            <table>{children}</table>
          </div>
        ),
        pre: ({ children }) => (
          <pre className="page-code-block nowheel">{children}</pre>
        ),
      },
    };
  }, [signature, dimensionKey]);
  return useMemo(() => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={rendering.urlTransform}
      components={rendering.components}
    >
      {String(markdown || "").replace(/\\:/g, ":")}
    </ReactMarkdown>
  ), [markdown, rendering]);
}

const commentName = (message) => message.authorType === "agent" || message.agent_kind === "chatgpt" ? "ChatGPT" : message.author?.displayName && !message.author.displayName.startsWith("user-") ? message.author.displayName : "Page reader";
const commentTime = (value) => {
  const date = new Date(value); if (!value || Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, (Date.now()-date.getTime())/1000);
  return seconds < 60 ? "Now" : seconds < 3600 ? `${Math.floor(seconds/60)}m` : seconds < 86400 ? `${Math.floor(seconds/3600)}h` : `${Math.floor(seconds/86400)}d`;
};
function SourceCommentThread({ thread, onAnchor, onDiscuss, invoke, selected, onSelect }) {
  const [expanded, setExpanded] = useState(false);
  const messages = (thread.messages || []).filter(message=>!message.deletedAt && message.body);
  const quote = thread.selectionContext?.text || thread.quote || "";
  const blockId = thread.selectionContext?.start?.blockId || thread.target?.anchor?.blockId || thread.target?.blockId || thread.blockId;
  return <article data-page-comment-id={thread.id} className={`original-comment ${selected ? "is-selected" : ""} ${thread.state === "resolved" ? "resolved" : ""}`} onClick={()=>onSelect(thread.id)}>
    {quote && <button className="original-comment-anchor" onClick={()=>{onSelect(thread.id);onAnchor(blockId)}}>{shortText(quote).slice(0,230)}{quote.length>230 ? "…" : ""}</button>}
    {messages.map((message,index)=><React.Fragment key={message.id}>
      {index === messages.length-1 && messages.length>2 && !expanded && <button className="original-comment-expand" onClick={()=>setExpanded(true)}>Show {messages.length-2} {messages.length-2 === 1 ? "reply" : "replies"}</button>}
      <div data-page-comment-message-id={message.id} className={`original-comment-message ${index < messages.length-1 ? "has-reply" : ""}`} hidden={!expanded && index>0 && index<messages.length-1}>
        <span className={`original-comment-avatar ${commentName(message) === "ChatGPT" ? "is-agent" : ""}`} aria-hidden="true">{commentName(message) === "ChatGPT" ? "C" : commentName(message).slice(0,1)}</span>
        <div className="original-comment-message-content"><div className="original-comment-author"><strong>{commentName(message)}</strong><time dateTime={message.createdAt} title={message.createdAt ? new Date(message.createdAt).toLocaleString() : ""}>{commentTime(message.createdAt)}</time></div><div className={`original-comment-body ${selected || expanded ? "is-expanded" : ""} ${messages.length === 1 ? "single-message" : ""}`}><PageMarkdown markdown={message.body} media={[]} invoke={invoke}/></div></div>
      </div>
    </React.Fragment>)}
    <footer>{thread.state === "resolved" && <span><Check size={11}/>Resolved</span>}{onDiscuss && <button onClick={event=>onDiscuss(event,{id:blockId,markdown:quote || messages[0]?.body || ""})}><MessageCircle size={12}/>Ask Codex</button>}</footer>
  </article>;
}
function PageComments({ threads, onAnchor, onDiscuss, invoke, unavailable, active = true }) {
  const [selectedId,setSelectedId] = useState(null);
  if (!threads.length) return <div className="page-comments-empty"><MessageCircle size={24} strokeWidth={1.2}/><h4>{unavailable ? "Comments are unavailable." : "No comments yet."}</h4><p>{unavailable ? "Refresh to try again." : "Select a passage to discuss it with Codex."}</p></div>;
  return <div className="original-page-comments" data-testid={active ? "original-page-comments" : undefined}>{threads.map(thread=><SourceCommentThread key={thread.id} thread={thread} onAnchor={onAnchor} onDiscuss={onDiscuss} invoke={invoke} selected={selectedId === thread.id} onSelect={setSelectedId}/>)}</div>;
}

export default function RichPageNode({
  data,
  selected,
  canvas,
  ui,
  BrowserPage,
}) {
  const { node } = data;
  const { board, invoke, update, setSelection, selection, connection, focusPageId, openPage, closePage, sidebar, setSidebar, resizeStart, resizeEnd } = canvas;
  const focused = focusPageId === node.id;
  const pageView = node.pageView === "full" ? "full" : "half";
  const [readingZoom,setReadingZoom] = useState(validPageZoom(node.pageZoom));
  const zoomRef = useRef(validPageZoom(node.pageZoom));
  const confirmedZoom = useRef(validPageZoom(node.pageZoom));
  const zoomPending = useRef(0);
  const zoomSequence = useRef(0);
  const viewWrites = useRef(Promise.resolve());
  const pageSelection = selection?.nativePage && selection.pageNodeId === node.id && selection.action !== "side-chat" ? selection : null;
  const {
    CanvasHandles,
    IconButton,
    EditableTitle,
    Message,
    Approval,
    Question,
    QueuePanel,
  } = ui;
  const [browser, setBrowser] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("document");
  const [showContents, setShowContents] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [outlineHover, setOutlineHover] = useState(false);
  const [outlineFocus, setOutlineFocus] = useState(false);
  const optionsMotion = useMotionPresence(focused && optionsOpen, { origin: "top left" });
  const outlineMotion = useMotionPresence(focused && (showContents || outlineHover || outlineFocus), { origin: "left center" });
  const readerMotion = useMotionPresence(focused, { kind: "reader" });
  useLayoutEffect(() => {
    canvas.reportReaderPresence?.(node.id, !!readerMotion.value);
    return () => canvas.reportReaderPresence?.(node.id, false);
  }, [node.id, !!readerMotion.value, canvas.reportReaderPresence]);
  const [toolbarSlot, setToolbarSlot] = useState(null);
  const [toolbarWidth, setToolbarWidth] = useState(null);
  const readerShell = useRef(null);
  const optionsRef = useRef(null);
  const [question, setQuestion] = useState(node.draft || "");
  const [quoteDraft, setQuoteDraft] = useState(null);
  const [documentQuote, setDocumentQuote] = useState(null);
  const activeQuote = pageSelection || quoteDraft;
  const [sending, setSending] = useState(false);
  const [newPermissionMode,setNewPermissionMode] = useState("full");
  const [showDiscussion, setShowDiscussion] = useState(false);
  const [commentBlock, setCommentBlock] = useState(null);
  const [pendingAnchor, setPendingAnchor] = useState(null);
  const attempted = useRef(null);
  const scroller = useRef(null);
  const answerScroller = useRef(null);
  const questionRef = useRef(node.draft || "");
  const questionRevision = useRef(0);
  const draftPersistence = useRef(null);
  const questionInput = useRef(null);
  const [activeHeading, setActiveHeading] = useState(null);
  const snapshot = node.pageSnapshot;
  const pageSyncing = syncing || node.pageSyncStatus === "loading";
  const blocks = snapshot?.blocks || [];
  const chats = board.nodes.filter(
    (item) => ["chat", "comment"].includes(item.kind) && !item.archived,
  );
  const [targetId,setTargetId] = useState(node.targetChatId || null);
  useEffect(()=>setTargetId(node.targetChatId||null),[node.targetChatId]);
  const target = chats.find((item) => item.id === targetId);
  const threads = Array.isArray(snapshot?.comments)
    ? snapshot.comments
    : snapshot?.comments?.threads || [];
  const headings = useMemo(
    () =>
      blocks.flatMap((block) => {
        const match = block.markdown?.match(/^\s*(#{1,3})\s+(.+)/m);
        return match
          ? [
              {
                blockId: block.id,
                level: match[1].length,
                text: shortText(match[2]),
              },
            ]
          : [];
      }),
    [blocks],
  );
  const persistViewSettings = (fields) => {
    const task = viewWrites.current.catch(()=>{}).then(()=>window.tangent.invoke("page/settings",{boardId:board.id,nodeId:node.id,...fields}));
    viewWrites.current = task;
    return task;
  };
  const discussionSize=usePageDiscussionWidth({shell:readerShell,focused,visible:showDiscussion,mode:pageView,sidebar,value:node.pageDiscussionWidth,onSave:persistViewSettings,onError:setError});
  const changeZoom = (value) => {
    const next = validPageZoom(value), sequence = ++zoomSequence.current;
    zoomRef.current = next;setReadingZoom(next);zoomPending.current++;setError("");
    persistViewSettings({pageZoom:next}).then(result=>{confirmedZoom.current=validPageZoom(result?.pageZoom ?? next)}).catch(error=>{
      if(sequence === zoomSequence.current){zoomRef.current=confirmedZoom.current;setReadingZoom(confirmedZoom.current);setError(error.message || "The Page zoom could not be saved.")}
    }).finally(()=>{zoomPending.current--});
  };
  const stepZoom = (direction) => {
    const current = zoomRef.current;
    const next = direction > 0 ? PAGE_ZOOM_STEPS.find(value=>value>current) ?? 200 : PAGE_ZOOM_STEPS.filter(value=>value<current).at(-1) ?? 50;
    changeZoom(next);
  };
  const changeView = (value) => {
    setError("");persistViewSettings({pageView:value}).catch(error=>setError(error.message || "The Page view could not be saved."));
  };
  useEffect(()=>{
    setToolbarSlot(document.getElementById("page-toolbar-slot"));
    if (!focused) setOptionsOpen(false);
  },[focused]);
  useLayoutEffect(()=>{
    if (!focused || !toolbarSlot || pageView !== "half") {setToolbarWidth(null);return;}
    const place=()=>{
      const paper=readerShell.current && layoutBounds(readerShell.current);
      if (!paper) return;
      const slot=layoutBounds(toolbarSlot);
      const header=toolbarSlot.closest(".workspace-topbar");
      const gutter=header ? parseFloat(getComputedStyle(header).paddingRight) || 8 : 8;
      setToolbarWidth(Math.max(0,slot.right-paper.left-gutter));
    };
    place();
    const observer=new ResizeObserver(place);
    observer.observe(toolbarSlot);
    if (readerShell.current) observer.observe(readerShell.current);
    window.addEventListener("resize",place);
    return()=>{observer.disconnect();window.removeEventListener("resize",place)};
  },[focused,toolbarSlot,pageView,sidebar]);
  useEffect(()=>{
    if (!optionsOpen) return;
    const outside=event=>{if(!optionsRef.current?.contains(event.target))setOptionsOpen(false)};
    document.addEventListener("pointerdown",outside);
    return()=>document.removeEventListener("pointerdown",outside);
  },[optionsOpen]);
  useEffect(()=>{
    confirmedZoom.current=validPageZoom(node.pageZoom);
    if(!zoomPending.current){zoomRef.current=confirmedZoom.current;setReadingZoom(confirmedZoom.current)}
  },[node.pageZoom]);
  useEffect(()=>{
    if(!focused) return;
    const action=event=>{
      if(event.detail === "page-zoom-in") stepZoom(1);
      if(event.detail === "page-zoom-out") stepZoom(-1);
      if(event.detail === "page-zoom-reset") changeZoom(100);
    };
    window.addEventListener("tangent:page-view-action",action);
    return()=>window.removeEventListener("tangent:page-view-action",action);
  },[focused,board.id,node.id]);
  const sync = async () => {
    setSyncing(true);
    setError("");
    try {
      await window.tangent.invoke("page/sync", {
        boardId: board.id,
        nodeId: node.id,
      });
    } catch (error) {
      setError(error.message || "The original Page could not be refreshed.");
    } finally {
      setSyncing(false);
    }
  };
  useEffect(() => {
    if (
      connection.connected &&
      !browser &&
      !snapshot &&
      attempted.current !== node.id
    ) {
      attempted.current = node.id;
      sync();
    }
  }, [node.id, Boolean(snapshot), browser, connection.connected]);
  useEffect(() => {
    if (answerScroller.current)
      answerScroller.current.scrollTop = answerScroller.current.scrollHeight;
  }, [target?.messages?.at(-1)?.text, target?.status, showDiscussion]);
  useEffect(() => {
    if (node.targetChatId) {
      setShowDiscussion(true);
    }
  }, [node.targetChatId]);
  const goTo = (blockId) => {
    setPendingAnchor(blockId);
  };
  useEffect(() => {
    if (!pendingAnchor || !scroller.current) return;
    const block = document.getElementById(
      `page-block-${node.id}-${pendingAnchor}`,
    );
    if (!block) return;
    const scroll = scroller.current;
    const place = () => {
      const rect = scroll.getBoundingClientRect(),
        target = block.getBoundingClientRect();
      const scale = rect.height / scroll.offsetHeight || 1;
      scroll.scrollTo({
        top: scroll.scrollTop + (target.top - rect.top) / scale - 28,
        behavior: "instant",
      });
    };
    place();
    setPendingAnchor(null);
  }, [tab, pendingAnchor, node.id, blocks.length]);
  const askSelection = ({blockId,quote,rect,range,context,action="ask"}) => {
    openPage(node.id);
    const passage = {
      nodeId:node.id,pageNodeId:node.id,blockId,quote,range,context,
      chatId:targetId,nativePage:true,expanded:true,action,
      x:Math.min(Math.max(12,rect.left),window.innerWidth-365),
      y:Math.min(rect.bottom+8,window.innerHeight-310),
    };
    if(action === "side-chat") setQuoteDraft(null);
    setDocumentQuote(passage);
    setSelection(passage);
  };
  const askBlock = (event,block) => askSelection({blockId:block?.id,quote:block?.markdown||"",rect:event.currentTarget.getBoundingClientRect()});
  const send = async (event) => {
    event.preventDefault();
    const original = questionRef.current;
    const anchor = activeQuote;
    if (!original.trim() || sending) return;
    const revision=questionRevision.current;
    const persistence=draftPersistence.current;
    persistence?.cancel();
    questionRef.current="";setQuestion("");
    setSending(true);
    setError("");
    try {
      await window.tangent.invoke("page/ask", {
        boardId: board.id,
        nodeId: node.id,
        text: original.trim(),
        chatId: targetId,
        permissionMode:targetId?undefined:newPermissionMode,
        quote: anchor?.quote || undefined,
        blockId: anchor?.blockId,
      });
      if (anchor) { setSelection((current) => current === anchor ? null : current);setQuoteDraft((current)=>current === anchor ? null : current); }
      persistence?.flush(questionRef.current,{force:true}).catch(error=>setError(`Message sent, but the local draft could not save: ${error.message}`));
      setShowDiscussion(true);
    } catch (error) {
      if(questionRevision.current===revision){questionRef.current=original;setQuestion(original)}
      persistence?.flush(questionRef.current,{force:true}).catch(()=>{});
      setError(error.message || "Your message could not be sent. Your draft is still here.");
    } finally {
      setSending(false);
    }
  };
  const chooseTarget = async (event) => {
    const chatId = event.target.value || null;
    // Route the next Enter to the option the user just chose; a batched
    // canonical snapshot can arrive after that immediate keystroke.
    setTargetId(chatId);
    if(chatId)setShowDiscussion(true);
    try{await invoke("page/settings",{boardId:board.id,nodeId:node.id,targetChatId:chatId});}
    catch(error){setTargetId(node.targetChatId||null);setError(error.message);}

  };
  useEffect(() => {
    if (!pageSelection) return;
    setQuoteDraft(pageSelection);
    setDocumentQuote(pageSelection);
    setTab("document");
    setShowDiscussion(true);
    const timer = setTimeout(() => questionInput.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [pageSelection]);
  const clearQuote = () => {
    setQuoteDraft(null);
    setDocumentQuote(null);
    setSelection((current)=>current?.pageNodeId === node.id ? null : current);
  };
  useEffect(()=>{
    const persistence=createDraftPersistence({
      key:`${board.id}:${node.id}`,initial:node.draft||"",read:()=>questionRef.current,
      write:value=>window.tangent.invoke("node/update",{boardId:board.id,nodeId:node.id,draft:value}),
      onError:error=>setError(`Your draft could not save: ${error.message}`),
    });
    draftPersistence.current=persistence;
    return()=>{persistence.dispose().catch(()=>{});if(draftPersistence.current===persistence)draftPersistence.current=null;};
  },[board.id,node.id]);
  useEffect(()=>{
    if(!focused || !activeQuote) return;
    const escapeQuote=event=>{
      if(document.querySelector(".chat-fullscreen,.permission-chooser-menu,.model-effort-popover") || event.key !== "Escape" || optionsOpen || event.target.closest?.(".page-rich-editor,[data-page-rich-toolbar],[data-page-rich-link]") || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();event.stopImmediatePropagation();clearQuote();
    };
    window.addEventListener("keydown",escapeQuote,true);
    return()=>window.removeEventListener("keydown",escapeQuote,true);
  },[focused,activeQuote,node.id,optionsOpen]);
  useEffect(() => {
    const onEscape = (event) => {
      if (event.detail !== node.id || !focused) return;
      if (optionsOpen) setOptionsOpen(false);
      else if (showContents) setShowContents(false);
      else if (showDiscussion) setShowDiscussion(false);
      else closePage();
    };
    window.addEventListener("tangent:page-escape", onEscape);
    return () => window.removeEventListener("tangent:page-escape", onEscape);
  }, [node.id, focused, optionsOpen, showContents, showDiscussion, closePage]);
  useEffect(() => {
    if (!focused || !scroller.current || !headings.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a,b) => a.boundingClientRect.top-b.boundingClientRect.top);
      if (visible[0]) setActiveHeading(visible[0].target.dataset.blockId);
    }, { root: scroller.current, rootMargin: "0px 0px -75% 0px", threshold: 0 });
    headings.forEach((heading) => {
      const block = document.getElementById(`page-block-${node.id}-${heading.blockId}`);
      if (block) observer.observe(block);
    });
    return () => observer.disconnect();
  }, [focused, headings, node.id]);
  const modelValue = target?.model || connection.model || "";
  const selectedModel = connection.models?.find(model=>(model.model || model.id) === modelValue);
  const efforts = selectedModel?.supportedReasoningEfforts?.map(option=>typeof option === "string" ? option : option.reasoningEffort) || [target?.effort || connection.effort || "medium"];
  const requestedEffort = target?.effort || connection.effort || selectedModel?.defaultReasoningEffort || "medium";
  const effortValue = efforts.includes(requestedEffort) ? requestedEffort : selectedModel?.defaultReasoningEffort || efforts[0];
  const setChatSettings = async (fields) => {
    setSettingsPending(true);setError("");
    try { await window.tangent.invoke(target ? "node/settings" : "codex/settings",target ? {boardId:board.id,nodeId:target.id,...fields} : fields); }
    catch(error){setError(error.message)}finally{setSettingsPending(false)}
  };
  if (browser)
    return <BrowserPage data={{...data,navigate:(nodeId)=>data.navigate(nodeId,{canvas:true})}} selected={selected} onExitBrowser={() => {setBrowser(false);openPage(node.id)}} />;
  const previewImage = snapshot?.media?.find((asset) => asset.kind === "image");
  const previewText = blocks.find((block) => block.markdown?.length > 90 && !/^[#!|]/.test(block.markdown));
  const toolbar = focused && toolbarSlot ? createPortal(
    <div className={`page-floating-toolbar is-view-${pageView}`} style={pageView === "half" && toolbarWidth !== null ? {width:toolbarWidth} : undefined} data-testid={`page-toolbar-${node.id}`}>
      <div className="page-title-and-save"><div className="page-title-options" ref={optionsRef}>
        <button className="page-title-pill" aria-label="Page options" aria-expanded={optionsOpen} aria-controls={`page-options-${node.id}`} data-testid={`page-title-menu-${node.id}`} onClick={()=>setOptionsOpen(value=>!value)}>
          <FileText size={17} strokeWidth={1.65}/><span>{snapshot?.title || node.title}</span><ChevronDown size={13}/>
        </button>
        {optionsMotion.value && <div {...optionsMotion.props} className="page-options-menu" id={`page-options-${node.id}`} data-testid={`page-options-menu-${node.id}`}>
          <div className="page-menu-zoom"><span>Zoom</span><div className="page-zoom-controls" role="group" aria-label="Page zoom">
            <button onClick={()=>stepZoom(-1)} disabled={readingZoom<=50} title="Zoom Page out · ⌘ −" aria-label="Zoom Page out" data-testid={`page-zoom-out-${node.id}`}><Minus size={14}/></button>
            <label><select aria-label="Page zoom" data-testid={`page-zoom-${node.id}`} value={readingZoom} onChange={event=>changeZoom(Number(event.target.value))}>{!PAGE_ZOOM_STEPS.includes(readingZoom) && <option value={readingZoom}>{readingZoom}%</option>}{PAGE_ZOOM_STEPS.map(value=><option key={value} value={value}>{value}%</option>)}</select><ChevronDown size={10}/></label>
            <button onClick={()=>stepZoom(1)} disabled={readingZoom>=200} title="Zoom Page in · ⌘ +" aria-label="Zoom Page in" data-testid={`page-zoom-in-${node.id}`}><Plus size={14}/></button>
            <button onClick={()=>changeZoom(100)} title="Reset Page zoom · ⌘ 0" aria-label="Reset Page zoom" data-testid={`page-zoom-reset-${node.id}`}><RotateCcw size={14}/></button>
          </div></div>
          <div className="page-menu-divider"/>
          <button onClick={()=>{setOptionsOpen(false);setTab("document");setShowDiscussion(true)}} data-testid={`page-menu-discuss-${node.id}`}><MessageSquareText size={16}/>Discuss with Codex</button>
          <button onClick={()=>{setOptionsOpen(false);setCommentBlock(null);setTab("comments");setShowDiscussion(true)}}><MessageCircle size={16}/>Comments<span>{threads.length}</span></button>
          <button onClick={()=>{setOptionsOpen(false);setShowContents(value=>!value)}}><List size={16}/>Page contents</button>
          <button onClick={()=>{setOptionsOpen(false);sync()}} disabled={pageSyncing} data-testid={`page-refresh-${node.id}`}><RotateCw size={16} className={pageSyncing ? "spin" : ""}/>Refresh</button>
          <div className="page-menu-divider"/>
          <button onClick={()=>{setOptionsOpen(false);invoke("app/open-external",{url:node.pageUrl})}}><ExternalLink size={16}/>Open in ChatGPT</button>
          <button onClick={()=>{setOptionsOpen(false);setBrowser(true);data.navigate(node.id,{canvas:true})}} data-testid={`page-browser-${node.id}`}><Globe size={16}/>Browser fallback</button>
        </div>}
      </div>
      <span className="page-save-slot" id={`page-save-slot-${node.id}`} /></div>
      <div className="page-floating-actions">
        <button className={`page-toolbar-circle ${tab === "comments" && showDiscussion ? "is-active" : ""}`} onClick={()=>{setCommentBlock(null);setTab("comments");setShowDiscussion(tab !== "comments" || !showDiscussion)}} data-testid={`page-comments-tab-${node.id}`} aria-label={`Comments (${threads.length})`} data-tooltip="Comments"><MessageCircle size={18} strokeWidth={1.65}/></button>
        <button className={`page-toolbar-circle ${tab === "document" && showDiscussion ? "is-active" : ""}`} onClick={()=>{setTab("document");setShowDiscussion(tab === "comments" || !showDiscussion)}} data-testid="page-discussion-toggle" aria-label="Discuss with Codex" data-tooltip="Discuss with Codex"><MessageSquareText size={18} strokeWidth={1.65}/></button>
        <div className="page-window-pill">
          <button onClick={()=>changeView(pageView === "full" ? "half" : "full")} data-testid={`page-view-toggle-${node.id}`} aria-label={pageView === "full" ? "Exit full screen" : "Enter full screen"} data-tooltip={pageView === "full" ? "Exit full screen" : "Enter full screen"}>{pageView === "full" ? <Minimize2 size={18} strokeWidth={1.65}/> : <Maximize2 size={18} strokeWidth={1.65}/>}</button>
          <button onClick={closePage} data-testid="page-focus-back" aria-label="Close Page" data-tooltip="Close Page"><X size={19} strokeWidth={1.65}/></button>
        </div>
      </div>
    </div>, toolbarSlot, `page-toolbar-${board.id}-${node.id}`
  ) : null;
  const reading = (
    <section {...readerMotion.props} ref={element=>{readerShell.current=element;readerMotion.ref.current=element}} className={`page-reader-shell is-view-${pageView} ${showDiscussion ? "with-discussion" : ""} ${sidebar ? "" : "is-full-width"}`} hidden={!readerMotion.value}
      style={{"--page-reader-left":"var(--sidebar-current, var(--sidebar))","--page-discussion-width":`${discussionSize.width}px`}} data-testid={`page-focus-${node.id}`} data-page-mode={pageView} data-page-zoom={readingZoom} aria-label="Page reading workspace">
      <div className="rich-page-card page-reader" data-testid={`card-${node.id}`} data-kind="page" data-page-view="native">
        {(error || node.pageSyncError) && <div className="rich-page-error" role="alert"><span>{error || node.pageSyncError}</span><IconButton title="Dismiss Page error" onClick={()=>setError("")}><X size={13}/></IconButton></div>}
        {node.pendingApproval && <Approval node={node}/>}
        {(snapshot?.mediaErrors?.length > 0 || snapshot?.commentsError) && <details className="page-attachment-warning"><summary>{snapshot.mediaErrors?.length ? `${snapshot.mediaErrors.length} original attachment${snapshot.mediaErrors.length === 1 ? " is" : "s are"} unavailable` : "Original comments could not sync"}</summary><p>Refresh to retry unavailable source material.</p>{(snapshot.mediaErrors||[]).map((item,index)=><div key={index}>{typeof item === "string" ? item : item.error || item.reference}</div>)}{snapshot.commentsError && <div>{snapshot.commentsError}</div>}</details>}
        <div className="page-reader-body">
          <div className="page-paper-region">
            {snapshot && headings.length > 2 && <div className={`page-outline-rail ${showContents ? "is-pinned" : ""}`}
              onPointerEnter={()=>{if(window.matchMedia("(hover: hover) and (pointer: fine)").matches)setOutlineHover(true)}}
              onPointerLeave={()=>setOutlineHover(false)}
              onFocusCapture={()=>setOutlineFocus(true)}
              onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOutlineFocus(false)}}>
              <button className="page-outline-trigger" aria-label="Page contents" aria-expanded={showContents} onClick={()=>setShowContents(value=>!value)} data-testid={focused ? "page-outline-toggle" : undefined}>
                {headings.map(heading=><i key={heading.blockId} className={`level-${heading.level} ${activeHeading === heading.blockId ? "active" : ""}`}/>)}
              </button>
              {outlineMotion.value && <nav {...outlineMotion.props} className="page-outline-popover" aria-label="Page contents"><button className="page-outline-title" data-testid={focused ? "page-outline-title" : undefined} onClick={()=>{scroller.current?.scrollTo({top:0,behavior:"instant"});setActiveHeading(null);setShowContents(false)}}>{snapshot.title}</button>{headings.map(heading=><button key={heading.blockId} className={`level-${heading.level} ${activeHeading === heading.blockId ? "active" : ""}`} onClick={()=>{goTo(heading.blockId);setActiveHeading(heading.blockId);setShowContents(false)}}>{heading.text}</button>)}</nav>}
            </div>}
            <div ref={scroller} className="rich-page-scroll" data-testid={`page-content-${node.id}`}>
              <article className="rich-page-document" data-node-id={node.id} style={{zoom:readingZoom/100}}>
                {snapshot ? <PageRichEditor snapshot={snapshot} node={node} board={board} invoke={invoke} active={focused} quotedSelection={activeQuote || documentQuote} onAskSelection={askSelection} renderOpaque={block=><PageMarkdown markdown={block.markdown} media={snapshot.media} invoke={invoke} dimensions={block.metadata?.dimensions || block.dimensions}/>} statusSlot={toolbarSlot} /> : <div className="rich-page-loading">{pageSyncing ? <LoaderCircle size={28} className="spin"/> : <Globe size={28}/>}<h2>{pageSyncing ? "Opening your Page…" : "Your original Page belongs here."}</h2><p>{pageSyncing ? "Loading the document, images, figures, and comments." : "Read and discuss the original through your connected Pages account."}</p>{!pageSyncing && <button className="button primary" onClick={sync}>Load Page<ArrowUpRight size={14}/></button>}</div>}
              </article>
            </div>
          </div>
          {showDiscussion && <aside className={`page-discussion-panel ${tab === "comments" ? "showing-comments" : ""}`} data-testid={focused ? "page-discussion-panel" : undefined}>
            {discussionSize.grip}
            <div className="page-panel-heading"><strong>{tab === "comments" ? "Comments" : "Codex"}</strong><IconButton title="Close discussion" onClick={()=>setShowDiscussion(false)}><X size={16}/></IconButton></div>
            {tab === "comments" ? <div className="rich-page-comments-scroll"><p className="page-comments-note">{threads.length} {threads.length === 1 ? "thread" : "threads"} · Original Page</p>{commentBlock && <button className="page-show-all-comments" onClick={()=>setCommentBlock(null)}>Show all comments</button>}<PageComments active={focused} unavailable={Boolean(snapshot?.commentsError)} threads={commentBlock ? threads.filter(thread=>(thread.selectionContext?.start?.blockId || thread.target?.anchor?.blockId || thread.target?.blockId || thread.blockId) === commentBlock) : threads} onAnchor={blockId=>goTo(blockId)} onDiscuss={askBlock} invoke={invoke}/></div> : <>
              <label className="page-discussion-target"><span>Conversation</span><select aria-label="Page discussion chat" data-testid={activeQuote && focused ? "page-comment-chat-target" : `page-chat-target-${node.id}`} value={targetId || ""} onChange={chooseTarget}><option value="">New discussion</option>{chats.map(chat=><option key={chat.id} value={chat.id}>{chat.title}</option>)}</select><ChevronDown size={13}/>{target && <button type="button" title="Open conversation on canvas" onClick={()=>data.navigate(target.id)}><ArrowUpRight size={13}/></button>}</label>
              <div ref={answerScroller} className="page-thread-messages" data-testid={`page-thread-${node.id}`}>
                {target ? <>{(target.messages||[]).map(message=><Message key={message.id} message={message} node={target}/>)}{isBusy(target) && <div className="page-thread-working"><LoaderCircle size={13} className="spin"/>Codex is working…</div>}{target.pendingApproval && <Approval node={target}/>} {target.pendingQuestion && <Question node={target}/>}</> : <div className="page-discussion-empty"><MessageCircle size={24} strokeWidth={1.3}/><h3>Ask about this Page</h3><p>Select a passage or start a conversation with Codex.</p></div>}
              </div>
              {target?.queue?.length > 0 && <QueuePanel node={target}/>}
              <form onSubmit={send} className="page-ask-form">
                {activeQuote && <div className="page-composer-quote" data-testid={focused ? "selection-toolbar" : undefined}><div><span>About this passage</span><IconButton title="Remove quoted passage" onClick={clearQuote}><X size={13}/></IconButton></div><blockquote>{activeQuote.quote}</blockquote></div>}
                <textarea ref={questionInput} aria-label="Ask Codex about this Page" data-testid={activeQuote && focused ? "comment-question" : `page-ask-input-${node.id}`} value={question} onChange={event=>{questionRevision.current++;questionRef.current=event.target.value;setQuestion(event.target.value);draftPersistence.current?.schedule()}} onBlur={()=>draftPersistence.current?.flush().catch(()=>{})} onKeyDown={event=>{event.stopPropagation();if(event.key === "Escape"){event.preventDefault();if(activeQuote)clearQuote();else setShowDiscussion(false);return}if(event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing){event.preventDefault();event.currentTarget.form.requestSubmit()}}} placeholder={activeQuote ? "Ask about this passage…" : "Ask about this Page…"} rows={3}/>
                <div className="page-composer-footer"><div className="page-composer-settings"><PermissionChooser label="Page discussion permissions" testId={`page-permission-${node.id}`} value={target?.permissionMode||newPermissionMode} activeValue={target?.activePermissionMode} running={isBusy(target)} disabled={settingsPending} onChange={permissionMode=>target?setChatSettings({permissionMode}):setNewPermissionMode(permissionMode)}/><ModelEffortChooser models={connection.models||[]} model={modelValue} effort={effortValue} efforts={efforts} disabled={settingsPending} running={isBusy(target)} onChange={setChatSettings} testId={`page-settings-${node.id}`} modelTestId={`page-model-${node.id}`} effortTestId={`page-effort-${node.id}`}/></div>{target && isBusy(target) && <button type="button" className="page-stop-button" title="Stop response" onClick={()=>invoke("node/stop",{boardId:board.id,nodeId:target.id})}><Square size={11} fill="currentColor"/></button>}<button type="submit" disabled={sending || !question.trim()} data-testid={activeQuote && focused ? "submit-comment" : `page-ask-send-${node.id}`} title={target && isBusy(target) ? "Queue in selected chat" : "Send message"}>{sending ? <LoaderCircle size={15} className="spin"/> : <ArrowUpRight size={17}/>}</button></div>
              </form>
              <p className="page-discussion-provenance">{target && isBusy(target) ? "Follow-up will queue in this conversation" : target ? `Answers in ${target.title}` : "Starts a new discussion on this canvas"}</p>
            </>}
          </aside>}
        </div>
      </div>
    </section>
  );
  return <>
    <div className={`canvas-card page-canvas-preview ${selected ? "is-selected" : ""}`} data-testid={`page-canvas-${node.id}`} onDoubleClick={()=>openPage(node.id)}>
      <CanvasHandles/><CanvasResizeControls nodeId={node.id} minWidth={400} minHeight={440} onStart={resizeStart} onCommit={resizeEnd}/>
      <header className="card-header card-drag-handle"><Globe size={15}/><EditableTitle node={node}/><IconButton title="Open Page reading view" onClick={()=>openPage(node.id)} data-testid={`page-focus-open-${node.id}`}><Maximize2 size={14}/></IconButton><IconButton title="Archive Page" onClick={()=>{if(focused)closePage();invoke("node/archive",{boardId:board.id,nodeId:node.id})}}><X size={14}/></IconButton></header>
      <CardSummary node={node} boardId={board.id} invoke={invoke}/>
      <button className="page-preview-open" onClick={()=>openPage(node.id)}><span className="page-preview-source"><Globe size={12}/>ChatGPT Page</span><h2>{snapshot?.title || node.title}</h2>{previewImage && <img src={previewImage.url} alt="" loading="lazy"/>}<p>{previewText ? shortText(previewText.markdown).slice(0,260) : "Read, edit, and explore the original Page with Codex."}</p><span className="page-preview-cta">Open Page<ArrowUpRight size={15}/></span><small>{blocks.length ? `${blocks.length} blocks · ${threads.length} comments` : pageSyncing ? "Syncing…" : "Linked to the original"}</small></button>
    </div>
    {createPortal(reading,document.body,`page-reader-${board.id}-${node.id}`)}
    {toolbar}
  </>;
}
