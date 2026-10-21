import { useLayoutEffect, useReducer, useRef, useState } from "react";

// Timing/curves from the installed Codex app-shared + Popover styles. The
// 350ms popover entrance is intentional: it matches the shipped component.
export const MOTION = Object.freeze({
  basic: 150, moderate: 200, relaxed: 300,
  enter: "cubic-bezier(.19, 1, .22, 1)",
  exit: "cubic-bezier(.8, 0, .4, 1)",
  snappy: "cubic-bezier(.23, 1, .32, 1)",
});

let modality = "pointer";
let reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const active = new Set();
const layoutAnimations = new Map();

export function motionPreference() {
  return { modality, reduced };
}

export function setMotionInput(value) {
  modality = value;
  if (typeof document !== "undefined") document.documentElement.dataset.inputModality = value;
  // Keyboard input takes control immediately, even during a pointer transition.
  if (value === "keyboard") for (const animation of [...active]) animation.finish();
}

export function motionDuration(duration = MOTION.moderate) {
  return modality === "keyboard" || reduced ? 0 : duration;
}

// Geometry consumers need settled layout coordinates while a wrapper is in
// flight. In particular, Page toolbar measurements must not cache a FLIP offset.
export function layoutBounds(element) {
  const rect = element.getBoundingClientRect();
  let x = 0, y = 0;
  for (let node = element; node; node = node.parentElement) {
    if (!node.matches?.("[data-motion-layout], [data-motion-kind='reader']")) continue;
    const style = getComputedStyle(node);
    const parts = style.translate === "none" ? [] : style.translate.split(" ").map(parseFloat);
    const matrix = style.transform === "none" ? null : new DOMMatrixReadOnly(style.transform);
    x += (parts[0] || 0) + (matrix?.e || 0);
    y += (parts[1] || 0) + (matrix?.f || 0);
  }
  return { left: rect.left - x, right: rect.right - x, top: rect.top - y, bottom: rect.bottom - y, width: rect.width, height: rect.height };
}

export function presenceSpec(kind, opening, preference = motionPreference()) {
  if (preference.modality === "keyboard") return { duration: 0, movement: false, easing: MOTION.enter };
  if (preference.reduced) return { duration: 100, movement: false, easing: "linear" };
  const duration = kind === "popover" ? opening ? 350 : 200
    : kind === "sidebar" ? opening ? 250 : 200
    : kind === "dialog" || kind === "reader" ? 200 : 150;
  return { duration, movement: true, easing: opening ? MOTION.enter : MOTION.exit };
}

export function useMotionEnvironment() {
  useLayoutEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reduced = query.matches;
      document.documentElement.dataset.reducedMotion = String(reduced);
      if (reduced) for (const animation of [...active]) animation.finish();
    };
    const pointer = () => setMotionInput("pointer");
    const keyboard = () => setMotionInput("keyboard");
    const preparePress = event => {
      const button = event.target.closest?.("button");
      if (!button || button.disabled || !button.matches(".icon-button, .button, .dock-button, .connection-button, .page-title-pill, .page-toolbar-circle, .send-button, .page-window-pill > button")) return;
      const width = button.offsetWidth;
      const scale = width <= 80 ? .96 : width <= 150 ? .97 : width <= 220 ? .98 : width > 600 ? .995 : .985;
      button.dataset.motionPress = "";
      button.style.setProperty("--button-press-scale", String(scale));
    };
    // Finish a layout offset before React Flow calculates pointer coordinates.
    const directManipulation = event => {
      if (!event.target.closest?.(".canvas-surface, .rich-page-scroll")) return;
      for (const animation of [...layoutAnimations.values()]) animation.finish();
    };
    update();
    document.documentElement.dataset.inputModality = modality;
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("pointerover", preparePress, true);
    document.addEventListener("pointerdown", directManipulation, true);
    document.addEventListener("keydown", keyboard, true);
    query.addEventListener("change", update);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("pointerover", preparePress, true);
      document.removeEventListener("pointerdown", directManipulation, true);
      document.removeEventListener("keydown", keyboard, true);
      query.removeEventListener("change", update);
    };
  }, []);
}

