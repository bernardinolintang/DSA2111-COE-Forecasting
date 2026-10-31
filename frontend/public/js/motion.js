// Motion system: one place for durations, easing and the few animation helpers
// the app uses. No library: the Web Animations API, requestAnimationFrame tweens
// and (for Overview -> Forecast) the native View Transition API.
//
// Principles: motion explains what changed, never blocks input, and is always
// interruptible. With prefers-reduced-motion, movement is replaced by an
// immediate change plus a short opacity cue, so feedback is never lost.
//
// The durations mirror the --dur-* tokens in styles.css; keep the two in step.

export const DURATION = {
  micro: 140,     // button feedback, number nudges
  hover: 180,
  tab: 220,       // segmented / category indicator
  card: 260,      // charts, cards, reveals
  drawer: 280,    // analyst drawer, tour spotlight
  route: 300,     // page and shared-element transitions
};

// these are CSS strings for the Web Animations API (same curves as --ease-out etc.) so that JS and
// CSS animate alike
export const EASING = {
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
};

// these are JS versions for rAF tweens so that number counters ease the same way as CSS
const easeOut = (t) => 1 - (1 - t) ** 4;                     // close to the CSS ease-out above
const easeInOut = (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2);
export const EASE_FN = { out: easeOut, inOut: easeInOut, linear: (t) => t };

// this checks the OS setting so that animations can respect reduced motion
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const reducedMotion = () => Boolean(mq?.matches);

// this mixes two values so that anything can be animated between them
const lerp = (a, b, t) => a + (b - a) * t;
export { lerp };

// ---------------------------------------------------------------------------
// Tweens
// ---------------------------------------------------------------------------
/**
 * Run onUpdate(t) with eased t from 0 to 1 over `duration` ms, one frame at a
 * time; only runs while animating. Returns { cancel() }.
 */
export function tween({ duration = DURATION.card, easing = "out", onUpdate, onDone }) {
  const ease = EASE_FN[easing] || easeOut;
  let start = null;
  let frame = requestAnimationFrame(function step(now) {
    start ??= now;
    const p = Math.min(1, (now - start) / duration);
    onUpdate(ease(p));
    if (p < 1) frame = requestAnimationFrame(step);
    else { frame = null; onDone?.(); }
  });
  return { cancel() { if (frame) cancelAnimationFrame(frame); frame = null; } };
}

// ---------------------------------------------------------------------------
// Animated numbers
// ---------------------------------------------------------------------------
// these remember each number's state so that a new value can animate from what is on screen
const numbers = new WeakMap();   // el -> { shown, anim }
const busyCount = new WeakMap();

// while a number counts its live region is marked aria-busy so that screen readers announce the
// final value once, it is counted because several numbers can share one region
function setBusy(el, on) {
  const region = el.closest?.("[aria-live]") || el;
  const n = Math.max(0, (busyCount.get(region) || 0) + (on ? 1 : -1));
  busyCount.set(region, n);
  if (n) region.setAttribute("aria-busy", "true"); else region.removeAttribute("aria-busy");
}

/**
 * Show `value` in `el` using `format(v) -> string`. The first value appears
 * immediately; later changes interpolate from what is currently on screen, so
 * rapid changes retarget smoothly instead of queueing. Only formatted values
 * (e.g. whole dollars) are ever shown. `animate: false` sets it instantly.
 */
