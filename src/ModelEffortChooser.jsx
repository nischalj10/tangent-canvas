import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, RotateCcw, Zap } from "lucide-react";
import "./model-effort-chooser.css";

const modelId = (model) => model?.model || model?.id || "";
const effortId = (option) => typeof option === "string" ? option : option?.reasoningEffort;
const effortLabel = (effort) => effort === "xhigh" ? "Extra high" : effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : "Default";
const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]';
const visibleFocusable = (element) => [...element.querySelectorAll(focusableSelector)].filter((item) => item.getClientRects().length && !item.closest("[inert]"));

// The available models and slider stops come directly from the native catalog.
// Settings retain the same { model } / { effort } contract as native selectors.
export default function ModelEffortChooser({
  models = [], model, effort, efforts, disabled = false, running = false,
  onChange, testId = "model-effort", modelTestId, effortTestId,
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const popup = useRef(null);
  const range = useRef(null);
  const popupId = useId();
  const headingId = useId();
  const helpId = useId();
  const catalog = Array.isArray(models) ? models : [];
  const selectedModel = typeof model === "object" && model
    ? model
    : catalog.find((item) => modelId(item) === model || item.id === model);
  const selectedModelId = modelId(selectedModel) || (typeof model === "string" ? model : "");
  const modelLabel = selectedModel?.displayName || selectedModelId || "Codex";
  const nativeEfforts = selectedModel?.supportedReasoningEfforts;
  const availableEfforts = [...new Set((nativeEfforts?.length ? nativeEfforts : efforts || [effort || selectedModel?.defaultReasoningEffort])
    .map(effortId).filter(Boolean))];
  const defaultEffort = availableEfforts.includes(selectedModel?.defaultReasoningEffort)
    ? selectedModel.defaultReasoningEffort : undefined;
  const selectedEffort = availableEfforts.includes(effort)
    ? effort : defaultEffort || availableEfforts[0];
  const selectedIndex = Math.max(0, availableEfforts.indexOf(selectedEffort));
  const description = nativeEfforts?.find((option) => effortId(option) === selectedEffort)?.description;

  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const bounds = popup.current?.getBoundingClientRect();
      if (!anchor || !bounds) return;
      const gutter = 12;
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      const above = anchor.top - bounds.height - 10;
      const left = Math.max(gutter, Math.min(width - bounds.width - gutter, anchor.right - bounds.width));
      const top = Math.max(gutter, Math.min(height - bounds.height - gutter, above));
      setPosition({ left, top, "--model-effort-origin": `${Math.max(16, Math.min(bounds.width - 16, anchor.left + anchor.width / 2 - left))}px bottom` });
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, modelLabel, selectedEffort, running, description]);

  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("keydown", escape, true);
    const frame = requestAnimationFrame(() => {
      const target = !range.current?.disabled ? range.current : popup.current?.querySelector("select:not([disabled])");
      (target || popup.current)?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const handleTab = (event) => {
    if (event.key !== "Tab") {
      event.stopPropagation();
      return;
    }
    const items = visibleFocusable(popup.current);
    const atStart = event.shiftKey && document.activeElement === items[0];
    const atEnd = !event.shiftKey && document.activeElement === items.at(-1);
    if (!atStart && !atEnd) return;
    event.preventDefault();
    event.stopPropagation();
    const pageItems = visibleFocusable(document).filter((item) => !popup.current?.contains(item));
    const index = pageItems.indexOf(trigger.current);
    const next = atStart ? trigger.current : pageItems[index + 1] || trigger.current;
    close();
    next?.focus({ preventScroll: true });
  };

  return <div className="model-effort-chooser">
    <button
      ref={trigger}
      type="button"
      className="model-effort-trigger"
      data-testid={`${testId}-trigger`}
      aria-label={`Model and reasoning effort: ${modelLabel}, ${effortLabel(selectedEffort)}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popupId : undefined}
      disabled={disabled}
      title={running ? "Model and reasoning effort for the next turn" : "Model and reasoning effort"}
      onClick={() => { setPosition(null); setOpen((current) => !current); }}
    >
      <span className="model-effort-model-label">{modelLabel}</span>
      <span className="model-effort-current">{effortLabel(selectedEffort)}</span>
      <ChevronDown size={11} aria-hidden="true" />
    </button>
    {open && createPortal(<div
      ref={popup}
      id={popupId}
      className="model-effort-popover nodrag nopan nowheel"
      role="dialog"
      aria-label="Model and reasoning effort"
      aria-describedby={running ? helpId : undefined}
      tabIndex={-1}
      data-testid={`${testId}-popover`}
      style={position || { left: 0, top: 0, visibility: "hidden" }}
      onKeyDown={handleTab}
    >
      <div className="model-effort-heading">
        <Zap size={17} className="model-effort-lightning" aria-hidden="true" />
        <h3 id={headingId}>{effortLabel(selectedEffort)}</h3>
        <button type="button" className="model-effort-reset" aria-label="Reset to model default effort" title={defaultEffort ? `Reset to ${effortLabel(defaultEffort)}` : "No model default available"} disabled={disabled || !defaultEffort || selectedEffort === defaultEffort} onClick={() => onChange?.({ effort: defaultEffort })}>
          <RotateCcw size={15} aria-hidden="true" />
        </button>
      </div>
      <label className="model-effort-model-select">
        <select aria-label="Model" data-testid={modelTestId} value={selectedModelId} disabled={disabled || !catalog.length} onChange={(event) => onChange?.({ model: event.target.value })}>
          {catalog.map((item) => <option key={modelId(item)} value={modelId(item)}>{item.displayName || modelId(item)}</option>)}
          {!catalog.some((item) => modelId(item) === selectedModelId) && <option value={selectedModelId}>{modelLabel}</option>}
        </select>
        <ChevronDown size={10} aria-hidden="true" />
      </label>
      <div className={`model-effort-slider ${availableEfforts.length < 2 ? "is-fixed" : ""}`}>
        <div className="model-effort-slider-rail" aria-hidden="true">
          {availableEfforts.map((value, index) => <span key={value} style={{ left: `${availableEfforts.length < 2 ? 50 : index / (availableEfforts.length - 1) * 100}%` }} />)}
        </div>
        <input
          ref={range}
          type="range"
          min="0"
          max={Math.max(0, availableEfforts.length - 1)}
          step="1"
          value={selectedIndex}
          aria-label="Reasoning effort"
          aria-valuetext={effortLabel(selectedEffort)}
          aria-describedby={helpId}
          data-testid={effortTestId}
          disabled={disabled || availableEfforts.length < 2}
          onChange={(event) => {
            const next = availableEfforts[Number(event.target.value)];
            if (next && next !== selectedEffort) onChange?.({ effort: next });
          }}
        />
      </div>
      <p id={helpId} className={running || description ? "model-effort-help" : "model-effort-sr-only"}>
        {running ? "Changes apply to the next turn." : description || "Use the arrow keys to choose a supported reasoning effort."}
      </p>
    </div>, document.body)}
  </div>;
}
