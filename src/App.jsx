import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import tangentIcon from "../assets/icon.png";
import RichPageNode from "./RichPageNode.jsx";
import {createDraftPersistence,flushPendingDrafts} from "./draft-persistence.mjs";
import {LocalSaveStatus,DocumentSaveStatus} from "./PersistenceStatus.jsx";
import FloatingSideChat from "./FloatingSideChat.jsx";
import SteeringNotice from "./SteeringNotice.jsx";
import ChatFullscreen from "./ChatFullscreen.jsx";
import PermissionChooser from "./PermissionChooser.jsx";
import ModelEffortChooser from "./ModelEffortChooser.jsx";
import CardSummary, {BoardSummaryControl} from "./CardSummary.jsx";
import CanvasSummaryHover from "./CanvasSummaryHover.jsx";
import CanvasResizeControls from "./CanvasResizeControls.jsx";
import ScreenSearch, {screenSearchSource} from "./ScreenSearch.jsx";
import {buildScreenSearchScope} from "./screen-search-scope.mjs";
import {cardAttention,cardAttentionDescription} from "./card-attention.mjs";
import "./card-attention.css";
import "./chrome.css";
import { layoutBounds, motionDuration, setMotionInput, useLayoutMotion, useMotionEnvironment, useMotionPresence } from "./motion.mjs";
import "./motion.css";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  useStore,
  useViewport,
  applyNodeChanges,
  getViewportForBounds,
} from "@xyflow/react";
import {
  ArrowUp,
  Pause,
  Play,
  ListPlus,
  Pencil,
  Trash2,
  Globe,
  Link,
  ArrowUpRight,
  CornerDownRight,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  Command,
  Copy,
  CornerDownLeft,
  Download,
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  HelpCircle,
  History,
  Layers3,
  Link2,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  StickyNote,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

const CanvasContext = createContext(null);
const useCanvas = () => useContext(CanvasContext);
const CanvasActionsContext = createContext(null);
const useCanvasActions = () => useContext(CanvasActionsContext);
const afterCanvasLayout = (action) => requestAnimationFrame(() => requestAnimationFrame(action));
const busy = (node) =>
  ["starting", "running", "awaiting-approval"].includes(node.status);
const shortPath = (path) => path?.split("/").filter(Boolean).slice(-1)[0];
const timeLabel = (value) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : "";
const iconProps = { size: 15, strokeWidth: 1.7 };

function quotePreview(value) {
  return String(value || "")
    .replace(
      /!\[([^\]]*)\]\([^)]*\)/g,
      (_, alt) => `[Image${alt ? `: ${alt}` : ""}]`,
    )
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/tangent-asset:\/\/[^\s)]+/g, "[Image]")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function CanvasHandles() {
  return (
    <>
      <Handle
        id="in-left"
        type="target"
        position={Position.Left}
        className="node-handle"
        isConnectable={false}
      />
      <Handle
        id="in-right"
        type="target"
        position={Position.Right}
        className="node-handle"
        isConnectable={false}
      />
      <Handle
        id="out-left"
        type="source"
        position={Position.Left}
        className="node-handle"
        isConnectable={false}
      />
      <Handle
        id="out-right"
        type="source"
        position={Position.Right}
        className="node-handle"
        isConnectable={false}
      />
    </>
  );
}

function IconButton({ title, children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={title}
      aria-label={title}
      {...props}
    >
      {children}
    </button>
  );
}

function SidebarToggle({ expanded, onClick }) {
  const press = useRef(null);
  return <IconButton title={expanded ? "Hide sidebar" : "Show sidebar"}
    className="sidebar-toggle" data-testid={expanded ? "hide-sidebar" : "show-sidebar"}
    onClick={onClick}
    onPointerDown={event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      // The control moves with the workspace during a sidebar reversal.
      // Keep an ordinary press attached to it until release.
      press.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (!press.current || Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) <= 8) return;
      // Deliberately dragging away still cancels like a normal button.
      press.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { press.current = null; }}>
    {expanded ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={18} />}
  </IconButton>;
}

function Mark({ small = false }) {
  return (
    <span className={`tangent-mark ${small ? "small" : ""}`} aria-hidden="true">
      <img src={tangentIcon} alt="" draggable="false" />
    </span>
  );
}

function Markdown({ children }) {
  const { invoke, toast } = useCanvasActions();
  // Conversation state and window chrome change independently of this text.
  // Keep its rendered tree (including links, code and images) intact until the
  // actual content or one of its actions changes.
  return useMemo(() => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) =>
        /^tangent-asset:\/\/[a-zA-Z0-9._/-]+$/.test(url)
          ? url
          : defaultUrlTransform(url)
      }
      components={{
        img: ({ src, alt }) => (
          <span className="document-image">
            <img src={src} alt={alt || "Document image"} loading="lazy" />
            {alt && <span className="image-caption">{alt}</span>}
          </span>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (/^https?:\/\//i.test(href || ""))
                invoke("app/open-external", { url: href });
            }}
          >
            {children}
            <ExternalLink size={10} className="inline-link-icon" />
          </a>
        ),
        pre: ({ children }) => (
          <div className="code-wrap">
            <button
              type="button"
              title="Copy code"
              aria-label="Copy code"
              onClick={async (event) => {
                const text =
                  event.currentTarget.parentElement.querySelector(
                    "pre",
                  )?.innerText;
                const result = await invoke("app/copy-text", {text:text || ""});
                if(result?.copied===true)toast("Copied code");
              }}
            >
              <Copy size={12} />
            </button>
            <pre>{children}</pre>
          </div>
        ),
      }}
    >
      {children || ""}
    </ReactMarkdown>
  ), [children, invoke, toast]);
}

function Status({ node }) {
  if (node.status === "running" || node.status === "starting")
    return (
      <span className="card-status working">
        <LoaderCircle className="spin" size={12} />
        {node.status === "starting" ? "Connecting" : "Working"}
      </span>
    );
  if (node.status === "awaiting-approval")
    return (
      <span className="card-status attention">
        <ShieldCheck size={12} />
        Needs you
      </span>
    );
  if (node.status === "error")
    return (
      <span className="card-status error-status">
        <Circle size={7} fill="currentColor" />
        Error
      </span>
    );
  if (node.status === "interrupted")
    return <span className="card-status">Stopped</span>;
  return null;
}