export function animateNumber(el, value, { format = String, duration = DURATION.card, animate = true } = {}) {
  if (!el) return;
  const s = numbers.get(el);
  // this cancels a running animation so that a new value takes over smoothly
  if (s?.anim) { s.anim.cancel(); s.anim = null; setBusy(el, false); }
  const valid = typeof value === "number" && Number.isFinite(value);
  const fromValid = s && typeof s.shown === "number" && Number.isFinite(s.shown);
  if (!valid || !fromValid || !animate || s.shown === value) {
    numbers.set(el, { shown: value, anim: null });
    el.textContent = format(value);
    return;
  }
  if (reducedMotion()) {                   // no counting; a brief fade marks the change
    const changed = format(s.shown) !== format(value);
    numbers.set(el, { shown: value, anim: null });
    el.textContent = format(value);
    if (changed) pulse(el);
    return;
  }
  const from = s.shown;
  const state = { shown: from, anim: null };
  numbers.set(el, state);
  setBusy(el, true);
  state.anim = tween({
    duration,
    onUpdate: (t) => {
      state.shown = t === 1 ? value : lerp(from, value, t);
      const text = format(state.shown);
      if (el.textContent !== text) el.textContent = text;
    },
    onDone: () => { state.shown = value; state.anim = null; setBusy(el, false); },
  });
}

/** Forget an element's number so the next value is shown without animating. */
export function resetNumber(el) { numbers.delete(el); }

/** A short opacity dip: "this changed" without movement (reduced motion). */
export function pulse(el) {
  el?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: DURATION.card, easing: EASING.out });
}

// ---------------------------------------------------------------------------
// Content swaps and entrances
// ---------------------------------------------------------------------------
// this tracks each element's swap so that a newer one can cancel the older one
const swaps = new WeakMap();

/**
 * Replace an element's content with a calm out/in: old content fades and moves
 * `distance`px up, new content arrives from `distance`px below. ~220ms total.
 * `apply()` performs the whole DOM change (it may run later, or be superseded by
 * a newer swap, so it must set the complete state). With `key`, a call whose key
 * matches the previous one updates silently; `animate: false` applies at once
 * (first render) and just records the key.
 */