function play(element, keyframes, spec, finished, retainEnd = false) {
  if (!spec.duration) { finished?.(); return null; }
  const animation = element.animate(keyframes, { duration: spec.duration, easing: spec.easing, fill: "both" });
  active.add(animation);
  animation.finished.then(() => {
    active.delete(animation);
    // Keep the exit endpoint until React removes/hides its retained element;
    // cancelling it first could expose one frame of the underlying open style.
    if (!retainEnd) animation.cancel();
    finished?.();
  }, () => active.delete(animation));
  return animation;
}

/** Retain the same element through exit/reversal; logical close is immediately inert. */
export function useMotionPresence(value, { kind = "popover", identity = "", origin, initial = "animate" } = {}) {
  const retained = useRef(value);
  if (value) retained.current = value;
  const [, render] = useReducer(value => value + 1, 0);
  const element = useRef(null);
  const previous = useRef(null);
  const animations = useRef([]);
  const skipInitial = useRef(initial === "settled" && !!value);
  const open = !!value;
  const displayed = value || retained.current;

  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !displayed) {
      // A deliberate renderer switch (native Page → Browser fallback) can
      // remove the surface entirely. It must not retain an invisible overlay.
      if (!node && !open && retained.current) {
        for (const animation of animations.current) animation?.cancel();
        retained.current = null;
        previous.current = null;
        render();
      }
      return;
    }
    const prior = previous.current;
    if (prior?.open === open && prior.identity === identity && prior.node === node) return;
    if (skipInitial.current) {
      skipInitial.current = false;
      if (open) { previous.current = { open, identity, node }; return; }
    }
    const interrupted = animations.current.some(animation => animation?.playState === "running");
    const panel = kind === "dialog" ? node.querySelector(".modal") : node;
    const currentOpacity = getComputedStyle(node).opacity;
    const currentTransform = panel && getComputedStyle(panel).transform;
    const currentTranslate = getComputedStyle(node).translate;
    const currentScale = getComputedStyle(node).scale;
    for (const animation of animations.current) animation?.cancel();
    animations.current = [];
    previous.current = { open, identity, node };
    node.dataset.motionInterrupted = String(interrupted);
    if (kind === "dialog") panel?.setAttribute("aria-modal", String(open));
    if (origin) node.style.transformOrigin = origin;
    const spec = presenceSpec(kind, open);
    const removed = () => {
      if (!open && previous.current?.open === false) {
        retained.current = null;
        previous.current = null;
        render();
      }
    };
    const fromOpacity = interrupted ? currentOpacity : open ? 0 : 1;
    const toOpacity = open ? 1 : 0;
    if (kind === "dialog") {
      animations.current.push(play(node, [{ opacity: fromOpacity }, { opacity: toOpacity }], spec, removed, !open));
      if (panel && spec.movement) animations.current.push(play(panel, [
        { transform: interrupted ? currentTransform : open ? "translateY(6px) scale(.98)" : "none" },
        { transform: open ? "none" : "translateY(6px) scale(.98)" },
      ], spec));
    } else if (kind === "toast") {
      // Individual translate preserves the toast's static centering transform.
      animations.current.push(play(node, [
        { opacity: fromOpacity, translate: spec.movement ? interrupted ? currentTranslate : open ? "0 6px" : "0 0" : "0 0" },
        { opacity: toOpacity, translate: spec.movement && !open ? "0 6px" : "0 0" },
      ], spec, removed, !open));
    } else if (kind === "popover") {
      // Individual scale preserves anchored positioning, including the
      // outline's static translateY(-50%), instead of replacing that transform.
      animations.current.push(play(node, [
        { opacity: fromOpacity, scale: spec.movement ? interrupted ? currentScale : open ? ".95" : "1" : "1" },
        { opacity: toOpacity, scale: spec.movement && !open ? ".95" : "1" },
      ], spec, removed, !open));
    } else {
      const offset = kind === "sidebar" ? "translateX(-100%)" : kind === "reader" ? "translateX(8px)" : "scale(.95)";
      animations.current.push(play(node, [
        { opacity: fromOpacity, transform: spec.movement ? interrupted ? currentTransform : open ? offset : "none" : "none" },
        { opacity: toOpacity, transform: spec.movement && !open ? offset : "none" },
      ], spec, removed, !open));
    }
  }, [open, identity, kind, origin, !!displayed]);

  useLayoutEffect(() => () => { for (const animation of animations.current) animation?.cancel(); }, []);
  return {
    value: displayed,
    ref: element,
    props: {
      ref: element,
      "data-motion-kind": kind,
      "data-motion-state": open ? "open" : "closing",
      "aria-hidden": open ? undefined : true,
      inert: !open,
    },
  };
}