function EditableTitle({ node }) {
  const { update } = useCanvas();
  const [title, setTitle] = useState(node.title);
  useEffect(() => setTitle(node.title), [node.title]);
  return (
    <input
      className="card-title nodrag nopan"
      aria-label="Conversation title"
      data-testid={`title-${node.id}`}
      value={title || ""}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={() => {
        if (title.trim() && title !== node.title)
          update(node.id, { title: title.trim() });
        else setTitle(node.title);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

const deliveryErrorText = value => String(value?.message || value || "Could not send this message.")
  .replace(/^Error invoking remote method '[^']+':\s*/, "")
  .replace(/^(?:Error|CodexRpcError):\s*/, "")
  .replace(/^turn\/steer:\s*/, "");

function canBranchMessage(message, node) {
  const position = node.messages.findIndex((item) => item.id === message.id);
  return Boolean(
    message.role === "assistant" &&
    message.text &&
    message.turnId &&
    (!message.status || message.status === "completed") &&
    node.activeTurnId !== message.turnId &&
    !node.messages
      .slice(position + 1)
      .some(
        (item) => item.role === "assistant" && item.text && item.turnId === message.turnId,
      ));
}

const Message = memo(function Message({ message, node, inherited = false }) {
  const { branch, invoke, setSelection, toast, acknowledgeReply } = useCanvasActions();
  const assistant = message.role === "assistant";
  const canBranch = canBranchMessage(message, node);
  return (
    <article
      className={`message ${assistant ? "assistant" : "user"} ${inherited ? "inherited" : ""}`}
      data-message-id={message.id}
      data-node-id={node.id}
      data-role={message.role}
      data-testid={`message-${message.id}`}
      onPointerDownCapture={() => acknowledgeReply(node.id)}
    >
      <div className="message-role">
        {assistant ? (
          <>
            <Mark small />
            Codex
          </>
        ) : (
          <>
            You

          </>
        )}
        {message.status === "streaming" && <span className="stream-dot" />}
      </div>
      <div className="message-text">
        {!assistant && message.quote && (
          <blockquote className="message-quoted-passage" data-testid={`message-quote-${message.id}`} aria-label="Quoted passage">
            {message.quote}
          </blockquote>
        )}
        <Markdown>{message.text}</Markdown>
        {assistant && <ImageOutputs images={message.images || []} />}
        {assistant && !message.text && !message.images?.length && message.status === "streaming" && (
          <span className="typing-dots">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
      <SteeringNotice message={message}/>
      {message.deliveryError && (
        <div className="message-delivery-error">{deliveryErrorText(message.deliveryError)}</div>
      )}
      <div className="message-actions nodrag nopan">
        <IconButton
          title="Copy message"
          onClick={async () => {
            const result = await invoke("app/copy-text", {text:message.text || ""});
            if(result?.copied===true)toast("Copied message");
          }}
        >
          <Copy size={12} />
        </IconButton>
        {canBranch && (
          <>
            <button
              type="button"
              className="message-action"
              title="Branch from this reply"
              data-testid={`branch-${message.id}`}
              onClick={() => branch(node.id, message.id)}
            >
              <GitBranch size={12} />
              Branch here
            </button>
            <button
              type="button"
              className="message-action"
              title="Ask a side question about this reply"
              data-testid={`comment-${message.id}`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setSelection({
                  nodeId: node.id,
                  messageId: message.id,
                  quote: message.text,
                  x: Math.min(rect.left, window.innerWidth - 360),
                  y: Math.min(rect.bottom + 8, window.innerHeight - 270),
                  expanded: true,
                });
              }}
            >
              <MessageCircle size={12} />
              Comment
            </button>
          </>
        )}
      </div>
    </article>
  );
}, (previous, next) =>
  previous.node.id === next.node.id &&
  previous.inherited === next.inherited &&
  canBranchMessage(previous.message, previous.node) === canBranchMessage(next.message, next.node) &&
  // IPC snapshots recreate objects. Compare the entire serializable message so
  // text, images, quotations, steering and delivery updates all remain live.
  JSON.stringify(previous.message) === JSON.stringify(next.message)
);

function Approval({ node }) {
  const { invoke } = useCanvas();
  const approval = node.pendingApproval;
  if (!approval) return null;
  return (
    <div className="approval-box nodrag nopan" data-testid="approval-card">
      <span className="eyebrow">
        <ShieldCheck size={13} />
        Permission requested
      </span>
      <strong>{approval.title || "Codex needs your permission"}</strong>
      {approval.details && (
        <pre>
          {typeof approval.details === "string"
            ? approval.details
            : JSON.stringify(approval.details, null, 2)}
        </pre>
      )}
      <div className="approval-actions">
        <button
          className="button primary compact"
          data-testid="approval-accept"
          onClick={() =>
            invoke("approval/respond", {
              requestId: approval.requestId,
              decision: "accept",
            })
          }
        >
          Allow once
        </button>
        <button
          className="button compact"
          data-testid="approval-decline"
          onClick={() =>
            invoke("approval/respond", {
              requestId: approval.requestId,
              decision: "decline",
            })
          }
        >
          Decline
        </button>
      </div>
    </div>
  );
}

function Question({ node }) {
  const { invoke } = useCanvas();
  const request = node.pendingQuestion;
  const [answers, setAnswers] = useState({});
  if (!request) return null;
  const questions = Array.isArray(request.questions)
    ? request.questions
    : Object.values(request.questions || {});
  return (
    <form
      className="question-box nodrag nopan"
      data-testid="agent-question"
      onSubmit={(event) => {
        event.preventDefault();
        invoke("question/respond", { requestId: request.requestId, answers });
      }}
    >
      <span className="eyebrow">
        <HelpCircle size={13} />A question for you
      </span>
      {questions.map((question, index) => (
        <label className="question-field" key={question.id || index}>
          <strong>
            {question.question || question.header || "Your answer"}
          </strong>
          {question.options?.length ? (
            <select
              value={answers[question.id || index] || ""}
              onChange={(event) =>
                setAnswers((previous) => ({
                  ...previous,
                  [question.id || index]: event.target.value,
                }))
              }
            >
              <option value="">Choose an answer</option>
              {question.options.map((option) => (
                <option key={option.label} value={option.label}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={answers[question.id || index] || ""}
              onChange={(event) =>
                setAnswers((previous) => ({
                  ...previous,
                  [question.id || index]: event.target.value,
                }))
              }
              placeholder="Type your answer…"
            />
          )}
        </label>
      ))}
      <button className="button primary compact" type="submit">
        Send answer
        <ArrowUpRight size={13} />
      </button>
    </form>
  );
}

function ActivityList({ node }) {
  if (!node.activities?.length) return null;
  const latest = node.activities[node.activities.length - 1];
  return (
    <details className="activity-list nodrag nopan">
      <summary>
        {busy(node) ? (
          <LoaderCircle size={12} className="spin" />
        ) : (
          <Check size={12} />
        )}
        <span>{latest.title || "Agent activity"}</span>
        <span className="activity-count">{node.activities.length}</span>
        <ChevronDown size={12} />
      </summary>
      <div>
        {node.activities.map((activity) => (
          <div className="activity-item" key={activity.id}>
            <span className={`activity-dot ${activity.status || ""}`} />
            <div>
              <strong>{activity.title || activity.type}</strong>
              {activity.details && (
                <pre>
                  {typeof activity.details === "string"
                    ? activity.details
                    : JSON.stringify(activity.details, null, 2)}
                </pre>
              )}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function ImageOutputs({ images = [], legacy = false }) {
  if (!images.length) return null;
  return (
    <div className="generated-images nodrag nopan" data-image-placement={legacy ? "unbound-legacy" : "inline-turn"}>
      {legacy && <span className="image-caption">Earlier generated images</span>}
      {images.map((image) => (
        <figure key={image.itemId || image.id} data-testid={`generated-image-${image.id}`} data-image-turn-id={image.turnId || ""}>
          <img src={image.url} alt="Image generated by Codex" loading="lazy" />
        </figure>
      ))}
    </div>
  );
}

function QueuePanel({ node }) {
  const { board, invoke } = useCanvas();
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const entries = node.queue || [];
  if (!entries.length) return null;
  const action = (command, fields = {}) =>
    invoke(command, { boardId: board.id, nodeId: node.id, ...fields });
  return (
    <section
      className="queue-panel"
      data-testid={`queue-panel-${node.id}`}
      aria-label="Queued messages"
    >
      <div className="queue-heading">
        <ListPlus size={12} />
        <span>
          Up next <span className="queue-count">{entries.length}</span>
        </span>
        {node.queuePaused && <span className="queue-paused">Paused</span>}
        <IconButton
          title={node.queuePaused ? "Resume queue" : "Pause queue"}
          data-testid={`queue-${node.queuePaused ? "resume" : "pause"}-${node.id}`}
          onClick={() =>
            action(node.queuePaused ? "queue/resume" : "queue/pause")
          }
        >
          {node.queuePaused ? <Play size={11} /> : <Pause size={11} />}
        </IconButton>
      </div>
      <div className="queue-items">
        {entries.map((entry, index) => (
          <div
            className={`queue-entry ${entry.status || "queued"}`}
            key={entry.id}
            data-testid={`queue-entry-${entry.id}`}
          >
            <span className="queue-number">
              {entry.status === "sending" ? (
                <LoaderCircle size={10} className="spin" />
              ) : (
                index + 1
              )}
            </span>
            {editing === entry.id ? (
              <form
                className="queue-edit"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!text.trim()) return;
                  setPending(true);
                  try {
                    await window.tangent.invoke("queue/update", {
                      boardId: board.id,
                      nodeId: node.id,
                      queueId: entry.id,
                      text: text.trim(),
                    });
                    setEditing(null);
                  } catch (error) {
                    setEditError(error.message);
                  } finally {
                    setPending(false);
                  }
                }}
              >
                <textarea
                  autoFocus
                  aria-label="Edit queued message"
                  data-testid={`queue-edit-text-${entry.id}`}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape") setEditing(null);
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault();
                      event.currentTarget.form.requestSubmit();
                    }
                  }}
                />
                {editError && (
                  <p className="queue-entry-error" role="alert">
                    {editError}
                  </p>
                )}
                <div>
                  <button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={pending || !text.trim()}
                    data-testid={`queue-save-${entry.id}`}
                  >
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <div className="queue-entry-content">
                <p>{entry.text}</p>
                {entry.status === "sending" && (
                  <span className="queue-entry-state">Sending…</span>
                )}
                {entry.status === "uncertain" && (
                  <span className="queue-entry-error">
                    Delivery needs checking. Review the conversation before
                    retrying.
                  </span>
                )}
                {entry.error && (
                  <span className="queue-entry-error">{entry.error}</span>
                )}
              </div>
            )}
            {editing !== entry.id && (
              <div className="queue-entry-actions">
                <IconButton
                  title="Edit queued message"
                  data-testid={`queue-edit-${entry.id}`}
                  disabled={entry.status === "sending"}
                  onClick={() => {
                    setEditing(entry.id);
                    setEditError("");
                    setText(entry.text);
                  }}
                >
                  <Pencil size={11} />
                </IconButton>
                <IconButton
                  title="Move queued message up"
                  data-testid={`queue-up-${entry.id}`}
                  disabled={index === 0 || entry.status === "sending"}
                  onClick={() => {
                    const ids = entries.map((item) => item.id);
                    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                    action("queue/reorder", { queueIds: ids });
                  }}
                >
                  <ArrowUp size={11} />
                </IconButton>
                <IconButton
                  title="Send this queued message now"
                  data-testid={`queue-now-${entry.id}`}
                  disabled={entry.status === "sending"}
                  onClick={() =>
                    action("queue/send-now", { queueId: entry.id })
                  }
                >
                  <ArrowUpRight size={12} />
                </IconButton>
                <IconButton
                  title="Remove queued message"
                  data-testid={`queue-remove-${entry.id}`}
                  disabled={entry.status === "sending"}
                  onClick={() => action("queue/remove", { queueId: entry.id })}
                >
                  <X size={11} />
                </IconButton>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Composer({ node }) {
  const { board, connection, chatDrafts, chatDraftRevisions, chatDraftListeners, setChatDraft } = useCanvas();
  const [draft, setDraft] = useState(() => chatDrafts.current.get(node.id) ?? node.draft ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [settingsPending, setSettingsPending] = useState(false);
  const textarea = useRef(null);
  const draftPersistence = useRef(null);
  const latestDraft = useRef(draft);
  const pendingDraft = useRef(null);
  useEffect(() => {
    const receive=value=>{latestDraft.current=value;setDraft(value);};
    receive(chatDrafts.current.get(node.id)??node.draft??"");
    let listeners=chatDraftListeners.current.get(node.id);
    if(!listeners){listeners=new Set();chatDraftListeners.current.set(node.id,listeners);}
    listeners.add(receive);
    return()=>{listeners.delete(receive);if(!listeners.size)chatDraftListeners.current.delete(node.id);};
  },[node.id]);
  useEffect(() => {
    const persistence=createDraftPersistence({
      key:`${board.id}:${node.id}`,initial:node.draft||"",
      read:()=>{
        // Keep uncertain steering recoverable until Codex acknowledges it.
        const pending=pendingDraft.current;
        return pending?.command==="node/steer"&&pending.revision===(chatDraftRevisions.current.get(node.id)||0)?pending.original:(chatDrafts.current.get(node.id)??latestDraft.current);
      },
      write:value=>window.tangent.invoke("node/update",{boardId:board.id,nodeId:node.id,draft:value}),
      onError:error=>setActionError(`Your draft could not save: ${error.message}`),
    });
    draftPersistence.current=persistence;
    return()=>{persistence.dispose().catch(()=>{});if(draftPersistence.current===persistence)draftPersistence.current=null;};
  },[board.id,node.id]);
  const commitDraft = (value) => {
    setChatDraft(node.id,value,{edit:true});
    latestDraft.current = value;
    setDraft(value);
    draftPersistence.current?.schedule();
  };
  const submit = async (mode) => {
    const original = latestDraft.current;
    const text = original.trim();
    if (!text || submitting) return;
    const command =
      mode === "steer" ? "node/steer" : busy(node) ? "node/queue" : "node/send";
    if (command === "node/steer" && !node.activeTurnId) return;
    const persistence=draftPersistence.current;
    persistence?.cancel();
    const revision = chatDraftRevisions.current.get(node.id)||0;
    pendingDraft.current = { original, revision, command };
    latestDraft.current = "";
    setChatDraft(node.id, "");
    setDraft("");
    setSubmitting(true);
    setActionError("");
    try {
      await window.tangent.invoke(command, {
        boardId: board.id,
        nodeId: node.id,
        text,
      });
      pendingDraft.current = null;
      await persistence?.flush(chatDrafts.current.get(node.id)??latestDraft.current,{force:true}).catch(()=>{});
    } catch (error) {
      setActionError(deliveryErrorText(error.message || "Your message could not be sent. Your draft is still here."));
      // A rejection restores only the submitted draft. Any later edit, even
      // typing and then deleting text, belongs to the user's newer draft.
      if ((chatDraftRevisions.current.get(node.id)||0) === revision) {
        latestDraft.current = original;
        setChatDraft(node.id, original);
        setDraft(original);
      }
      pendingDraft.current = null;
      await persistence?.flush(chatDrafts.current.get(node.id)??latestDraft.current,{force:true}).catch(()=>{});
    } finally {
      pendingDraft.current = null;
      setSubmitting(false);
      textarea.current?.focus();
    }
  };
  const modelValue = node.model || connection.model || "";
  const model = connection.models?.find(
    (item) => (item.model || item.id) === modelValue,
  );
  const efforts = model?.supportedReasoningEfforts?.map((option) =>
    typeof option === "string" ? option : option.reasoningEffort,
  ) || [node.effort || connection.effort || "medium"];
  const requestedEffort =
    node.effort ||
    connection.effort ||
    model?.defaultReasoningEffort ||
    "medium";
  const effortValue = efforts.includes(requestedEffort)
    ? requestedEffort
    : model?.defaultReasoningEffort || efforts[0];
  const setSettings = async (fields) => {
    setSettingsPending(true);
    setActionError("");
    try {
      await window.tangent.invoke("node/settings", {
        boardId: board.id,
        nodeId: node.id,
        ...fields,
      });
    } catch (error) {
      setActionError(deliveryErrorText(error));
    } finally {
      setSettingsPending(false);
    }
  };
  return (
    <div className="composer-area nodrag nopan nowheel">
      <QueuePanel node={node} />
      {actionError && (
        <div
          className="composer-action-error"
          role="alert"
          data-testid={`composer-error-${node.id}`}
        >
          <span>{actionError}</span>
          <IconButton
            title="Dismiss message error"
            onClick={() => setActionError("")}
          >
            <X size={11} />
          </IconButton>
        </div>
      )}
      <div className={`composer composer-unified ${busy(node) ? "is-working" : ""}`}>
        <textarea
          ref={textarea}
          aria-label={
            node.kind === "comment" ? "Ask a side question" : "Message Codex"
          }
          data-testid={`composer-${node.id}`}
          rows={2}
          placeholder={
            busy(node)
              ? "Add a follow-up, or steer the current turn…"
              : node.kind === "comment"
                ? "Ask a side question…"
                : node.messages?.length
                  ? "Keep thinking…"
                  : "What do you want to work on?"
          }
          value={draft}
          onChange={(event) => commitDraft(event.target.value)}
          onBlur={() => {draftPersistence.current?.flush().catch(()=>{});}}
          onKeyDown={(event) => {
            if (event.key !== "Escape") event.stopPropagation();
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit(event.altKey ? "steer" : undefined);
            }
          }}
        />
        <div className="composer-bottom">
          <div className="composer-settings">
            <PermissionChooser value={node.permissionMode || "full"} activeValue={node.activePermissionMode} running={busy(node)} disabled={settingsPending} testId={`node-permission-${node.id}`} onChange={permissionMode => setSettings({ permissionMode })}/>
          </div>
          <div className="composer-controls">
            <ModelEffortChooser models={connection.models} model={model || modelValue} effort={effortValue} efforts={efforts} disabled={settingsPending} running={busy(node)} onChange={setSettings} testId={`node-settings-${node.id}`} modelTestId={`node-model-${node.id}`} effortTestId={`node-effort-${node.id}`} />
          <div className="composer-send-actions">
            {busy(node) && (
              <>
                <button
                  type="button"
                  className="steer-button"
                  data-testid={`steer-${node.id}`}
                  title="Submit without interrupting the model · Option+Enter"
                  aria-label="Steer current turn"
                  disabled={!draft.trim() || !node.activeTurnId || submitting}
                  onClick={() => submit("steer")}
                >
                  Steer
                  <CornerDownRight size={13} />
                </button>
                <button
                  type="button"
                  className="send-button stop-button"
                  data-testid={`stop-${node.id}`}
                  title="Stop response"
                  aria-label="Stop response"
                  onClick={() =>
                    window.tangent
                      .invoke("node/stop", {
                        boardId: board.id,
                        nodeId: node.id,
                      })
                      .catch((error) => setActionError(deliveryErrorText(error)))
                  }
                >
                  <Square size={11} fill="currentColor" />
                </button>
              </>
            )}
            <button
              type="button"
              className={`send-button ${busy(node) ? "queue-button" : ""}`}
              data-testid={`${busy(node) ? "queue" : "send"}-${node.id}`}
              disabled={!draft.trim() || submitting}
              title={
                busy(node) ? "Queue follow-up · Enter" : "Send message · Enter"
              }
              aria-label={busy(node) ? "Queue message" : "Send message"}
              onClick={() => submit()}
            >
              {submitting ? (
                <LoaderCircle size={14} className="spin" />
              ) : busy(node) ? (
                <ListPlus size={15} />
              ) : (
                <ArrowUp size={17} />
              )}
            </button>
          </div>
          </div>
        </div>
      </div>
      <div className="composer-hint">
        <span>
          {board.projectPath ? (
            <>
              <Folder size={10} />
              {shortPath(board.projectPath)}
            </>
          ) : (
            <>
              <ShieldCheck size={10} />
              Local workspace
            </>
          )}
        </span>
        <ComposerShortcuts running={busy(node)} testId={`composer-shortcuts-${node.id}`} />
      </div>
    </div>
  );
}

function ComposerShortcuts({ running = false, testId }) {
  return <span className="composer-shortcuts" data-testid={testId}>
    <span className="composer-shortcut"><kbd aria-label="Return"><CornerDownLeft size={10} aria-hidden="true" /></kbd><span>{running ? "queue" : "send"}</span></span>
    <span className="composer-shortcut-separator" aria-hidden="true">·</span>
    <span className="composer-shortcut"><kbd aria-label={running ? "Option+Return" : "Shift+Return"}><span aria-hidden="true">{running ? "⌥" : "⇧"}</span><CornerDownLeft size={10} aria-hidden="true" /></kbd><span>{running ? "steer" : "new line"}</span></span>
  </span>;
}

function ChatNode({ data, selected, floating = false, scrollPosition }) {
  const { node } = data;
  const { board, invoke, connection, reconnect, reconnecting, update, branch, collapsed, toggleCollapsed, toast, resizeStart, resizeEnd, openFullChat, acknowledgeReply } =
    useCanvas();
  const isCollapsed = !floating && collapsed.has(node.id);
  const messages = node.messages || [];
  const inheritedCount = Math.min(node.inheritedCount || 0, messages.length);
  const inherited = messages.slice(0, inheritedCount);
  const visible = messages.slice(inheritedCount);
  const scroller = useRef(null);
  const shouldFollow = useRef(scrollPosition?.follow ?? true);
  useLayoutEffect(() => {
    if (scroller.current && Number.isFinite(scrollPosition?.top))
      scroller.current.scrollTop = scrollPosition.top;
  }, [scrollPosition]);
  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    if (shouldFollow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lastMessage?.text, messages.length, node.status]);
  return (
    <div
      className={`canvas-card chat-card ${node.kind === "comment" ? "comment-card" : ""} ${selected ? "is-selected" : ""} ${isCollapsed ? "is-collapsed" : ""} ${node.resolved ? "is-resolved" : ""}`}
      data-testid={`card-${node.id}`}
      data-kind={node.kind}
      data-attention={cardAttention(node)}
      aria-description={cardAttentionDescription(node)}
      onPointerDownCapture={() => acknowledgeReply(node.id)}
    >
      {!floating && <CanvasResizeControls
        nodeId={node.id}
        isVisible={!isCollapsed}
        minWidth={360}
        minHeight={400}
        onStart={resizeStart}
        onCommit={resizeEnd}
      />}
      {!floating && <CanvasHandles />}
      {!floating && <header className="card-header card-drag-handle">
        <span
          className={`card-kind-icon ${node.parentId ? "branch-icon" : ""}`}
        >
          {node.kind === "comment" ? (
            <MessageCircle {...iconProps} />
          ) : node.parentId ? (
            <GitBranch {...iconProps} />
          ) : (
            <Mark small />
          )}
        </span>
        <EditableTitle node={node} />
        <Status node={node} />
        <div className="card-header-actions nodrag nopan">
          <IconButton title="Enter conversation full screen" data-testid={`chat-focus-open-${node.id}`} onClick={() => openFullChat(node.id)}><Maximize2 size={14}/></IconButton>
          <IconButton
            title={
              isCollapsed ? "Expand conversation" : "Collapse conversation"
            }
            data-testid={`collapse-${node.id}`}
            onClick={() => toggleCollapsed(node)}
          >
            {isCollapsed ? (
              <ChevronRight size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
          </IconButton>
          <details className="card-menu">
            <summary
              title="Conversation options"
              aria-label="Conversation options"
            >
              <MoreHorizontal size={16} />
            </summary>
            <div className="menu-panel">
              <button
                onClick={() => branch(node.id)}
                disabled={
                  !messages.some(
                    (message) =>
                      message.role === "assistant" &&
                      message.text &&
                      message.turnId &&
                      (!message.status || message.status === "completed") &&
                      node.activeTurnId !== message.turnId,
                  )
                }
              >
                <GitBranch size={14} />
                Branch latest reply
              </button>
              {node.kind === "comment" && (
                <button
                  onClick={() => update(node.id, { resolved: !node.resolved })}
                >
                  <Check size={14} />
                  {node.resolved ? "Reopen question" : "Mark resolved"}
                </button>
              )}
              <button
                onClick={() => {
                  invoke("node/archive", {
                    boardId: board.id,
                    nodeId: node.id,
                  });
                  toast("Card archived", {
                    label: "Undo",
                    onClick: () =>
                      invoke("node/restore", {
                        boardId: board.id,
                        nodeId: node.id,
                      }),
                  });
                }}
              >
                <Archive size={14} />
                Archive card
              </button>
            </div>
          </details>
        </div>
      </header>}
      {!floating && <CardSummary node={node} boardId={board.id} invoke={invoke} />}
      {!isCollapsed && (
        <>
          {node.parentId && (
            <div className="provenance nodrag nopan">
              <Link2 size={11} />
              <span>
                {node.kind === "comment" ? "Side question" : "Branched"} from{" "}
                <button onClick={() => data.navigate(node.parentId)}>
                  {board.nodes.find((item) => item.id === node.parentId)
                    ?.title || "conversation"}
                </button>
                <span className="provenance-dot">·</span>
                {inheritedCount > 0
                  ? "Context frozen at this reply"
                  : board.nodes.find((item) => item.id === node.parentId)
                        ?.kind === "document"
                    ? "Document snapshot"
                    : "Quoted context only"}
              </span>
            </div>
          )}
          {node.quote && (
            <blockquote className="anchor-quote nodrag nopan">
              <MessageCircle size={12} />
              <span>{quotePreview(node.quote)}</span>
            </blockquote>
          )}
          <div
            className="chat-scroll nodrag nopan nowheel"
            ref={scroller}
            onScroll={(event) => {
              const element = event.currentTarget;
              shouldFollow.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                80;
            }}
          >
            {inheritedCount > 0 && (
              <details
                className="inherited-context"
                data-testid={`inherited-${node.id}`}
              >
                <summary>
                  <History size={12} />
                  <span>{inheritedCount} inherited messages</span>
                  <ChevronDown size={12} />
                </summary>
                <div className="inherited-explanation">
                  A snapshot through the reply you branched from. Later messages
                  and other cards are separate.
                </div>
                {inherited.map((message) => (
                  <Message
                    key={message.id}
                    message={message}
                    node={node}
                    inherited
                  />
                ))}
              </details>
            )}
            {!visible.length && !busy(node) && (
              <div className="empty-chat">
                <span className="empty-chat-symbol">
                  {node.kind === "comment" ? (
                    <MessageCircle size={25} strokeWidth={1.2} />
                  ) : node.parentId ? (
                    <GitBranch size={25} strokeWidth={1.2} />
                  ) : (
                    <Mark />
                  )}
                </span>
                <h3>
                  {node.kind === "comment"
                    ? "Follow the thought."
                    : node.parentId
                      ? "A new direction."
                      : "Room to think."}
                </h3>
                <p>
                  {node.kind === "comment"
                    ? "Ask your question below. Codex will answer right here, without adding it to the original conversation."
                    : node.parentId
                      ? "The earlier context is here. Take this conversation wherever you want."
                      : "Talk to your Codex agent. Branch a reply or leave a side question as your ideas unfold."}
                </p>
              </div>
            )}
            {visible.map((message) => (
              <Message key={message.id} message={message} node={node} />
            ))}
            {busy(node) &&
              (!lastMessage || lastMessage.role !== "assistant") && (
                <div className="thinking">
                  <Mark small />
                  <span>
                    {node.status === "awaiting-approval"
                      ? "Waiting for your permission"
                      : "Codex is thinking"}
                    <span className="thinking-ellipsis">…</span>
                  </span>
                </div>
              )}
            <ImageOutputs legacy images={(node.generatedImages || []).filter(image => !(node.messages || []).some(message => (message.images || []).some(attached => attached.itemId ? attached.itemId === image.itemId : attached.id === image.id) || message.text?.includes(image.url)))} />
            <ActivityList node={node} />
            <Approval node={node} />
            <Question node={node} />
            {node.error && (
              <div className="error-box" role="alert">
                <strong>Something interrupted this response</strong>
                <p>{node.error}</p>
                {!connection.connected && <button
                  className="text-button"
                  data-testid={`reconnect-${node.id}`}
                  onClick={reconnect}
                  disabled={reconnecting}
                  aria-busy={reconnecting}
                >
                  <RotateCw size={12} className={reconnecting ? "spin" : undefined} />
                  {reconnecting ? "Connecting…" : "Reconnect Codex"}
                </button>}
              </div>
            )}
          </div>
          <Composer node={node} />
        </>
      )}
      {isCollapsed && (
        <div className="collapsed-preview card-drag-handle">
          {lastMessage?.text?.slice(0, 130) || "A thought waiting to happen."}
        </div>
      )}

      {node.resolved && (
        <span className="resolved-badge">
          <Check size={10} />
          Resolved
        </span>
      )}
    </div>
  );
}

function NoteNode({ data, selected }) {
  const { node } = data;
  const { update, board, invoke, toast, setSelection, resizeStart, resizeEnd } = useCanvas();
  const [text, setText] = useState(node.noteText || "");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div
      className={`canvas-card note-card ${selected ? "is-selected" : ""}`}
      data-testid={`card-${node.id}`}
      data-kind="note"
    >
      <CanvasHandles />
      <CanvasResizeControls
        nodeId={node.id}

        minWidth={260}
        minHeight={180}
        onStart={resizeStart}
        onCommit={resizeEnd}
      />
      <header className="card-header card-drag-handle">
        <StickyNote size={14} />
        <EditableTitle node={node} />
        <IconButton
          title="Archive note"
          className="nodrag"
          onClick={() => {
            invoke("node/archive", { boardId: board.id, nodeId: node.id });
            toast("Note archived", {
              label: "Undo",
              onClick: () =>
                invoke("node/restore", { boardId: board.id, nodeId: node.id }),
            });
          }}
        >
          <X size={13} />
        </IconButton>
      </header>
      <CardSummary node={node} boardId={board.id} invoke={invoke} />
      <textarea
        className="note-editor nodrag nopan nowheel"
        aria-label="Note text"
        data-testid={`note-${node.id}`}
        value={text}
        placeholder="A thought worth keeping…"
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          clearTimeout(timer.current);
          timer.current = setTimeout(
            () => update(node.id, { noteText: value }),
            250,
          );
        }}
        onBlur={() => {
          clearTimeout(timer.current);
          update(node.id, { noteText: text });
        }}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <div className="note-footer">
        <span>Just for you · outside agent context</span>
        <button
          className="note-ask nodrag nopan"
          disabled={!text.trim()}
          data-testid={`ask-note-${node.id}`}
          onClick={async (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            await update(node.id, { noteText: text });
            setSelection({
              nodeId: node.id,
              quote: text,
              x: Math.min(rect.left, window.innerWidth - 365),
              y: Math.min(rect.bottom + 8, window.innerHeight - 280),
              expanded: true,
            });
          }}
        >
          <MessageCircle size={10} />
          Ask Codex
        </button>
      </div>
    </div>
  );
}

function DocumentNode({ data, selected }) {
  const { node } = data;
  const { update, invoke, board, setSelection, toast, state, resizeStart, resizeEnd } = useCanvas();
  const [markdown, setMarkdown] = useState(node.documentMarkdown || "");
  const [editing, setEditing] = useState(!node.documentMarkdown);
  const [saving, setSaving] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [conflict, setConflict] = useState("");
  const timer = useRef(null);
  const latest = useRef(markdown);
  const revision = useRef(node.documentRevision || 1);
  const saved = useRef(node.documentMarkdown || "");
  const savingRef = useRef(false);
  const saveQueue = useRef(Promise.resolve(true));
  latest.current = markdown;
  useEffect(() => {
    if (savingRef.current || (node.documentRevision || 1) === revision.current)
      return;
    if (latest.current !== saved.current) {
      setConflict(
        "Codex updated this document while you were editing. Your draft is safe here. Reload the latest version, or keep your draft in a new document.",
      );
      return;
    }
    revision.current = node.documentRevision || 1;
    saved.current = node.documentMarkdown || "";
    setMarkdown(node.documentMarkdown || "");
  }, [node.documentMarkdown, node.documentRevision]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = (text) => {
    clearTimeout(timer.current);
    saveQueue.current = saveQueue.current.then(async () => {
      if (text === saved.current) return true;
      savingRef.current = true;
      setSaving(true);
      try {
        const result = await window.tangent.invoke("document/save", {
          boardId: board.id,
          nodeId: node.id,
          markdown: text,
          expectedRevision: revision.current,
        });
        revision.current = result.revision;
        saved.current = result.markdown ?? text;
        if (
          latest.current === text &&
          result.markdown !== undefined &&
          result.markdown !== text
        )
          setMarkdown(result.markdown);
        setConflict("");
        return true;
      } catch (error) {
        setConflict(
          error.message ||
            "This version could not be saved. Your draft is still here.",
        );
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    });
    return saveQueue.current;
  };
  const reload = () => {
    clearTimeout(timer.current);
    revision.current = node.documentRevision || 1;
    saved.current = node.documentMarkdown || "";
    setMarkdown(node.documentMarkdown || "");
    setConflict("");
  };
  const ask = async (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (markdown !== saved.current && !(await save(markdown))) return;
    setSelection({
      nodeId: node.id,
      documentId: node.id,
      quote: "",
      x: Math.min(rect.left, window.innerWidth - 365),
      y: Math.min(rect.bottom + 8, window.innerHeight - 280),
      expanded: true,
    });
  };
  return (
    <div
      className={`canvas-card document-card ${selected ? "is-selected" : ""}`}
      data-testid={`card-${node.id}`}
      data-kind="document"
    >
      <CanvasResizeControls
        nodeId={node.id}

        minWidth={400}
        minHeight={350}
        onStart={resizeStart}
        onCommit={resizeEnd}
      />
      <CanvasHandles />
      <header className="card-header card-drag-handle">
        <span className="card-kind-icon document-icon">
          <FileText size={15} />
        </span>
        <EditableTitle node={node} />
        <span className="document-label">Local page</span>
        <IconButton
          className="nodrag"
          title="Archive document"
          onClick={() => {
            invoke("node/archive", { boardId: board.id, nodeId: node.id });
            toast("Document archived", {
              label: "Undo",
              onClick: () =>
                invoke("node/restore", { boardId: board.id, nodeId: node.id }),
            });
          }}
        >
          <X size={14} />
        </IconButton>
      </header>
      <CardSummary node={node} boardId={board.id} invoke={invoke} />
      <div className="document-toolbar nodrag nopan">
        <div className="document-tabs">
          <button
            className={!editing ? "active" : ""}
            data-testid={`document-preview-tab-${node.id}`}
            onClick={async () => {
              if (
                editing &&
                markdown !== saved.current &&
                !(await save(markdown))
              )
                return;
              setEditing(false);
            }}
          >
            Preview
          </button>
          <button
            className={editing ? "active" : ""}
            data-testid={`document-edit-tab-${node.id}`}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        </div>
        <DocumentSaveStatus initial={state.persistence} conflict={conflict} saving={saving}/>
        <button
          className="document-attach"
          data-testid={`document-attach-${node.id}`}
          disabled={attaching}
          onClick={async () => {
            if (markdown !== saved.current && !(await save(markdown))) return;
            setAttaching(true);
            await invoke("document/attach-image", {
              boardId: board.id,
              nodeId: node.id,
            });
            setAttaching(false);
            setEditing(false);
          }}
        >
          {attaching ? (
            <LoaderCircle size={12} className="spin" />
          ) : (
            <Plus size={12} />
          )}
          Image
        </button>
      </div>
      {conflict && (
        <div
          className="document-conflict nodrag nopan"
          role="alert"
          data-testid={`document-conflict-${node.id}`}
        >
          <p>{conflict}</p>
          <div>
            <button onClick={reload}>Reload latest</button>
            <button
              onClick={async () => {
                const copy = await invoke("node/create", {
                  boardId: board.id,
                  kind: "document",
                  title: `${node.title} — my draft`,
                  text: markdown,
                  position: {
                    x: node.position.x + (node.width || 620) + 70,
                    y: node.position.y,
                  },
                });
                if (copy) {
                  reload();
                  data.navigate(copy.id);
                  toast("Your draft was kept in a new document");
                }
              }}
            >
              Keep draft as new document
            </button>
          </div>
        </div>
      )}
      {editing ? (
        <textarea
          className="document-editor nodrag nopan nowheel"
          aria-label="Document Markdown"
          data-testid={`document-editor-${node.id}`}
          spellCheck={false}
          value={markdown}
          placeholder={
            "# A thought worth developing\n\nWrite here, or ask Codex to create something for you.\n\nUse Markdown for headings, lists, code, and images."
          }
          onChange={(event) => {
            const value = event.target.value;
            setMarkdown(value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => save(value), 450);
          }}
          onBlur={() => {
            if (latest.current !== saved.current) save(latest.current);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              save(markdown);
            }
          }}
        />
      ) : (
        <div
          className="document-preview message-text nodrag nopan nowheel"
          data-node-id={node.id}
          data-testid={`document-preview-${node.id}`}
        >
          {markdown ? (
            <Markdown>{markdown}</Markdown>
          ) : (
            <div className="empty-document">
              <FileText size={31} strokeWidth={1.1} />
              <h3>A page for the idea.</h3>
              <p>
                Write something, add an image, or ask your Codex agent to create
                a document.
              </p>
              <button className="text-button" onClick={() => setEditing(true)}>
                Start writing
                <ArrowUpRight size={13} />
              </button>
            </div>
          )}
        </div>
      )}
      <div className="document-footer nodrag nopan">
        <span>
          {markdown.trim().split(/\s+/).filter(Boolean).length} words
          <span className="provenance-dot">·</span>Local page
        </span>
        <button data-testid={`ask-document-${node.id}`} onClick={ask}>
          <MessageCircle size={12} />
          Ask Codex
          <ArrowUpRight size={11} />
        </button>
      </div>
    </div>
  );
}

function HostedPageNode({ data, selected, onExitBrowser }) {
  const { node } = data;
  const flow = useReactFlow();
  const viewport = useViewport();
  const {
    board,
    invoke,
    update,
    setSelection,
    pageStatuses,
    pageOverlayAllowed,
    sidebar,
    resizeStart,
    resizeEnd,
  } = useCanvas();
  const [opened, setOpened] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  const body = useRef(null);
  const status = pageStatuses[node.id] || {};
  const opening = status.state === "loading";
  useEffect(() => {
    if (!body.current) return;
    let frame;
    let disposed = false;
    const layout = () => {
      cancelAnimationFrame(frame);
      const place = () => {
        if (disposed) return;
        const rect = body.current && layoutBounds(body.current);
        const canvasElement = document.querySelector(".canvas-surface");
        const canvas = canvasElement && layoutBounds(canvasElement);
        if (!rect || !canvas) return;
        const header = document.querySelector(".workspace-topbar");
        const clipTop = Math.max(canvas.top, header ? layoutBounds(header).bottom : canvas.top);
        const controls = [...(canvasElement?.querySelectorAll(".canvas-dock, .zoom-control") || [])]
          .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
        const clipBottom = Math.min(canvas.bottom, ...controls.map(element => layoutBounds(element).top));
        const payload = {
          boardId: board.id,
          nodeId: node.id,
          bounds: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
          clipBounds: {
            x: canvas.left,
            y: clipTop,
            width: canvas.width,
            height: Math.max(0, clipBottom - clipTop),
          },
          visible: opened && selected && pageOverlayAllowed,
          zoom: flow.getZoom(),
        };
        const ensure = payload.visible
          ? window.tangent.invoke("page/open", {
              boardId: board.id,
              nodeId: node.id,
            })
          : Promise.resolve();
        ensure
          .then(() => {
            if (!disposed) return window.tangent.invoke("page/layout", payload);
          })
          .catch(() => {});
      };
      place();
      frame = requestAnimationFrame(place);
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(body.current);
    window.addEventListener("resize", layout);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", layout);
    };
  }, [
    board.id,
    node.id,
    node.position.x,
    node.position.y,
    node.width,
    node.height,
    opened,
    selected,
    pageOverlayAllowed,
    sidebar,
    viewport,
    flow,
  ]);
  useEffect(
    () => () => {
      window.tangent
        .invoke("page/close", { boardId: board.id, nodeId: node.id })
        .catch(() => {});
    },
    [board.id, node.id],
  );
  const open = async () => {
    setError("");
    data.navigate(node.id);
    try {
      await window.tangent.invoke("page/open", {
        boardId: board.id,
        nodeId: node.id,
      });
      setOpened(true);
    } catch (error) {
      setOpened(false);
      setError(error.message);
    }
  };
  const ask = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setSelection({
      nodeId: node.id,
      pageNodeId: node.id,
      quote: "",
      expanded: true,
      x: Math.min(rect.left, window.innerWidth - 365),
      y: Math.min(rect.bottom + 8, window.innerHeight - 280),
    });
  };
  return (
    <div
      className={`canvas-card hosted-page-card ${selected ? "is-selected" : ""}`}
      data-testid={`card-${node.id}`}
      data-kind="page"
    >
      <CanvasHandles />
      <CanvasResizeControls
        nodeId={node.id}

        minWidth={700}
        minHeight={600}
        onStart={resizeStart}
        onCommit={resizeEnd}
      />
      <header className="card-header card-drag-handle">
        <Globe size={15} className="hosted-page-icon" />
        <EditableTitle node={node} />
        <span className="hosted-page-label">ChatGPT Page</span>
        <IconButton
          className="nodrag"
          title="Archive Page"
          onClick={() =>
            invoke("node/archive", { boardId: board.id, nodeId: node.id })
          }
        >
          <X size={14} />
        </IconButton>
      </header>
      <CardSummary node={node} boardId={board.id} invoke={invoke} />
      <div className="hosted-page-toolbar nodrag nopan">
        <span>
          <Globe size={11} />
          chatgpt.com
          <span className="hosted-page-url">
            /{node.pageId || node.pageUrl?.split("/").pop()}
          </span>
        </span>
        {onExitBrowser && <button onClick={onExitBrowser}>Native view</button>}
        {opened && selected ? (
          <>
            <button
              disabled={reloading}
              title="Reload this original Page"
              data-testid={`page-reload-${node.id}`}
              onClick={async () => {
                setError("");
                setReloading(true);
                try {
                  await invoke("page/reload", {
                    boardId: board.id,
                    nodeId: node.id,
                  });
                } finally {
                  setReloading(false);
                }
              }}
            >
              <RotateCw
                size={12}
                className={reloading || opening ? "spin" : ""}
              />
              Reload page
            </button>
            <button
              onClick={() => {
                setOpened(false);
                invoke("page/close", { boardId: board.id, nodeId: node.id });
              }}
              data-testid={`page-close-${node.id}`}
            >
              Close view
            </button>
          </>
        ) : (
          <button onClick={open} data-testid={`page-open-${node.id}`}>
            Open page
            <ArrowUpRight size={12} />
          </button>
        )}
      </div>
      <div
        ref={body}
        className="hosted-page-body nodrag nopan nowheel"
        data-testid={`page-body-${node.id}`}
        data-native-visible={
          opened && selected && pageOverlayAllowed ? "true" : "false"
        }
      >
        <div className="hosted-page-placeholder">
          <Globe size={31} strokeWidth={1.2} />
          <h3>
            {error || status.state === "error"
              ? "This Page could not open."
              : status.state === "login"
                ? "Sign in to ChatGPT"
                : status.state === "waiting"
                  ? "Ready when you open the app."
                  : opening && selected
                    ? "Opening your Page…"
                    : opened && selected
                      ? "Your live ChatGPT Page"
                      : "The original Page, on your canvas."}
          </h3>
          <p>
            {error ||
              status.error ||
              (status.state === "login"
                ? "Use the secure ChatGPT sign-in inside this Page. Your existing Page, images, visualizations, and comments stay in ChatGPT."
                : status.state === "waiting"
                  ? "Your Page loads when Tangent is visible, keeping background canvases quiet."
                  : "Open the actual ChatGPT editor here, including its images, visualizations, and comments.")}
          </p>
          {!(opened && selected) && (
            <button className="button primary" onClick={open}>
              Open page
              <ArrowUpRight size={13} />
            </button>
          )}
          {opened && selected && (
            <span className="hosted-page-live-label">
              {opening ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <Globe size={12} />
              )}
              Hosted by ChatGPT
            </span>
          )}
        </div>
      </div>
      <footer className="hosted-page-footer nodrag nopan">
        <span>
          <Globe size={11} />
          {status.state === "login"
            ? "Sign-in required"
            : status.state === "waiting"
              ? "Waiting for app window"
              : status.state === "ready"
                ? "Live ChatGPT Page"
                : "Original hosted editor"}
        </span>
        <button data-testid={`ask-page-${node.id}`} onClick={ask}>
          <MessageCircle size={12} />
          Ask Codex
          <ArrowUpRight size={11} />
        </button>
      </footer>
    </div>
  );
}

function DeleteCanvasDialog({ canvas, canvasCount, close, deleted, motionProps }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const cardCount = canvas.nodes.length;
  const archivedCount = canvas.nodes.filter(node => node.archived).length;
  return <div {...motionProps} className="modal-scrim" onMouseDown={event => {
    if (event.target === event.currentTarget && !pending) close();
  }}>
    <form className="modal delete-canvas-modal" role="dialog" aria-modal="true" aria-labelledby="delete-canvas-title" aria-describedby="delete-canvas-scope" data-testid="delete-canvas-modal"
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); if (!pending) close(); }
      }}
      onSubmit={async event => {
        event.preventDefault();
        if (pending) return;
        setPending(true); setError("");
        try {
          const result = await window.tangent.invoke("board/delete", { boardId: canvas.id, confirmed: true });
          deleted(result);
        } catch (error) { setError(error.message?.replace(/^Error invoking remote method ['"]tangent:invoke['"]: (?:Error: )?/, "") || "This canvas could not be deleted."); }
        finally { setPending(false); }
      }}>
      <span className="delete-canvas-symbol" aria-hidden="true"><Trash2 size={23} /></span>
      <h2 id="delete-canvas-title">Delete “{canvas.title}”?</h2>
      <p className="delete-canvas-count">{cardCount} {cardCount === 1 ? "card" : "cards"}{archivedCount > 0 ? ` · ${archivedCount} archived` : ""}</p>
      <p id="delete-canvas-scope">Removes this canvas and its cards from this Mac. Original Codex chats and linked ChatGPT Pages stay available.</p>
      {canvasCount === 1 && <p className="delete-canvas-replacement">An empty canvas will replace it.</p>}
      {error && <p className="delete-canvas-error" role="alert" data-testid="delete-canvas-error">{error}</p>}
      <div className="delete-canvas-actions">
        <button type="button" className="button" autoFocus data-testid="delete-canvas-cancel" disabled={pending} onClick={close}>Cancel</button>
        <button type="submit" className="button delete-canvas-confirm" data-testid="delete-canvas-confirm" disabled={pending}>{pending ? <><LoaderCircle size={14} className="spin" />Deleting…</> : "Delete canvas"}</button>
      </div>
    </form>
  </div>;
}

function PageLinkDialog({ close, linked, motionProps }) {
  const { board } = useCanvas();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const valid =
    /^https:\/\/chatgpt\.com\/space\/page_[a-zA-Z0-9_-]{8,128}\/?$/.test(
      url.trim(),
    );
  return (
    <div
      {...motionProps}
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        className="modal page-link-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="page-link-title"
        data-testid="page-link-modal"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || pending) return;
          setPending(true);
          setError("");
          try {
            const node = await window.tangent.invoke("page/link", {
              boardId: board.id,
              url: url.trim(),
              title: title.trim() || undefined,
            });
            linked(node);
          } catch (error) {
            setError(error.message);
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="modal-heading">
          <span className="modal-heading-icon">
            <Globe size={21} />
          </span>
          <IconButton title="Close Page link" onClick={close}>
            <X size={17} />
          </IconButton>
        </div>
        <h2 id="page-link-title">Bring the original Page.</h2>
        <p>
          Bring the original Page into your canvas, with its images,
          visualizations, comments, and Codex discussions.
        </p>
        <label className="page-link-field">
          ChatGPT Page link
          <input
            autoFocus
            data-testid="page-link-url"
            aria-label="ChatGPT Page link"
            placeholder="https://chatgpt.com/space/page_…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="page-link-field">
          Title <span>optional</span>
          <input
            data-testid="page-link-title"
            aria-label="Page title"
            placeholder="A name for this Page"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error && (
          <p className="page-link-error" role="alert">
            {error}
          </p>
        )}
        <div className="page-link-actions">
          <span>
            <Globe size={12} />
            Opens here, using ChatGPT
          </span>
          <button
            className="button primary"
            type="submit"
            data-testid="page-link-submit"
            disabled={!valid || pending}
          >
            {pending ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <>
                Add Page
                <ArrowUpRight size={14} />
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

const nodeTypes = {
  conversation: ChatNode,
  note: NoteNode,
  document: DocumentNode,
  page: LinkedPageNode,
};

function LinkedPageNode(props) {
  return (
    <RichPageNode
      {...props}
      canvas={useCanvas()}
      ui={{
        CanvasHandles,
        IconButton,
        EditableTitle,
        Message,
        Approval,
        Question,
        QueuePanel,
        ComposerShortcuts,
      }}
      BrowserPage={HostedPageNode}
    />
  );
}

function SelectionPopover({ selection, close, onSubmit, onBranch, motionProps }) {
  const { board } = useCanvas();
  const pageSideChat = selection.nativePage && selection.action === "side-chat";
  const [pageChatId, setPageChatId] = useState(selection.chatId || "");
  const pageChats = board.nodes.filter(
    (node) => ["chat", "comment"].includes(node.kind) && !node.archived,
  );
  const [question, setQuestion] = useState("");
  const [expanded, setExpanded] = useState(selection.expanded || false);
  const [pending, setPending] = useState(false);
  const input = useRef(null);
  useEffect(() => {
    if (expanded) input.current?.focus();
  }, [expanded]);
  useEffect(() => {
    // The compact actions belong to the live browser selection. Once the user
    // opens a question, its quote and draft have their own lifetime instead.
    if (expanded) return;
    const outside = event => {
      if (!event.target.closest?.('.selection-popover')) close();
    };
    const deselected = () => {
      const current = window.getSelection();
      if (!current?.rangeCount || current.isCollapsed || current.toString().trim().length < 2) close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('selectionchange', deselected);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('selectionchange', deselected);
    };
  }, [expanded, close]);
  return (
    <div
      {...motionProps}
      className={`selection-popover ${expanded ? "expanded" : ""}`}
      style={{
        left: Math.max(12, selection.x),
        top: Math.max(48, selection.y),
      }}
      data-testid="selection-toolbar"
      onMouseDown={(event) => {
        if (
          !["TEXTAREA", "SELECT", "OPTION", "INPUT"].includes(
            event.target.tagName,
          )
        )
          event.preventDefault();
      }}
    >
      {!expanded ? (
        <div className="selection-actions">
          <button
            type="button"
            data-testid="selection-comment"
            onClick={() => setExpanded(true)}
          >
            <MessageCircle size={14} />
            Ask about this
          </button>
          <span />
          <button
            type="button"
            data-testid="selection-branch"
            onClick={onBranch}
          >
            <GitBranch size={14} />
            Branch here
          </button>
          <IconButton title="Dismiss selection" onClick={close}>
            <X size={12} />
          </IconButton>
        </div>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!question.trim() || pending) return;
            setPending(true);
            await onSubmit(
              question.trim(),
              selection.pageNodeId && !pageSideChat ? { chatId: pageChatId || null } : {},
            );
            setPending(false);
          }}
        >
          <div className="popover-title">
            <MessageCircle size={14} />
            <strong>
              {selection.pageNodeId && !pageSideChat
                ? "Ask about this Page"
                : "Ask a side question"}
            </strong>
            <IconButton title="Close side question" onClick={close}>
              <X size={13} />
            </IconButton>
          </div>
          <blockquote>{quotePreview(selection.quote)}</blockquote>
          {selection.pageNodeId && !pageSideChat && (
            <label className="page-comment-target">
              Send to
              <select
                data-testid="page-comment-chat-target"
                aria-label="Comment discussion chat"
                value={pageChatId}
                onChange={(event) => setPageChatId(event.target.value)}
              >
                <option value="">New discussion</option>
                {pageChats.map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <textarea
            ref={input}
            aria-label="Side question"
            data-testid="comment-question"
            rows={3}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What would you like to explore?"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
              }
              if (event.key === "Enter" && !event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey || (pageSideChat && !event.shiftKey))) {
                event.preventDefault();
                event.currentTarget.form.requestSubmit();
              }
            }}
          />
          <div className="popover-footer">
            <span>
              {selection.pageNodeId && !pageSideChat
                ? pageChatId
                  ? "Answers in the selected chat"
                  : "Starts a new discussion on this canvas"
                : "Answers in its own canvas card"}
            </span>
            <button
              className="button primary compact"
              type="submit"
              data-testid="submit-comment"
              disabled={!question.trim() || pending}
            >
              {pending ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <>
                  Ask Codex
                  <ArrowUpRight size={13} />
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ImportDialog({ close, imported, motionProps }) {
  const { invoke, board } = useCanvas();
  const [search, setSearch] = useState("");
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(
      async () => {
        setLoading(true);
        setError("");
        try {
          const result = await window.tangent.invoke("codex/threads", {
            search,
          });
          if (!disposed) setThreads(result.threads || []);
        } catch (error) {
          if (!disposed) setError(error.message);
        } finally {
          if (!disposed) setLoading(false);
        }
      },
      search ? 220 : 0,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [search]);
  return (
    <div
      {...motionProps}
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="modal import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        data-testid="import-modal"
      >
        <div className="modal-heading">
          <div className="modal-heading-icon">
            <History size={21} />
          </div>
          <IconButton title="Close import" onClick={close}>
            <X size={17} />
          </IconButton>
        </div>
        <h2 id="import-title">Bring a conversation along.</h2>
        <p>
          Your Codex history, with room to branch. Importing makes a separate
          copy; the original stays as you left it.
        </p>
        <div className="search-field">
          <Search size={16} />
          <input
            autoFocus
            aria-label="Search Codex conversations"
            data-testid="import-search"
            placeholder="Search your Codex conversations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd>⌘ K</kbd>
        </div>
        <div className="import-list">
          {loading ? (
            <div className="modal-empty">
              <LoaderCircle size={20} className="spin" />
              <span>Finding your conversations…</span>
            </div>
          ) : error ? (
            <div className="modal-empty error-status">{error}</div>
          ) : threads.length ? (
            threads.map((thread) => (
              <button
                key={thread.id}
                className="import-thread"
                data-testid={`import-thread-${thread.id}`}
                disabled={!!pending}
                onClick={async () => {
                  setPending(thread.id);
                  try {
                    const node = await invoke("codex/import", {
                      boardId: board.id,
                      threadId: thread.id,
                    });
                    if (node) imported(node);
                  } finally {
                    setPending(null);
                  }
                }}
              >
                <span className="import-thread-icon">
                  {pending === thread.id ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <MessageCircle size={16} />
                  )}
                </span>
                <span>
                  <strong>
                    {thread.title ||
                      thread.preview?.slice(0, 70) ||
                      "Untitled conversation"}
                  </strong>
                  <small>
                    {thread.preview || thread.cwd || "Codex conversation"}
                  </small>
                </span>
                <span className="import-date">
                  {timeLabel(thread.updatedAt)}
                </span>
                <ArrowUpRight size={15} className="import-arrow" />
              </button>
            ))
          ) : (
            <div className="modal-empty">
              <MessageCircle size={22} />
              <span>
                {search
                  ? "No matching conversations."
                  : "No Codex conversations found yet."}
              </span>
            </div>
          )}
        </div>
        <div className="modal-footnote">
          <ShieldCheck size={13} />
          Your original threads are never resumed or changed.
        </div>
      </section>
    </div>
  );
}

function HelpDialog({ close, motionProps }) {
  return (
    <div
      {...motionProps}
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="modal help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
      >
        <div className="modal-heading">
          <Mark />
          <IconButton title="Close guide" onClick={close}>
            <X size={17} />
          </IconButton>
        </div>
        <h2 id="help-title">One canvas. Many directions.</h2>
        <p>
          Work with your Codex agent without making every rabbit hole part of
          the main conversation.
        </p>
        <div className="help-row">
          <GitBranch size={19} />
          <div>
            <strong>Branch at any reply</strong>
            <p>
              Hover over a Codex reply and choose Branch here. The new card gets
              a snapshot of the conversation through that reply.
            </p>
          </div>
        </div>
        <div className="help-row">
          <MessageCircle size={19} />
          <div>
            <strong>Leave a question, get an answer</strong>
            <p>
              Select text in a reply and choose Ask about this. Codex responds
              in a separate comment card, on the same canvas.
            </p>
          </div>
        </div>
        <div className="help-row">
          <FileText size={19} />
          <div>
            <strong>Keep the work beside the conversation</strong>
            <p>
              Create a document, attach images, and ask Codex about a passage.
              Your agent can create and update documents in the same canvas.
            </p>
          </div>
        </div>
        <div className="help-row">
          <Link2 size={19} />
          <div>
            <strong>Connections show where ideas came from</strong>
            <p>
              Later parent messages and neighboring cards never enter another
              chat’s context. Notes stay outside agent context too.
            </p>
          </div>
        </div>
        <div className="shortcut-list">
          <span>
            New conversation<kbd>⌘ N</kbd>
          </span>
          <span>
            Find a card<kbd>⌘ K</kbd>
          </span>
          <span>
            Send message<kbd>↵</kbd>
          </span>
          <span>
            New line<kbd>⇧ ↵</kbd>
          </span>
          <span>
            Pan canvas<kbd>Scroll</kbd>
          </span>
          <span>
            Zoom<kbd>Pinch / ⌘ Scroll</kbd>
          </span>
        </div>
      </section>
    </div>
  );
}

function SearchDialog({ close, navigate, motionProps }) {
  const { board } = useCanvas();
  const [search, setSearch] = useState("");
  const results = board.nodes.filter(
    (node) =>
      !node.archived &&
      `${node.title} ${node.noteText || ""} ${node.documentMarkdown || ""} ${node.pageUrl || ""} ${(node.messages || []).map((message) => message.text).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div
      {...motionProps}
      className="modal-scrim search-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="modal search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Find a card"
      >
        <div className="search-field">
          <Search size={18} />
          <input
            autoFocus
            aria-label="Find a card"
            placeholder="Find a thought on this canvas…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="search-results">
          {results.length ? (
            results.map((node) => (
              <button
                key={node.id}
                onClick={() => {
                  navigate(node.id);
                  close();
                }}
              >
                <span className={`search-result-icon ${node.kind}`}>
                  {node.kind === "note" ? (
                    <StickyNote size={16} />
                  ) : node.kind === "page" ? (
                    <Globe size={16} />
                  ) : node.kind === "document" ? (
                    <FileText size={16} />
                  ) : node.kind === "comment" ? (
                    <MessageCircle size={16} />
                  ) : (
                    <GitBranch size={16} />
                  )}
                </span>
                <span>
                  <strong>{node.title}</strong>
                  <small>
                    {node.kind === "note"
                      ? node.noteText
                      : node.kind === "document"
                        ? node.documentMarkdown
                        : node.messages?.[node.messages.length - 1]?.text ||
                          "Empty conversation"}
                  </small>
                </span>
                <CornerDownLeft size={14} />
              </button>
            ))
          ) : (
            <div className="modal-empty">No matching cards.</div>
          )}
        </div>
      </section>
    </div>
  );
}

// Floating views are separate from durable canvas card geometry. Keep each
// conversation's view around when another opens, including its closed position.
function floatingChatViews(page) {
  if (page?.views) return page.views;
  // Preserve the old single-view shape during an in-session update.
  return page?.nodeId ? { [page.nodeId]: {
    open: !!page.open, minimized: !!page.minimized,
    geometry: page.geometry, order: 1,
  } } : {};
}

const zoomPercentage = (state) => Math.round(state.transform[2] * 100);

// Camera motion stays in React Flow. Only this small control subscribes to its
// display value; moving the camera must not invalidate conversation context.
function CanvasZoomControls() {
  const flow = useReactFlow();
  const zoom = useStore(zoomPercentage);
  return (
    <div className="zoom-control">
      <IconButton title="Zoom out" data-testid="zoom-out" onClick={() => flow.zoomOut({ duration: motionDuration(150) })}>
        <ZoomOut size={14} />
      </IconButton>
      <button title="Reset zoom" className="zoom-percentage" onClick={() => flow.zoomTo(1, { duration: motionDuration(150) })}>
        {zoom}%
      </button>
      <IconButton title="Zoom in" data-testid="zoom-in" onClick={() => flow.zoomIn({ duration: motionDuration(150) })}>
        <ZoomIn size={14} />
      </IconButton>
    </div>
  );
}

function CanvasApp() {
  const flow = useReactFlow();
  useMotionEnvironment();
  const [state, setState] = useState(null);
  const [connection, setConnection] = useState({ connected: false });
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectOperation = useRef(null);
  const [ready, setReady] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [collapsed, setCollapsed] = useState(new Set());
  const [modal, setModalState] = useState(null);
  const modalLogical = useRef(null);
  const modalReturnFocus = useRef(null);
  const setModal = useCallback(value => {
    const next = typeof value === "function" ? value(modalLogical.current) : value;
    // Capture before the dialog's autoFocus commit, and retain the same origin
    // when changing dialog types or reopening during a retained visual exit.
    if (next && !modalLogical.current && !modalReturnFocus.current)
      modalReturnFocus.current = document.activeElement;
    modalLogical.current = next;
    setModalState(next);
  }, []);
  const [deleteCanvasId, setDeleteCanvasId] = useState(null);
  const [renamingCanvas, setRenamingCanvas] = useState(null);
  const renameCancelled = useRef(false);
  const [selection, setSelection] = useState(null);
  const [findOpen,setFindOpen] = useState(false);
  const [findRequest,setFindRequest] = useState(0);
  const [findCanvasScope,setFindCanvasScope] = useState(false);
  const searchNavigation = useRef(0);
  const [focusPageId, setFocusPageId] = useState(null);
  const [pageSideChats, setPageSideChats] = useState({});
  const floatingOwnerRef = useRef(null);
  const [chatFocus, setChatFocus] = useState(null);
  const chatFocusRef = useRef(null);
  const chatDrafts = useRef(new Map());
  const chatDraftRevisions = useRef(new Map());
  const chatDraftListeners = useRef(new Map());
  const setChatDraft=useCallback((nodeId,value,{edit=false}={})=>{
    if(edit)chatDraftRevisions.current.set(nodeId,(chatDraftRevisions.current.get(nodeId)||0)+1);
    chatDrafts.current.set(nodeId,value);
    chatDraftListeners.current.get(nodeId)?.forEach(receive=>receive(value));
  },[]);
  const focusPageRef = useRef(null);
  const selectionRef = useRef(null);
  selectionRef.current = selection;
  const focusViewport = useRef(null);
  const navigationEpoch = useRef(0);
  const [toastMessage, setToastMessage] = useState(null);
  const [showMap, setShowMap] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const connectionButton = useRef(null);
  const [connectionAnchor, setConnectionAnchor] = useState({ top: 64, right: 24 });
  const [nativeDialogOpen, setNativeDialogOpen] = useState(false);
  const readerOverlays = useRef(new Set());
  const [readerOverlayVisible, setReaderOverlayVisible] = useState(false);
  const reportReaderPresence = useCallback((nodeId, visible) => {
    if (visible) readerOverlays.current.add(nodeId);
    else readerOverlays.current.delete(nodeId);
    setReaderOverlayVisible(readerOverlays.current.size > 0);
  }, []);
  const [pageStatuses, setPageStatuses] = useState({});
  const [fatalError, setFatalError] = useState("");
  const toastTimer = useRef(null);
  const dragging = useRef(new Set());
  const resizing = useRef(new Map());
  const initializedBoard = useRef(null);
  const flowReady = useRef(false);
  const board =
    state?.boards.find((item) => item.id === state.activeBoardId) ||
    state?.boards[0];
  const fullChatNode = chatFocus?.boardId === board?.id
    ? board?.nodes.find(node => node.id === chatFocus.nodeId && !node.archived && ["chat", "comment"].includes(node.kind)) : null;
  chatFocusRef.current = fullChatNode ? chatFocus : null;
  const pageViewMode = board?.nodes.find(node => node.id === focusPageId)?.pageView === "full" ? "full" : "half";
  const sideChatOwnerId = fullChatNode ? `chat:${fullChatNode.id}` : focusPageId;
  floatingOwnerRef.current = sideChatOwnerId;
  const sideChatKey = board && sideChatOwnerId ? `${board.id}:${sideChatOwnerId}` : null;
  const sideChatView = sideChatKey ? pageSideChats[sideChatKey] : null;
  const sideChatViews = floatingChatViews(sideChatView);
  const sideChatHistory = [...new Set([...(sideChatView?.history || []), ...Object.keys(sideChatViews)])]
    .map(id => board?.nodes.find(node => node.id === id && !node.archived && ["chat", "comment"].includes(node.kind))).filter(Boolean);
  const activeFloatingIds = useMemo(() => new Set(
    sideChatHistory.filter(node => sideChatViews[node.id]?.open).map(node => node.id),
  ), [board, sideChatView]);
  const hiddenConversationIds = useMemo(() => new Set([
    ...activeFloatingIds, ...(fullChatNode ? [fullChatNode.id] : []),
  ]), [activeFloatingIds, fullChatNode?.id]);
  const sideChatStack = sideChatHistory.filter(node => sideChatViews[node.id]?.open)
    .sort((a, b) => (sideChatViews[a.id]?.order || 0) - (sideChatViews[b.id]?.order || 0)).map(node => node.id);
  const screenSearchScope = useMemo(() => findOpen ? buildScreenSearchScope({
    board,
    fullChatId: fullChatNode?.id ?? null,
    pageId: findCanvasScope ? null : focusPageId,
    pageView: pageViewMode,
    floating: sideChatHistory.filter(node => sideChatViews[node.id]?.open && node.id !== fullChatNode?.id)
      .map(node => ({nodeId:node.id,minimized:!!sideChatViews[node.id].minimized})),
    discussionChatId: board?.nodes.find(node => node.id === focusPageId)?.targetChatId,
  }) : {label:'Canvas',items:[]}, [findOpen,findCanvasScope,board,fullChatNode?.id,focusPageId,pageViewMode,sideChatView]);
  const connectionMotion = useMotionPresence(connectionOpen, { origin: "top right" });
  const selectionMotion = useMotionPresence(selection && (!selection.nativePage || selection.action === "side-chat") ? selection : null, {
    origin: "top left", identity: selection ? `${selection.nodeId}-${selection.messageId}-${selection.quote}` : "",
  });
  const modalMotion = useMotionPresence(modal ? {
    kind: modal,
    canvas: state?.boards.find(item => item.id === deleteCanvasId),
    canvasCount: state?.boards.length,
  } : null, { kind: "dialog", identity: modal || "" });
  const toastMotion = useMotionPresence(toastMessage, { kind: "toast" });
  const sidebarMotion = useMotionPresence(sidebar, { kind: "sidebar", initial: "settled" });
  const layoutMotionActive = useLayoutMotion([ready, sidebar, focusPageId, pageViewMode]);
  const displayedSelection = selectionMotion.value;
  const displayedModal = modalMotion.value;
  const displayedToast = toastMotion.value;
  const boardRef = useRef(board);
  boardRef.current = board;
  const toast = useCallback((message, action) => {
    clearTimeout(toastTimer.current);
    setToastMessage({ message, action });
    toastTimer.current = setTimeout(() => setToastMessage(null), 5000);
  }, []);
  const invoke = useCallback(
    async (command, payload = {}) => {
      const nativeDialog = [
        "project/choose",
        "app/export",
        "document/attach-image",
      ].includes(command);
      if (nativeDialog) setNativeDialogOpen(true);
      try {
        return await window.tangent.invoke(command, payload);
      } catch (error) {
        toast(error.message || "That action could not be completed.");
        return null;
      } finally {
        if (nativeDialog) setNativeDialogOpen(false);
      }
    },
    [toast],
  );
  const reconnect = useCallback(() => {
    if (reconnectOperation.current) return reconnectOperation.current;
    if (connection.connected) return Promise.resolve(connection);
    setReconnecting(true);
    const operation = Promise.resolve()
      .then(() => window.tangent.invoke("app/reconnect"))
      .then(next => {
        if (!next?.connected) throw new Error(next?.error || "Could not connect to Codex. Try again.");
        setConnection(next);
        return next;
      })
      .catch(error => {
        const message = deliveryErrorText(error.message || "Could not connect to Codex. Try again.");
        setConnection(previous => ({ ...previous, connected: false, error: message }));
        toast(message);
        return null;
      })
      .finally(() => {
        if (reconnectOperation.current === operation) reconnectOperation.current = null;
        setReconnecting(false);
      });
    reconnectOperation.current = operation;
    return operation;
  }, [connection, toast]);
  const update = useCallback(
    (nodeId, fields) =>
      invoke("node/update", {
        boardId: boardRef.current?.id,
        nodeId,
        ...fields,
      }),
    [invoke],
  );
  const openScreenSearch = useCallback(() => {
    setFindOpen(true);setFindRequest(value=>value+1);setConnectionOpen(false);
    const currentPage=boardRef.current?.nodes.find(node=>node.id===focusPageRef.current);
    setFindCanvasScope(!chatFocusRef.current&&(!currentPage||currentPage.pageView!=='full'));
    if(document.querySelector('.selection-popover:not(.expanded)'))setSelection(null);
  },[]);
  const closeScreenSearch = useCallback(() => {searchNavigation.current++;setFindOpen(false);},[]);
  const acknowledgingReplies = useRef(new Set());
  const acknowledgeReply = useCallback(nodeId => {
    const currentBoard=boardRef.current;
    const node=currentBoard?.nodes.find(node=>node.id===nodeId);
    if(!node?.hasUnreadReply || acknowledgingReplies.current.has(nodeId))return;
    acknowledgingReplies.current.add(nodeId);
    invoke('node/update',{boardId:currentBoard.id,nodeId,hasUnreadReply:false,expectedReplyTurnId:node.lastReplyNoticeTurnId})
      .finally(()=>acknowledgingReplies.current.delete(nodeId));
  },[invoke]);
  const resizeStart = useCallback((nodeId) => {
    resizing.current.set(nodeId, boardRef.current?.id);
  }, []);
  const resizeEnd = useCallback(async (nodeId, geometry) => {
    const boardId = resizing.current.get(nodeId);
    if (!boardId) return;
    const result = await invoke("node/update", { boardId, nodeId, ...geometry });
    resizing.current.delete(nodeId);
    if (result === null && boardRef.current?.id === boardId) {
      // A failed save restores the durable geometry instead of claiming success.
      const saved = boardRef.current.nodes.find(item => item.id === nodeId);
      if (saved) setNodes(previous => previous.map(item => item.id === nodeId
        ? { ...item, position: saved.position, width: saved.width, height: saved.height,
            style: { ...item.style, width: saved.width, height: saved.height } }
        : item));
    }
  }, [invoke]);
  const toggleCollapsed = useCallback(
    (node) => {
      const nextValue = !node.collapsed;
      update(node.id, { collapsed: nextValue });
    },
    [update],
  );
  const openFullChat = useCallback(nodeId => {
    const board = boardRef.current;
    if (!board?.nodes.some(node => node.id === nodeId && !node.archived && ["chat", "comment"].includes(node.kind))) return;
    const previous = chatFocusRef.current;
    if (previous?.boardId === board.id && previous.nodeId === nodeId) return;
    setFindCanvasScope(false);
    const scroller = document.querySelector('.chat-fullscreen > .chat-focus-column > .canvas-card .chat-scroll');
    const returnTo = previous && scroller ? { ...previous, scrollPosition: {
      top: scroller.scrollTop,
      follow: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80,
    } } : previous;
    const focus = { boardId: board.id, nodeId, ...(previous?.boardId === board.id ? { returnTo } : {}) };
    chatFocusRef.current = focus;
    setChatFocus(focus);
    setSelection(null);
    setConnectionOpen(false);
  }, []);
  const closeFullChat = useCallback(() => {
    const current = chatFocusRef.current;
    const nodeId = current?.nodeId;
    const previous = current?.returnTo;
    const restored = previous?.boardId === boardRef.current?.id && boardRef.current.nodes.some(node => node.id === previous.nodeId && !node.archived && ["chat", "comment"].includes(node.kind))
      ? previous : null;
    chatFocusRef.current = restored;
    setChatFocus(restored);
    setSelection(null);
    requestAnimationFrame(() => {
      const controls = [...document.querySelectorAll(`[data-testid="floating-chat-fullscreen-${nodeId}"], [data-testid="chat-focus-open-${nodeId}"]`)];
      controls.find(element => element.getClientRects().length && !element.closest('[hidden], [inert]'))?.focus({ preventScroll: true });
    });
  }, []);
  const openPage = useCallback((nodeId,{forSearch=false}={}) => {
    if(!forSearch)setFindCanvasScope(false);
    chatFocusRef.current = null;
    setChatFocus(null);
    navigationEpoch.current++;
    if (focusPageRef.current && focusPageRef.current !== nodeId) setSelection(null);
    if (!focusPageRef.current) focusViewport.current = flow.getViewport();
    focusPageRef.current = nodeId;
    setFocusPageId(nodeId);
    setConnectionOpen(false);
  }, [flow]);
  const closePage = useCallback(() => {
    const intent = ++navigationEpoch.current;
    const savedViewport = focusViewport.current;
    focusPageRef.current = null;
    setFocusPageId(null);
    setSelection(null);
    focusViewport.current = null;
    // Restore after the full canvas width and React Flow's observer agree.
    if (savedViewport) afterCanvasLayout(() => {
      if (navigationEpoch.current === intent)
        flow.setViewport(savedViewport, { duration: 0 });
    });
  }, [flow]);
  const navigateSearchMatch = useCallback(async hit => {
    const epoch=++searchNavigation.current,currentBoard=boardRef.current;
    const node=currentBoard?.nodes.find(node=>node.id===hit.nodeId&&!node.archived);
    if(!node)return;
    const source=screenSearchSource(hit);
    if(hit.kind==='page-comment')source?.closest('.original-comment')?.click();
    const shownOverlay=!!source?.closest('.floating-side-chat,.page-discussion-panel,.chat-fullscreen,.page-reader-shell,.page-floating-toolbar,.chat-focus-toolbar');
    const alreadyFocused=focusPageRef.current===node.id||chatFocusRef.current?.nodeId===node.id;
    if(node.kind==='page'&&hit.kind!=='title') {
      if(focusPageRef.current!==node.id)openPage(node.id,{forSearch:true});
    } else if(!alreadyFocused&&!shownOverlay) {
      // A Page revealed by a canvas result must not consume the search scope.
      // Fit into the exposed half-view canvas. If its discussion covers that
      // space too, return to the canvas so the result is actually on screen.
      const exposedCanvas=()=>{
        const canvas=document.querySelector('.canvas-surface')?.getBoundingClientRect();
        if(!canvas)return null;
        const panels=[...document.querySelectorAll('.page-reader-shell:not([hidden]),.page-reader-shell:not([hidden]) .page-discussion-panel')];
        const right=panels.reduce((edge,panel)=>Math.min(edge,panel.getBoundingClientRect().left),canvas.right);
        return {...canvas,width:Math.max(0,right-canvas.left),height:canvas.height};
      };
      const exposed=exposedCanvas();
      if(findCanvasScope&&focusPageRef.current&&((exposed?.width||0)<220||boardRef.current?.nodes.find(item=>item.id===focusPageRef.current)?.pageView==='full')){
        closePage();navigationEpoch.current++;
        await new Promise(resolve=>afterCanvasLayout(resolve));
        if(searchNavigation.current!==epoch)return;
      }
      if(node.collapsed&&hit.kind!=='title')await invoke('node/update',{boardId:currentBoard.id,nodeId:node.id,collapsed:false});
      if(searchNavigation.current!==epoch)return;
      const canvas=focusPageRef.current?exposedCanvas():document.querySelector('.canvas-surface')?.getBoundingClientRect();
      if(canvas){
        const width=node.width||(node.kind==='note'?300:440),height=node.height||(node.kind==='note'?240:620);
        const zoom=Math.max(.2,Math.min(flow.getZoom(),(canvas.width-48)/width,(canvas.height-80)/height));
        flow.setViewport({x:canvas.width/2-(node.position.x+width/2)*zoom,y:canvas.height/2-(node.position.y+height/2)*zoom,zoom},{duration:0});
      }
    }
    // Rendering an expanded card and its inherited context can take a frame.
    for(let frame=0;frame<12&&searchNavigation.current===epoch;frame++){
      if(hit.messageId){
        document.querySelectorAll(`[data-message-id="${CSS.escape(hit.messageId)}"][data-node-id="${CSS.escape(node.id)}"]`)
          .forEach(element=>{const details=element.closest('details');if(details)details.open=true;});
      }
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
  },[flow,invoke,openPage,closePage,findCanvasScope]);
  const fitCanvas = useCallback(() => {
    const canvas = document.querySelector(".canvas-surface")?.getBoundingClientRect();
    const visible = flow.getNodes().filter(node => !node.hidden);
    if (!canvas || !visible.length) return;
    const bounds = flow.getNodesBounds(visible);
    // fitView() queues a later node update. Apply the calculated viewport now
    // so a subsequent Actual Size action cannot be overwritten by that queue.
    return flow.setViewport(getViewportForBounds(bounds, canvas.width, canvas.height, 0.2, 1, 0.18), { duration: 0 });
  }, [flow]);
  const navigate = useCallback(
    (nodeId, options = {}) => {
      chatFocusRef.current = null;
      setChatFocus(null);
      navigationEpoch.current++;
      const node = boardRef.current?.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      if (node.kind === "page" && !options.canvas) {
        openPage(nodeId);
        setNodes((previous) => previous.map((item) => ({ ...item, selected: item.id === nodeId })));
        return;
      }
      const focusedPage = boardRef.current?.nodes.find(item => item.id === focusPageRef.current);
      const keepHalfPage = !!focusedPage && focusedPage.pageView !== "full" && !options.canvas;
      const closingPage = !!focusPageRef.current && !keepHalfPage;
      if (closingPage) closePage();
      const intent = ++navigationEpoch.current;
      setNodes((previous) =>
        previous.map((item) => ({ ...item, selected: item.id === nodeId })),
      );
      const center = () => {
        if (navigationEpoch.current !== intent) return;
        const canvas = document.querySelector(".canvas-surface")?.getBoundingClientRect();
        if (!canvas) return;
        const width = node.width || (node.kind === "note" ? 300 : 440);
        const height = node.height || (node.kind === "note" ? 240 : 620);
        const fitCard = node.kind === "page" || keepHalfPage;
        const zoom = fitCard
          ? Math.max(0.2, Math.min(1, flow.getZoom(), (canvas.width - 36) / width, (canvas.height - 180) / height))
          : Math.min(1, Math.max(flow.getZoom(), 0.75));
        // Use the actual visible pane, including its new split width. This also
        // covers a click arriving before React Flow's ResizeObserver callback.
        flow.setViewport({
          x: canvas.width / 2 - (node.position.x + width / 2) * zoom,
          y: canvas.height / 2 - (node.position.y + height / 2) * zoom,
          zoom,
        }, { duration: options.canvas || keepHalfPage ? 0 : motionDuration() });
      };
      if (closingPage) afterCanvasLayout(center);
      else center();
    },
    [flow, openPage, closePage],
  );
  const openFloatingChat = useCallback((nodeId, ownerId = floatingOwnerRef.current) => {
    const boardId = boardRef.current?.id;
    if (!boardId || !ownerId) return;
    const key = `${boardId}:${ownerId}`;
    if (!ownerId.startsWith('chat:')) {
      chatFocusRef.current = null;
      setChatFocus(null);
    }
    setPageSideChats(previous => {
      const page = previous[key] || {};
      const views = floatingChatViews(page);
      const history = page.history || [];
      const order = Math.max(0, ...Object.values(views).map(view => view.order || 0)) + 1;
      return { ...previous, [key]: { history: history.includes(nodeId) ? history : [...history, nodeId],
        views: { ...views, [nodeId]: { ...views[nodeId], open: true, dismissed: false, minimized: false, order } } } };
    });
    setSelection(null);
  }, []);
  const updateFloatingChat = useCallback((nodeId, fields) => {
    const key = `${boardRef.current?.id}:${floatingOwnerRef.current}`;
    setPageSideChats(previous => {
      const page = previous[key];
      const views = floatingChatViews(page);
      if (!page || !views[nodeId]) return previous;
      return { ...previous, [key]: { ...page, views: { ...views, [nodeId]: { ...views[nodeId], ...fields } } } };
    });
  }, []);
  const activateFloatingChat = useCallback(nodeId => {
    const key = `${boardRef.current?.id}:${floatingOwnerRef.current}`;
    setPageSideChats(previous => {
      const page = previous[key];
      const views = floatingChatViews(page);
      if (!page || !views[nodeId]?.open) return previous;
      const order = Math.max(0, ...Object.values(views).map(view => view.order || 0));
      if (views[nodeId].order === order) return previous;
      return { ...previous, [key]: { ...page, views: { ...views, [nodeId]: { ...views[nodeId], order: order + 1 } } } };
    });
  }, []);
  const branch = useCallback(
    async (nodeId, messageId, fields = {}) => {
      const originPageId = focusPageRef.current;
      const originFullChat = chatFocusRef.current;
      const originBoardId = boardRef.current?.id;
      const node = await invoke("node/branch", {
        boardId: boardRef.current?.id,
        nodeId,
        messageId,
        ...fields,
      });
      if (node) {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
        if (originFullChat && chatFocusRef.current?.nodeId === originFullChat.nodeId && boardRef.current?.id === originBoardId)
          openFloatingChat(node.id, `chat:${originFullChat.nodeId}`);
        else if (originPageId && focusPageRef.current === originPageId && boardRef.current?.id === originBoardId)
          openFloatingChat(node.id, originPageId);
        else setTimeout(() => navigate(node.id), 80);
        toast(
          fields.kind === "comment"
            ? "Side question started in its own context"
            : "Branch created from this reply",
        );
      }
      return node;
    },
    [invoke, navigate, toast, openFloatingChat],
  );

  useEffect(() => {
    if (!window.tangent) {
      setFatalError(
        "Tangent’s desktop connection is unavailable. Open this app from the installed desktop application.",
      );
      return;
    }
    let active = true;
    const stopDraftFlush=window.tangent.onFlushDrafts?.(flushPendingDrafts);
    const unsubscribe = window.tangent.subscribe((event) => {
      if (!active) return;
      if (event.type === "state") {
        setState(event.state);
        setReady(true);
      }
      if (event.type === "connection") setConnection(event.connection);
      if (event.type === "page/status")
        setPageStatuses((previous) => ({
          ...previous,
          [event.nodeId]: event.status,
        }));
    });
    Promise.all([
      window.tangent.invoke("app/state"),
      window.tangent.invoke("app/connection"),
    ])
      .then(([state, connection]) => {
        if (active) {
          setState(state);
          setConnection(connection);
          setReady(true);
        }
      })
      .catch((error) => {
        if (active) setFatalError(error.message);
      });
    return () => {
      active = false;
      unsubscribe();
      stopDraftFlush?.();
      clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(
    () =>
      window.tangent?.onAction?.((action) => {
        setMotionInput("keyboard");
        if(action==='find'){openScreenSearch();return;}
        if(action==='find-next'||action==='find-previous'){
          window.dispatchEvent(new CustomEvent('tangent:find-step',{detail:action==='find-next'?1:-1}));return;
        }
        if (action === "fit") {
          // Fit explicitly chooses the canvas, so its saved return viewport
          // must not race the new fitted viewport.
          focusViewport.current = null;
          closePage();
          const intent = navigationEpoch.current;
          afterCanvasLayout(() => {
            if (navigationEpoch.current === intent)
              fitCanvas();
          });
          return;
        }
        const zoomAction = action.replace(/^page-/, "");
        if (focusPageRef.current && ["zoom-in", "zoom-out", "zoom-reset"].includes(zoomAction)) {
          window.dispatchEvent(new CustomEvent("tangent:page-view-action", { detail: `page-${zoomAction}` }));
          return;
        }
        if (["zoom-in", "zoom-out", "zoom-reset"].includes(zoomAction)) navigationEpoch.current++;
        if (zoomAction === "zoom-in") flow.zoomIn({ duration: 0 });
        if (zoomAction === "zoom-out") flow.zoomOut({ duration: 0 });
        if (zoomAction === "zoom-reset") flow.zoomTo(1, { duration: 0 });
        if (action === "export")
          invoke("app/export", { boardId: boardRef.current?.id });
      }),
    [flow, invoke, closePage, fitCanvas,openScreenSearch],
  );
  useEffect(() => {
    if (!connectionOpen) return;
    const position = () => {
      const rect = connectionButton.current?.getBoundingClientRect();
      if (rect) setConnectionAnchor({ top: rect.bottom + 8, right: Math.max(12, window.innerWidth - rect.right) });
    };
    position();
    const observer = new ResizeObserver(position);
    if (connectionButton.current) observer.observe(connectionButton.current);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [connectionOpen, sidebar]);
  useEffect(() => {
    if (!board) return;
    const persistedCollapsed = new Set(
      board.nodes.filter((node) => node.collapsed).map((node) => node.id),
    );
    if (
      persistedCollapsed.size !== collapsed.size ||
      [...persistedCollapsed].some((id) => !collapsed.has(id))
    )
      setCollapsed(persistedCollapsed);
    setNodes((previous) =>
      board.nodes
        .filter((node) => !node.archived)
        .map((node) => {
          const existing = previous.find((item) => item.id === node.id);
          const isResizing = existing && resizing.current.get(node.id) === board.id;
          return {
            ...(isResizing ? existing : {}),
            id: node.id,
            hidden: hiddenConversationIds.has(node.id),
            type:
              node.kind === "note"
                ? "note"
                : node.kind === "document"
                  ? "document"
                  : node.kind === "page"
                    ? "page"
                    : "conversation",
            position:
              (dragging.current.has(node.id) || isResizing) && existing
                ? existing.position
                : node.position,
            data: { node, navigate },
            dragHandle: ".card-drag-handle",
            className: collapsed.has(node.id) ? "collapsed-node" : "",
            style: isResizing ? existing.style : {
              width:
                node.width ||
                (node.kind === "note"
                  ? 300
                  : node.kind === "document"
                    ? 620
                    : node.kind === "page"
                      ? 760
                      : 440),
              height: collapsed.has(node.id)
                ? 115
                : node.height ||
                  (node.kind === "note"
                    ? 240
                    : node.kind === "document"
                      ? 680
                      : node.kind === "page"
                        ? 880
                        : 620),
            },
            selected: existing?.selected || false,
          };
        }),
    );
    if (initializedBoard.current !== board.id && flowReady.current) {
      initializedBoard.current = board.id;
      chatFocusRef.current = null;
      setChatFocus(null);
      focusPageRef.current = null;
      setFocusPageId(null);
      focusViewport.current = null;
      setSelection(null);
      setTimeout(() => {
        if (board.viewport) flow.setViewport(board.viewport);
        else if (board.nodes.some((node) => !node.archived))
          flow.fitView({ padding: 0.2, maxZoom: 1, duration: 0 });
        else flow.setViewport({ x: 120, y: 90, zoom: 1 });
      }, 30);
    }
  }, [board, collapsed, navigate, flow, hiddenConversationIds]);

  const createNode = useCallback(
    async (kind = "chat") => {
      const intent = ++navigationEpoch.current;
      const canvas = document
        .querySelector(".canvas-surface")
        ?.getBoundingClientRect();
      const point = flow.screenToFlowPosition({
        x:
          (canvas?.left || 0) +
          (canvas?.width || 900) / 2 -
          (kind === "note" ? 150 : 220),
        y:
          (canvas?.top || 0) +
          (canvas?.height || 700) / 2 -
          (kind === "note" ? 110 : 275),
      });
      const count =
        boardRef.current?.nodes.filter((node) => !node.archived).length || 0;
      const node = await invoke("node/create", {
        boardId: boardRef.current?.id,
        kind,
        position: {
          x: point.x + (count % 3) * 28,
          y: point.y + (count % 3) * 24,
        },
      });
      if (node)
        setTimeout(() => {
          if (navigationEpoch.current !== intent) return;
          navigate(node.id);
          document
            .querySelector(
              `[data-testid="${kind === "note" ? "note" : kind === "document" ? "document-editor" : "composer"}-${node.id}"]`,
            )
            ?.focus();
        }, 100);
    },
    [flow, invoke, navigate],
  );

  useEffect(() => {
    const outsideMenu = event => {
      document.querySelectorAll('details.card-menu[open]').forEach(menu => {
        if (!menu.contains(event.target)) menu.open = false;
      });
    };
    const escapeMenu = event => {
      if (event.key !== 'Escape') return;
      const menus = [...document.querySelectorAll('details.card-menu[open]')];
      if (!menus.length) return;
      const activeMenu = menus.find(menu => menu.contains(document.activeElement));
      menus.forEach(menu => { menu.open = false; });
      activeMenu?.querySelector('summary')?.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('pointerdown', outsideMenu, true);
    document.addEventListener('keydown', escapeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', outsideMenu, true);
      document.removeEventListener('keydown', escapeMenu, true);
    };
  }, []);

  useEffect(() => {
    if (!fullChatNode) return;
    const background = [...document.querySelectorAll('.page-reader-shell, .floating-side-chat, .floating-chat-reopen-tray, .canvas-surface')]
      .filter(element => !element.closest('.chat-fullscreen'));
    const prior = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    return () => background.forEach((element, index) => { element.inert = prior[index]; });
  }, [fullChatNode?.id]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='f'){
        event.preventDefault();openScreenSearch();return;
      }
      if (event.key === "Escape") {
        if(findOpen&&!modal){event.preventDefault();closeScreenSearch();return;}
        if (connectionOpen) { setConnectionOpen(false); return; }
        if (chatFocusRef.current && !modal) {
          if (selectionRef.current) setSelection(null);
          else closeFullChat();
          event.preventDefault();
          return;
        }
        if (focusPageRef.current && !modal) {
          if (selectionRef.current?.nativePage) setSelection(null);
          else window.dispatchEvent(new CustomEvent("tangent:page-escape", { detail: focusPageRef.current }));
          return;
        }
        setModal(null);
        setSelection(null);
        setConnectionOpen(false);
        document
          .querySelectorAll("details[open].card-menu")
          .forEach((element) => {
            element.open = false;
          });
      }
      if (boardRef.current?.nodes.find(node => node.id === focusPageRef.current)?.pageView === "full") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setModal("search");
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (event.shiftKey) invoke("board/create", {});
        else createNode();
      }
    };
    const onMouseUp = (event) => {
      if (event.target.closest(".selection-popover")) return;
      if (event.target.closest("button,input,textarea,select,summary")) return;
      const selected = window.getSelection();
      const text = selected?.toString().trim();
      if (!text || text.length < 2 || !selected?.rangeCount) return;
      const range = selected.getRangeAt(0);
      const element =
        range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      const pageBlock =
        element?.closest(".linked-page-block") ||
        (range.startContainer.nodeType === Node.ELEMENT_NODE
          ? range.startContainer
          : range.startContainer.parentElement
        )?.closest(".linked-page-block");
      if (
        pageBlock &&
        !event.target.closest("textarea,input,[contenteditable]")
      ) {
        const source = boardRef.current?.nodes.find(
          (node) => node.id === pageBlock.dataset.nodeId,
        );
        if (!source) return;
        openPage(source.id);
        const rect = range.getBoundingClientRect();
        setSelection({
          nodeId: source.id,
          pageNodeId: source.id,
          blockId: pageBlock.dataset.blockId,
          quote: text,
          chatId: source.targetChatId || null,
          nativePage: true,
          expanded: true,
          x: Math.min(Math.max(12, rect.left), window.innerWidth - 365),
          y: Math.min(rect.bottom + 10, window.innerHeight - 310),
        });
        return;
      }
      const documentPreview = element?.closest(".document-preview");
      if (documentPreview) {
        const rect = range.getBoundingClientRect();
        setSelection({
          nodeId: documentPreview.dataset.nodeId,
          documentId: documentPreview.dataset.nodeId,
          quote: text,
          x: Math.min(Math.max(12, rect.left), window.innerWidth - 355),
          y: Math.min(rect.bottom + 10, window.innerHeight - 280),
          expanded: true,
        });
        return;
      }
      const message = element?.closest(".message.assistant");
      if (
        !message ||
        !message
          .querySelector(".message-text")
          ?.contains(range.commonAncestorContainer)
      )
        return;
      const sourceNode = boardRef.current?.nodes.find(
        (node) => node.id === message.dataset.nodeId,
      );
      const sourceMessage = sourceNode?.messages.find(
        (item) => item.id === message.dataset.messageId,
      );
      if (
        !sourceMessage?.turnId ||
        (sourceMessage.status && sourceMessage.status !== "completed") ||
        sourceNode.activeTurnId === sourceMessage.turnId ||
        sourceNode.messages
          .slice(sourceNode.messages.indexOf(sourceMessage) + 1)
          .some(
            (item) =>
              item.role === "assistant" && item.turnId === sourceMessage.turnId,
          )
      )
        return;
      const rect = range.getBoundingClientRect();
      setSelection({
        nodeId: message.dataset.nodeId,
        messageId: message.dataset.messageId,
        quote: text,
        x: Math.min(Math.max(12, rect.left), window.innerWidth - 355),
        y: Math.min(rect.bottom + 10, window.innerHeight - 280),
      });
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [createNode, invoke, modal, openPage, connectionOpen, closeFullChat,findOpen,openScreenSearch,closeScreenSearch]);

  useEffect(() => {
    if (!modal) return;
    const previouslyFocused = modalReturnFocus.current;
    const background = [...document.querySelectorAll(".sidebar, .sidebar-rail, .workspace, .page-reader-shell:not([hidden]), .floating-side-chat, .floating-chat-reopen, .chat-fullscreen, .chat-focus-toolbar")];
    const priorInert = background.map(element => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });
    const focusTimer = setTimeout(() => {
      const dialog = document.querySelector('[aria-modal="true"]');
      if (dialog && !dialog.contains(document.activeElement))
        dialog
          .querySelector('input, textarea, button, select, [tabindex="0"]')
          ?.focus();
    }, 0);
    const trapFocus = (event) => {
      if (event.key !== "Tab") return;
      const dialog = document.querySelector('[aria-modal="true"]');
      if (!dialog) return;
      const focusable = [
        ...dialog.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
        ),
      ].filter((element) => element.getClientRects().length);
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      clearTimeout(focusTimer);
      background.forEach((element, index) => {
        element.inert = priorInert[index];
      });
      document.removeEventListener("keydown", trapFocus);
      if (!modalLogical.current) {
        if (previouslyFocused?.isConnected && !previouslyFocused.closest("[inert], [hidden]"))
          previouslyFocused.focus({ preventScroll: true });
        modalReturnFocus.current = null;
      }
    };
  }, [modal]);

  const edges = useMemo(
    () =>
      (board?.edges || [])
        .filter(
          (edge) =>
            nodes.some((node) => node.id === edge.source) &&
            nodes.some((node) => node.id === edge.target),
        )
        .map((edge) => {
          const source = nodes.find((node) => node.id === edge.source);
          const target = nodes.find((node) => node.id === edge.target);
          const sourceCenter =
            source.position.x +
            Number(source.width || source.style?.width || 440) / 2;
          const targetCenter =
            target.position.x +
            Number(target.width || target.style?.width || 440) / 2;
          const forward = targetCenter >= sourceCenter;
          return {
            ...edge,
            sourceHandle: forward ? "out-right" : "out-left",
            targetHandle: forward ? "in-left" : "in-right",
            type: "default",
            animated: false,
            style: {
              stroke:
                edge.kind === "comment"
                  ? "#a7a7a7"
                  : edge.kind === "document"
                    ? "#b8b8b8"
                    : "#b8b8b8",
              strokeWidth: 1.6,
              strokeDasharray: edge.kind === "comment" ? "4 4" : undefined,
            },
            label:
              edge.kind === "comment"
                ? "side question"
                : edge.kind === "document"
                  ? "document"
                  : "branch",
            labelStyle: { fill: "#8f8f8f", fontSize: 10, fontWeight: 500 },
            labelBgStyle: { fill: "#fcfcfc", fillOpacity: 0.97 },
            labelBgPadding: [7, 4],
            labelBgBorderRadius: 5,
          };
        }),
    [board?.edges, nodes],
  );

  const actions = useMemo(() => ({branch, invoke, setSelection, toast, acknowledgeReply}),
    [branch, invoke, setSelection, toast, acknowledgeReply]);
  const context = useMemo(
    () => ({
      state,
      board,
      connection,
      reconnect,
      reconnecting,
      invoke,
      update,
      acknowledgeReply,
      resizeStart,
      resizeEnd,
      branch,
      setSelection,
      selection,
      focusPageId,
      pageViewMode,
      openPage,
      closePage,
      openFloatingChat,
      openFullChat,
      chatDrafts,
      chatDraftRevisions,
      chatDraftListeners,
      setChatDraft,
      reportReaderPresence,
      sidebar,
      setSidebar,
      collapsed,
      toggleCollapsed,
      toast,
      pageStatuses,
      pageOverlayAllowed:
        !findOpen && !modalMotion.value && !selectionMotion.value && !connectionMotion.value && !toastMotion.value && !nativeDialogOpen && !focusPageId && !fullChatNode && !readerOverlayVisible && !layoutMotionActive,
    }),
    [
      state,
      board,
      connection,
      reconnect,
      reconnecting,
      invoke,
      update,
      acknowledgeReply,
      resizeStart,
      resizeEnd,
      branch,
      collapsed,
      toggleCollapsed,
      toast,
      pageStatuses,
      modal,
      selection,
      connectionOpen,
      nativeDialogOpen,
      focusPageId,
      pageViewMode,
      openPage,
      closePage,
      openFloatingChat,
      openFullChat,
      fullChatNode?.id,
      sidebar,
      reportReaderPresence,
      readerOverlayVisible,
      layoutMotionActive,
      !!modalMotion.value,
      !!selectionMotion.value,
      !!connectionMotion.value,
      !!toastMotion.value,
      findOpen,
    ],
  );
  if (fatalError)
    return (
      <div className="app-failure">
        <Mark />
        <h1>Tangent couldn’t start.</h1>
        <p>{fatalError}</p>
        <button className="button" onClick={() => location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!ready || !board)
    return (
      <div className="loading-app">
        <Mark />
        <span>Making room for your ideas…</span>
        <LoaderCircle size={18} className="spin" />
      </div>
    );
  const visibleNodes = board.nodes.filter((node) => !node.archived);
  const floatingChats = <>
    {sideChatHistory.map((sideChatNode, spawnIndex) => {
      const view = sideChatViews[sideChatNode.id];
      return view?.open && sideChatNode.id !== fullChatNode?.id ?
      <FloatingSideChat key={`${sideChatKey}:${sideChatNode.id}`} node={sideChatNode} chats={sideChatHistory}
        minimized={view.minimized} status={<Status node={sideChatNode} />}
        geometry={view.geometry} onGeometryChange={geometry => updateFloatingChat(sideChatNode.id, { geometry })}
        onActivate={() => {activateFloatingChat(sideChatNode.id);acknowledgeReply(sideChatNode.id);}} stackIndex={sideChatStack.indexOf(sideChatNode.id)} spawnIndex={spawnIndex}
        onSelect={id => openFloatingChat(id)} onMinimize={() => updateFloatingChat(sideChatNode.id, { minimized: !view.minimized })}
        onClose={() => updateFloatingChat(sideChatNode.id, { open: false, dismissed: true })}
        onFullScreen={() => openFullChat(sideChatNode.id)}
        onCanvas={() => { updateFloatingChat(sideChatNode.id, { open: false, dismissed: true }); navigate(sideChatNode.id, { canvas: true }); }}>
        <ChatNode floating selected data={{ node: sideChatNode, navigate: id => {
          const target = boardRef.current?.nodes.find(item => item.id === id);
          if (target?.kind === "page") openPage(id);
          else if (target && ["chat", "comment"].includes(target.kind)) openFloatingChat(id);
        } }} />
      </FloatingSideChat> : null;
    })}
    {sideChatHistory.some(node => !sideChatViews[node.id]?.open && !sideChatViews[node.id]?.dismissed) && <div className="floating-chat-reopen-tray" aria-label="Closed side conversations">
      {sideChatHistory.filter(node => !sideChatViews[node.id]?.open && !sideChatViews[node.id]?.dismissed).map(node => <button key={node.id} className="floating-chat-reopen" data-testid={`floating-chat-reopen-${node.id}`} onClick={() => openFloatingChat(node.id)}><MessageCircle size={15}/><span>{node.title}</span><ArrowUpRight size={13}/></button>)}
    </div>}
  </>;
  return (
    <CanvasContext.Provider value={context}>
      <CanvasActionsContext.Provider value={actions}>
      <div className={`app-shell ${sidebar ? "" : "sidebar-hidden"} ${focusPageId ? `is-page-focused is-page-focused-${pageViewMode}` : ""} ${fullChatNode ? "is-chat-focused" : ""}`}>
        <aside {...sidebarMotion.props} className="sidebar" hidden={!sidebarMotion.value}>
          <div className="sidebar-brand">
            <Mark />
            <span>Tangent</span>
            <SidebarToggle expanded onClick={() => setSidebar(false)} />
          </div>
          <button
            className="sidebar-search"
            onClick={() => setModal("search")}
            data-testid="find-card"
          >
            <Search size={14} />
            <span>Find a thought</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="sidebar-section-title">
            <span>Your canvases</span>
            <IconButton
              title="New canvas"
              data-testid="new-board"
              onClick={() => invoke("board/create", {})}
            >
              <Plus size={14} />
            </IconButton>
          </div>
          <nav className="board-list" aria-label="Canvases">
            {state.boards.map((item) => (
              <div key={item.id} className={`board-row ${item.id === board.id ? "active" : ""}`} data-testid={`board-row-${item.id}`}>
                {renamingCanvas?.id === item.id ? <div className={`board-button ${item.id === board.id ? "active" : ""}`}>
                  <Layers3 size={15} />
                  <input className="canvas-name-input" data-testid={`canvas-name-${item.id}`} aria-label="Canvas name" value={renamingCanvas.title} autoFocus
                    onFocus={event => event.currentTarget.select()}
                    onChange={event => { const title = event.target.value; setRenamingCanvas(current => current?.id === item.id ? { ...current, title } : current); }}
                    onKeyDown={event => {
                      event.stopPropagation();
                      if (event.key === "Escape") { event.preventDefault(); renameCancelled.current = true; setRenamingCanvas(null); }
                      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                    }}
                    onBlur={async event => {
                      if (renameCancelled.current) return;
                      const draft = event.currentTarget.value, title = draft.trim();
                      if (!title || title === item.title) { setRenamingCanvas(null); return; }
                      const result = await invoke("board/update", { boardId: item.id, title });
                      if (result !== null) setRenamingCanvas(current => current?.id === item.id && current.title === draft ? null : current);
                    }} />
                </div> : <button
                  className={`board-button ${item.id === board.id ? "active" : ""}`}
                  data-testid={`board-${item.id}`}
                  title="Double-click to rename"
                  onClick={() => invoke("board/select", { boardId: item.id })}
                  onDoubleClick={event => { event.preventDefault(); renameCancelled.current = false; setRenamingCanvas({ id: item.id, title: item.title }); }}
                >
                  <Layers3 size={15} />
                  <span>{item.title}</span>
                  {item.id === board.id && <span className="board-active-dot" />}
                </button>}
                <IconButton className="board-delete" title={`Delete canvas ${item.title}`} data-testid={`delete-board-${item.id}`} onClick={() => {
                  setDeleteCanvasId(item.id); setConnectionOpen(false); setModal("delete-canvas");
                }}><Trash2 size={13} /></IconButton>
              </div>
            ))}
          </nav>
          <div className="sidebar-divider" />
          <div className="sidebar-section-title">
            <span>On this canvas</span>
            <span className="sidebar-count">{visibleNodes.length}</span>
          </div>
          <div className="outline-list">
            {visibleNodes.map((node) => (
              <button
                key={node.id}
                onClick={() => navigate(node.id)}
                className={node.kind === "comment" ? "outline-comment" : ""}
              >
                {node.kind === "note" ? (
                  <StickyNote size={13} />
                ) : node.kind === "page" ? (
                  <Globe size={13} />
                ) : node.kind === "document" ? (
                  <FileText size={13} />
                ) : node.kind === "comment" ? (
                  <MessageCircle size={13} />
                ) : node.parentId ? (
                  <GitBranch size={13} />
                ) : (
                  <Circle size={7} fill="currentColor" />
                )}
                <span>{node.title}</span>
                {busy(node) && <span className="outline-running" />}
              </button>
            ))}
            {!visibleNodes.length && (
              <p className="outline-empty">
                Your thoughts will find
                <br />
                their place here.
              </p>
            )}
          </div>
          <div className="sidebar-bottom">
            <button
              className="import-sidebar"
              data-testid="open-import"
              onClick={() => setModal("import")}
            >
              <History size={15} />
              <span>Bring in a Codex chat</span>
              <ArrowUpRight size={13} />
            </button>
            <button className="guide-button" onClick={() => setModal("help")}>
              <HelpCircle size={14} />
              <span>A quick guide</span>
              <kbd>?</kbd>
            </button>
            <div className="sidebar-account" role="status" data-testid="codex-connection-status">
              <span
                className={`connection-dot ${connection.connected && !connection.error ? "connected" : ""}`}
              />
              <span>
                {reconnecting
                  ? "Connecting to Codex…"
                  : connection.error
                  ? "Codex needs attention"
                  : connection.connected
                    ? "Your Codex, connected"
                    : "Connecting to Codex"}
              </span>

            </div>
          </div>
        </aside>
        {!sidebar && <aside className="sidebar-rail" aria-label="Sidebar controls" data-testid="sidebar-rail">
          <span className={`connection-dot rail-connection-status ${connection.connected && !connection.error ? "connected" : ""}`} title={connection.error ? "Codex needs attention" : connection.connected ? "Your Codex, connected" : "Connecting to Codex"} />
        </aside>}
        <main className="workspace">
          <header className="workspace-topbar">
            <div className="workspace-toolbar-left">
              {!sidebar && <SidebarToggle expanded={false} onClick={() => setSidebar(true)} />}
              <div id="page-toolbar-slot" className="page-toolbar-slot" data-testid="page-toolbar-slot" />
            </div>
            <div className="workspace-top-actions">
              <IconButton title="Find in this view · ⌘F" data-testid="screen-search-open" onClick={openScreenSearch}><Search size={15}/></IconButton>
              <LocalSaveStatus initial={state.persistence}/>
              <IconButton
                title="Export canvas"
                data-testid="export-board"
                onClick={() => invoke("app/export", { boardId: board.id })}
              >
                <Download size={15} />
              </IconButton>
              <button
                className={`connection-button ${connectionOpen ? "is-open" : ""}`}
                data-testid="connection-settings"
                ref={connectionButton}
                aria-label="Codex settings"
                aria-expanded={connectionOpen}
                aria-controls="codex-connection-popover"
                onClick={() => setConnectionOpen((value) => !value)}
              >
                <span
                  className={`connection-dot ${connection.connected && !connection.error ? "connected" : ""}`}
                />
                <span>
                  {reconnecting
                    ? "Connecting…"
                    : connection.error
                    ? "Needs attention"
                    : connection.connected
                      ? "Codex"
                      : "Offline"}
                </span>
                <ChevronDown size={11} />
              </button>
            </div>
          </header>
          <div className="canvas-surface" data-testid="canvas-surface">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={(changes) =>
                setNodes((current) => applyNodeChanges(changes, current))
              }
              onNodeDragStart={(_, node) => dragging.current.add(node.id)}
              onNodeDragStop={(_, node) => {
                dragging.current.delete(node.id);
                update(node.id, { position: node.position });
              }}
              onInit={() => {
                flowReady.current = true;
                if (board.viewport) flow.setViewport(board.viewport);
                else if (visibleNodes.length)
                  flow.fitView({ padding: 0.2, maxZoom: 1 });
                initializedBoard.current = board.id;
              }}
              onMoveEnd={(_, viewport) =>
                invoke("board/update", { boardId: board.id, viewport })
              }
              onPaneClick={() => {
                setSelection(null);
                setConnectionOpen(false);
              }}
              minZoom={0.2}
              maxZoom={1.6}
              panOnScroll
              panOnDrag={[0, 1, 2]}
              selectionOnDrag={false}
              selectNodesOnDrag={false}
              zoomOnScroll={false}
              zoomOnPinch
              deleteKeyCode={null}
              selectionKeyCode="Shift"
              multiSelectionKeyCode="Meta"
              nodesConnectable={false}
              elevateNodesOnSelect
              elevateEdgesOnSelect={false}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ type: "default" }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                color="#dfdfdf"
              />
              {showMap && (
                <MiniMap
                  nodeColor={(node) =>
                    node.data.node.kind === "note"
                      ? "#dfdfdf"
                      : node.data.node.kind === "document"
                        ? "#dfdfdf"
                        : node.data.node.kind === "comment"
                          ? "#ededed"
                          : "#ededed"
                  }
                  maskColor="rgba(252,252,252,.72)"
                  pannable
                  zoomable
                  className="canvas-minimap"
                />
              )}
            </ReactFlow>
            <CanvasSummaryHover board={board} enabled={!focusPageId&&!readerOverlayVisible&&!fullChatNode&&!modal&&!connectionOpen&&!selection&&!nativeDialogOpen}/>
            {!visibleNodes.length && (
              <div className="welcome-state">
                <div className="welcome-art">
                  <div className="welcome-art-card one">
                    <span />
                    <span />
                    <i />
                  </div>
                  <div className="welcome-art-line" />
                  <div className="welcome-art-card two">
                    <MessageCircle size={17} />
                    <span />
                    <i />
                  </div>
                  <div className="welcome-art-dot" />
                </div>
                <span className="eyebrow">A canvas for your curiosity</span>
                <h1>
                  Keep the thread.
                  <br />
                  <span>Follow the tangent.</span>
                </h1>
                <p>
                  Your Codex agent, in a space that lets ideas branch.
                  <br />
                  Ask a side question. Explore a rabbit hole.
                  <br />
                  Your main conversation stays right where you left it.
                </p>
                <div className="welcome-actions">
                  <button
                    className="button primary"
                    data-testid="welcome-new-chat"
                    onClick={() => createNode()}
                  >
                    <Plus size={15} />
                    Start a conversation
                  </button>
                  <button
                    className="button"
                    data-testid="welcome-import"
                    onClick={() => setModal("import")}
                  >
                    <History size={15} />
                    Bring in a Codex chat
                  </button>
                </div>
                <span className="welcome-note">
                  <ShieldCheck size={12} />
                  Uses your existing Codex sign-in
                </span>
              </div>
            )}
            <div className="canvas-coordinate-label">
              {visibleNodes.length
                ? `${visibleNodes.filter((node) => ["chat", "comment"].includes(node.kind)).length} ${visibleNodes.filter((node) => ["chat", "comment"].includes(node.kind)).length === 1 ? "conversation" : "conversations"} · ${visibleNodes.filter((node) => ["document", "page"].includes(node.kind)).length} ${visibleNodes.filter((node) => ["document", "page"].includes(node.kind)).length === 1 ? "page" : "pages"}`
                : "Space to think, in any direction."}
              <span>Every branch has its own context.</span>
            </div>
            <div
              className="canvas-dock"
              role="toolbar"
              aria-label="Canvas tools"
            >
              <button
                className="dock-button primary-tool"
                data-testid="new-chat"
                onClick={() => createNode()}
                title="New conversation · ⌘ N"
              >
                <Plus size={17} />
                <span>Chat</span>
              </button>
              <span className="dock-divider" />
              <button
                className="dock-button"
                data-testid="new-comment"
                onClick={() => createNode("comment")}
                title="New agent-answered comment"
              >
                <MessageCircle size={17} />
                <span>Comment</span>
              </button>
              <button
                className="dock-button"
                data-testid="new-note"
                onClick={() => createNode("note")}
                title="New note"
              >
                <StickyNote size={17} />
                <span>Note</span>
              </button>
              <button
                className="dock-button"
                data-testid="new-document"
                onClick={() => createNode("document")}
                title="New local page"
              >
                <FileText size={17} />
                <span>Local page</span>
              </button>
              <button
                className="dock-button"
                data-testid="new-page"
                onClick={() => setModal("page-link")}
                title="Link an actual ChatGPT Page"
              >
                <Globe size={17} />
                <span>Page</span>
              </button>
              <span className="dock-divider" />
              <BoardSummaryControl key={board.id} board={board} invoke={invoke} />
              <span className="dock-divider" />
              <IconButton
                title="Fit all cards"
                data-testid="fit-canvas"
                onClick={fitCanvas}
              >
                <Maximize2 size={16} />
              </IconButton>
              <IconButton
                title={showMap ? "Hide minimap" : "Show minimap"}
                data-testid="toggle-minimap"
                className={showMap ? "is-active" : ""}
                onClick={() => setShowMap((value) => !value)}
              >
                <Layers3 size={16} />
              </IconButton>
            </div>
            <CanvasZoomControls />
          </div>
        </main>
        {connectionMotion.value && (
          <div {...connectionMotion.props} className="connection-popover" data-testid="connection-popover" id="codex-connection-popover" role="dialog" aria-label="Codex settings" style={connectionAnchor}>
            <div className="connection-heading">
              <span className="connection-avatar">
                <Mark small />
              </span>
              <div>
                <strong>
                  {reconnecting
                    ? "Connecting to Codex…"
                    : connection.error
                    ? "Codex needs attention"
                    : connection.connected
                      ? "Connected to Codex"
                      : "Codex is disconnected"}
                </strong>
                <span>
                  {connection.account?.email ||
                    (connection.account?.type === "chatgpt"
                      ? "Your ChatGPT subscription"
                      : "Uses your local Codex sign-in")}
                </span>
              </div>
              <IconButton
                title="Close connection settings"
                onClick={() => setConnectionOpen(false)}
              >
                <X size={13} />
              </IconButton>
            </div>
            {connection.error && !reconnecting && (
              <p className="connection-error" role="alert">{connection.error}</p>
            )}
            <label className="setting-row">
              <span>Default model</span>
              <select
                aria-label="Codex model"
                data-testid="model-select"
                value={connection.model || ""}
                onChange={(event) =>
                  invoke("codex/settings", { model: event.target.value })
                }
              >
                {(connection.models || []).map((model) => (
                  <option
                    key={model.id || model.model}
                    value={model.model || model.id}
                  >
                    {model.displayName || model.model || model.id}
                  </option>
                ))}
                {!connection.models?.length && (
                  <option value={connection.model || ""}>
                    {connection.model || "Loading models…"}
                  </option>
                )}
              </select>
            </label>
            <label className="setting-row">
              <span>Default effort</span>
              <select
                aria-label="Reasoning effort"
                data-testid="effort-select"
                value={connection.effort || "medium"}
                onChange={(event) =>
                  invoke("codex/settings", { effort: event.target.value })
                }
              >
                {(
                  connection.models
                    ?.find(
                      (model) => (model.model || model.id) === connection.model,
                    )
                    ?.supportedReasoningEfforts?.map((option) =>
                      typeof option === "string"
                        ? option
                        : option.reasoningEffort,
                    ) || [connection.effort || "medium"]
                ).map((effort) => (
                  <option value={effort} key={effort}>
                    {effort === "xhigh"
                      ? "Extra high"
                      : effort[0].toUpperCase() + effort.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <p className="connection-defaults-help">
              New chats inherit these. Change each chat in its composer.
            </p>
            <div className="connection-project">
              <span>File access</span>
              <button className="settings-project-button" data-testid="choose-project" title={board.projectPath || "Choose a folder for file edits"} onClick={() => invoke("project/choose", { boardId: board.id })}>
                <Folder size={14} /><span>{shortPath(board.projectPath) || "Choose a folder…"}</span><ChevronRight size={13} />
              </button>
            </div>
            <div className="connection-footnote">
              <ShieldCheck size={13} />
              <span>
                Permissions are set in each conversation. Your Pages remain editable.
              </span>
            </div>
            <div className="connection-footer">
              {connection.connected ? <span className="connection-footer-status" role="status" data-testid="connection-healthy"><Check size={13} />Connected</span> :
                <button onClick={reconnect} disabled={reconnecting} aria-busy={reconnecting} data-testid="reconnect-codex">
                  <RotateCw size={13} className={reconnecting ? "spin" : undefined} />
                  {reconnecting ? "Connecting…" : "Reconnect"}
                </button>}
              <button onClick={() => invoke("app/reveal-data")}>
                <Folder size={13} />
                Local data
              </button>
            </div>
          </div>
        )}
        {!fullChatNode && sideChatOwnerId && floatingChats}
        {fullChatNode && <ChatFullscreen key={`${board.id}:${fullChatNode.id}`} node={fullChatNode} status={<Status node={fullChatNode}/>} onBack={closeFullChat} overlays={floatingChats}>
          <ChatNode floating selected data={{ node: fullChatNode, navigate }} scrollPosition={chatFocus.scrollPosition}/>
        </ChatFullscreen>}
        {findOpen && <ScreenSearch scope={screenSearchScope} onNavigate={navigateSearchMatch} onClose={closeScreenSearch} requestId={findRequest}/>}
        {displayedSelection && (
          <SelectionPopover
            motionProps={selectionMotion.props}
            key={`${displayedSelection.nodeId}-${displayedSelection.messageId}-${displayedSelection.quote}`}
            selection={displayedSelection}
            close={() => setSelection(null)}
            onBranch={() => branch(displayedSelection.nodeId, displayedSelection.messageId)}
            onSubmit={async (text, options = {}) => {
              if (displayedSelection.nativePage && displayedSelection.action === "side-chat") {
                return branch(displayedSelection.pageNodeId, undefined, {
                  kind: "comment", quote: displayedSelection.quote,
                  blockId: displayedSelection.blockId, text,
                });
              }
              if (displayedSelection.pageNodeId) {
                const node = await invoke("page/ask", {
                  boardId: board.id,
                  nodeId: displayedSelection.pageNodeId,
                  text,
                  chatId:
                    options.chatId === undefined
                      ? displayedSelection.chatId
                      : options.chatId,
                  quote: displayedSelection.quote || undefined,
                  blockId: displayedSelection.blockId,
                });
                if (node) {
                  setSelection(null);
                  if (!displayedSelection.nativePage)
                    setTimeout(() => navigate(node.id), 80);
                }
                return node;
              }
              if (displayedSelection.documentId) {
                const node = await invoke("document/ask", {
                  boardId: board.id,
                  nodeId: displayedSelection.documentId,
                  text: `${displayedSelection.quote ? `About this passage:\n> ${displayedSelection.quote}\n\n` : ""}${text}`,
                });
                if (node) {
                  setSelection(null);
                  setTimeout(() => navigate(node.id), 80);
                }
                return node;
              }
              return branch(displayedSelection.nodeId, displayedSelection.messageId, {
                kind: "comment",
                quote: displayedSelection.quote,
                text,
              });
            }}
          />
        )}
        {displayedModal?.kind === "delete-canvas" && displayedModal.canvas && <DeleteCanvasDialog
          motionProps={modalMotion.props}
          canvas={displayedModal.canvas}
          canvasCount={displayedModal.canvasCount}
          close={() => { setModal(null); setDeleteCanvasId(null); }}
          deleted={() => { setModal(null); setDeleteCanvasId(null); toast("Canvas deleted"); }}
        />}
        {displayedModal?.kind === "import" && (
          <ImportDialog
            motionProps={modalMotion.props}
            close={() => setModal(null)}
            imported={(node) => {
              setModal(null);
              setTimeout(() => navigate(node.id), 80);
              toast("Conversation imported as a separate copy");
            }}
          />
        )}
        {displayedModal?.kind === "page-link" && (
          <PageLinkDialog
            motionProps={modalMotion.props}
            close={() => setModal(null)}
            linked={(node) => {
              setModal(null);
              setTimeout(() => navigate(node.id), 80);
            }}
          />
        )}
        {displayedModal?.kind === "help" && <HelpDialog motionProps={modalMotion.props} close={() => setModal(null)} />}
        {displayedModal?.kind === "search" && (
          <SearchDialog motionProps={modalMotion.props} close={() => setModal(null)} navigate={navigate} />
        )}
        {displayedToast && (
          <div {...toastMotion.props} className="toast" role="status">
            <Check size={14} />
            <span>{displayedToast.message}</span>
            {displayedToast.action && (
              <button
                onClick={() => {
                  displayedToast.action.onClick();
                  setToastMessage(null);
                }}
              >
                {displayedToast.action.label}
              </button>
            )}
            <IconButton
              title="Dismiss notification"
              onClick={() => setToastMessage(null)}
            >
              <X size={12} />
            </IconButton>
          </div>
        )}
      </div>
      </CanvasActionsContext.Provider>
    </CanvasContext.Provider>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <CanvasApp />
    </ReactFlowProvider>
  );
}