export function swap(el, apply, { distance = 5, key, animate = true } = {}) {
  if (!el) return;
  const k = key ?? null;
  const prev = swaps.get(el);
  // this just updates when the key is the same so that a small change does not flash
  if (k !== null && prev?.key === k) { prev.pending ? (prev.apply = apply) : apply(); return; }   // same state
  prev?.anim?.cancel();
  const entry = { key: k, anim: null, apply, pending: false };
  swaps.set(el, entry);
  if (!animate || !el.animate || !el.isConnected) { apply(); return; }
  if (reducedMotion()) { apply(); pulse(el); return; }
  entry.pending = true;
  const out = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${-distance}px)` }],
    { duration: 90, easing: EASING.in, fill: "forwards" });
  entry.anim = out;
  out.onfinish = () => {
    if (swaps.get(el) !== entry) return;
    entry.pending = false;
    entry.apply();
    entry.anim = el.animate([{ opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: "none" }],
      { duration: 130, easing: EASING.out });
    out.cancel();
  };
}

/** Subtle entrance for newly inserted content (opacity, plus a small rise). */
export function enter(el, { rise = 6, duration = DURATION.card, delay = 0 } = {}) {
  if (!el?.animate) return null;
  const r = reducedMotion() ? 0 : rise;
  return el.animate([{ opacity: 0, transform: `translateY(${r}px)` }, { opacity: 1, transform: "none" }],
    { duration: reducedMotion() ? DURATION.micro : duration, delay, easing: EASING.out, fill: "backwards" });
}

/** Collapse an element (height, margin, opacity) and resolve when done. */
export function collapse(el, { gap = 0 } = {}) {
  if (!el?.animate || reducedMotion()) return Promise.resolve();
  const h = el.offsetHeight;
  el.style.overflow = "hidden";
  const a = el.animate([
    { height: `${h}px`, opacity: 1, marginBottom: "0px" },
    { height: "0px", opacity: 0, marginBottom: `${-gap}px`, paddingTop: "0px", paddingBottom: "0px" },
  ], { duration: DURATION.card, easing: EASING.inOut, fill: "forwards" });
  return a.finished.catch(() => {});
}

/**
 * FLIP: call before a DOM change to record where keyed children are; the
 * returned function, called after the change, glides survivors to their new
 * places and fades new ones in.
 */
export function flip(container, key) {
  const before = new Map([...container.querySelectorAll(`[${key}]`)].map((el) => [el.getAttribute(key), el.getBoundingClientRect()]));
  return () => {
    if (!container.isConnected) return;
    const reduced = reducedMotion();
    container.querySelectorAll(`[${key}]`).forEach((el, i) => {
      const old = before.get(el.getAttribute(key));
      if (!old) { enter(el, { delay: Math.min(i, 4) * 30 }); return; }
      const now = el.getBoundingClientRect();
      const dy = old.top - now.top;
      if (Math.abs(dy) > 0.5 && !reduced) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: DURATION.card, easing: EASING.out });
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Sliding selection indicator (segmented controls, main navigation)
// ---------------------------------------------------------------------------
/**
 * Adds one "thumb" behind the active item of `group` and slides it when the
 * active item changes (watched through `attr`, so every code path that presses
 * a button moves it). Before JS runs, CSS still styles the active item.
 */
export function attachThumb(group, { items = "button", attr = "aria-pressed", isActive, tag = "span" } = {}) {
  if (!group || group.querySelector(":scope > .seg-thumb")) return;
  const active = isActive || ((el) => el.getAttribute(attr) === "true");
  const thumb = document.createElement(tag);
  thumb.className = "seg-thumb";
  thumb.setAttribute("aria-hidden", "true");
  if (tag === "li") thumb.setAttribute("role", "presentation");
  group.prepend(thumb);
  group.classList.add("has-thumb");
  let placed = false;
  let mo;
  let ro;
  // this moves the thumb to the active item so that the selection always shows the real state
  function sync() {
    if (!group.isConnected) { mo.disconnect(); ro.disconnect(); return; }
    const el = [...group.querySelectorAll(items)].find(active);
    // this hides the thumb when the item has no size so that it does not sit at 0,0
    if (!el || !el.offsetWidth) { thumb.style.opacity = "0"; placed = false; return; }
    const instant = !placed || reducedMotion();
    if (instant) thumb.style.transition = "none";
    thumb.style.width = `${el.offsetWidth}px`;
    thumb.style.height = `${el.offsetHeight}px`;
    thumb.style.transform = `translate(${el.offsetLeft}px, ${el.offsetTop}px)`;
    thumb.style.opacity = "1";
    // this forces a reflow before turning transitions back on so that the first move does not
    // animate
    if (instant) { void thumb.offsetWidth; thumb.style.transition = ""; }
    placed = true;
  }
  // this watches for attribute changes and resizes so that the thumb stays in the right place
  mo = new MutationObserver(sync);
  mo.observe(group, { attributes: true, subtree: true, attributeFilter: [attr] });
  ro = new ResizeObserver(sync);
  ro.observe(group);
  sync();
}

// ---------------------------------------------------------------------------
// Shared-element navigation (View Transition API)
// ---------------------------------------------------------------------------
// this is the waiting transition so that the router can pick it up on the next route
let pendingShared = null;

export const supportsViewTransitions = () => typeof document !== "undefined" && typeof document.startViewTransition === "function";

/**
 * Called by a link just before navigation: the next route change morphs the
 * elements named here into the destination's elements with the same
 * view-transition-name. `route` is the hash the transition applies to.
 */
export function requestShared(route, named) {
  if (!supportsViewTransitions() || reducedMotion()) return;
  clearShared();
  for (const [el, name] of named) if (el) el.style.viewTransitionName = name;
  pendingShared = { route, named, className: "vt-category" };
}

// this gives the router the waiting transition if it matches so that it only runs on the right
// route
export function takeShared(hash) {
  const p = pendingShared;
  pendingShared = null;
  if (p && p.route === hash) return p;
  if (p) for (const [el] of p.named) if (el) el.style.viewTransitionName = "";
  return null;
}

// this clears any old names so that two elements never share a transition name
function clearShared() {
  if (!pendingShared) return;
  for (const [el] of pendingShared.named) if (el) el.style.viewTransitionName = "";
  pendingShared = null;
}