/** Spatial continuity only: layout settles once; text/card dimensions never scale. */
export function useLayoutMotion(dependencies) {
  const previous = useRef(new Map());
  const mounted = useRef(true);
  const [moving, setMoving] = useState(false);
  useLayoutEffect(() => {
    let frame = null;
    let size = `${document.documentElement.clientWidth}:${document.documentElement.clientHeight}`;
    const resized = () => {
      const nextSize = `${document.documentElement.clientWidth}:${document.documentElement.clientHeight}`;
      if (nextSize === size) return;
      size = nextSize;
      // Responsive layout changes settle immediately and establish a fresh
      // baseline; they must not be mistaken for a later sidebar toggle.
      for (const animation of [...active]) animation.finish();
      const snapshot = () => new Map([...document.querySelectorAll(".workspace, .page-reader-shell:not([hidden])")].map(element => [element, layoutBounds(element)]));
      previous.current = snapshot();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        previous.current = snapshot();
      });
    };
    const observer = new ResizeObserver(resized);
    observer.observe(document.documentElement);
    window.addEventListener("resize", resized);
    return () => { observer.disconnect(); window.removeEventListener("resize", resized); cancelAnimationFrame(frame); };
  }, []);
  useLayoutEffect(() => {
    const elements = [...document.querySelectorAll(".workspace, .page-reader-shell:not([hidden])")];
    const next = new Map();
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const translate = style.translate;
      const components = translate === "none" ? [] : translate.split(" ").map(parseFloat);
      const tx = components[0] || 0, ty = components[1] || 0;
      const transform = style.transform === "none" ? null : new DOMMatrixReadOnly(style.transform);
      const final = { left: rect.left - tx - (transform?.e || 0), top: rect.top - ty - (transform?.f || 0) };
      next.set(element, final);
      const old = previous.current.get(element);
      const animation = layoutAnimations.get(element);
      if (old && motionDuration() && (Math.abs(old.left - final.left + tx) > .5 || Math.abs(old.top - final.top + ty) > .5)) {
        animation?.cancel();
        const running = play(element, [
          { translate: `${old.left - final.left + tx}px ${old.top - final.top + ty}px` },
          { translate: "0px 0px" },
        ], { duration: MOTION.moderate, easing: MOTION.snappy }, () => {
          if (layoutAnimations.get(element) === running) layoutAnimations.delete(element);
          if (mounted.current) setMoving(layoutAnimations.size > 0);
        });
        element.dataset.motionLayout = "translate";
        layoutAnimations.set(element, running);
      } else if (!motionDuration()) {
        animation?.cancel();
        layoutAnimations.delete(element);
      }
    }
    for (const [element, animation] of layoutAnimations) if (!next.has(element)) { animation?.cancel(); layoutAnimations.delete(element); }
    previous.current = next;
    setMoving(layoutAnimations.size > 0);
  }, dependencies);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const animation of layoutAnimations.values()) animation?.cancel(); layoutAnimations.clear(); };
  }, []);
  return moving;
}
