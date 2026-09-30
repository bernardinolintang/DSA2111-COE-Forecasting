// Guided tour: seven deterministic steps across the app, independent of the AI.
//
// Each step names a route and an element ([data-anchor=...]). The tour navigates,
// waits for the element to render, scrolls it into view and spotlights it with a
// card that has Back / Next / Skip and "n of 7". Only one value is stored:
// "coe-tour-seen", so the first-visit offer is not shown again.

import { DURATION, EASING, enter, reducedMotion } from "./motion.js";
import { buildHash, parseHash } from "./route.js";
import { ICONS, esc, store } from "./util.js";

export const TOUR_SEEN = "coe-tour-seen";

export const STEPS = [
  { page: "overview", anchor: "category-cards", title: "Today's market",
    body: "Each card shows today's premium for one COE category and our signal for the next quota quarter. Start here to see whether prices are expected to rise or fall — and how confident that call is." },
  { page: "forecast", category: "A", anchor: "forecast-chart", title: "Read a forecast",
    body: "The dark line is the actual premium. The blue line is the median forecast — the middle estimate. The darker band is the 50% range and the lighter band the 80% range: a wider band means more uncertainty." },
  { page: "forecast", category: "A", anchor: "scenario-picker", title: "Test supply scenarios",
    body: "LTA decides how many COEs to release. See how the forecast changes if next quarter's quota is 10–20% higher or lower than today. More supply usually means lower premiums." },
  { page: "bid", category: "A", anchor: "bid-planner", title: "Plan a bid",
    body: "Move the slider or type a bid to see the estimated chance of winning the next exercise. Everyone who wins pays the same premium, so bidding higher only buys certainty." },
  { page: "policy", category: "B", anchor: "policy-events", title: "Understand why",
    body: "See how past policy changes — loan curbs, quota injections, EV rules — moved each category's premiums. Each event says in plain words what the estimate means, with the statistics one click away." },
  { page: "model", anchor: "model-summary", title: "Why trust the model?",
    body: "We show how accurate the forecasts were on three years of auctions the model never saw, compared with simpler methods — including where it struggles." },
  { page: "alerts", anchor: "watchlist-form", title: "Watch a target",
    body: "Save the premium you're waiting for. Each target is re-scored after every bidding exercise, and we flag changes the next time you open the app." },
];

let state = null;     // { i, spot, card, blocker, onMove, onKey, lastFocus }

function waitFor(selector, timeout = 5000) {
  return new Promise((resolve) => {
    const found = document.querySelector(selector);
    if (found) { resolve(found); return; }
    const mo = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { mo.disconnect(); clearTimeout(timer); resolve(el); }
    });
    mo.observe(document.getElementById("app"), { childList: true, subtree: true });
    const timer = setTimeout(() => { mo.disconnect(); resolve(null); }, timeout);
  });
}

function place() {
  if (!state) return;
  const { spot, card, target } = state;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  if (target && target.isConnected) {
    const r = target.getBoundingClientRect();
    const pad = 8;
    // The first spotlight appears in place; after that it glides from the
    // previous target to the next (CSS transition), so the eye can follow it.
    const firstPlacement = !state.placed;
    if (firstPlacement) spot.style.transition = "none";
    spot.classList.remove("is-waiting");
    Object.assign(spot.style, {
      top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
    if (firstPlacement) { void spot.offsetWidth; spot.style.transition = ""; state.placed = true; }
    if (vw < 600) {
      card.style.cssText = "";
      card.classList.add("tour-card-sheet");
      return;
    }
    card.classList.remove("tour-card-sheet");
    const w = Math.min(380, vw - 32);
    card.style.width = `${w}px`;
    const h = card.offsetHeight;
    const gap = 16;
    const clampTop = (t) => Math.max(gap, Math.min(t, vh - h - gap));
    let top;
    let left = Math.max(gap, Math.min(r.left, vw - w - gap));
    if (r.bottom + gap + h <= vh - gap) top = r.bottom + gap;                    // below
    else if (r.top - gap - h >= gap) top = r.top - gap - h;                      // above
    else if (r.right + gap + w <= vw - gap) { top = clampTop(r.top); left = r.right + gap; }   // beside, right
    else if (r.left - gap - w >= gap) { top = clampTop(r.top); left = r.left - gap - w; }      // beside, left
    else top = vh - h - gap;                                                    // tall and wide: pin to the bottom
    Object.assign(card.style, { top: `${top}px`, left: `${left}px` });
    card.classList.add("is-placed");                                            // later moves glide
  } else {
    // Waiting for the next page's target: keep the page dimmed (no flash of the
    // undimmed page between steps); the ring fades until the target is found.
    spot.classList.add("is-waiting");
    if (!state.placed) Object.assign(spot.style, { top: `${vh / 2}px`, left: `${vw / 2}px`, width: "0px", height: "0px" });
    card.classList.remove("tour-card-sheet");
    const w = Math.min(380, vw - 32);
    Object.assign(card.style, { top: `${Math.max(16, vh / 2 - card.offsetHeight / 2)}px`, left: `${(vw - w) / 2}px`, width: `${w}px` });
  }
}

async function show(i) {
  const step = STEPS[i];
  state.i = i;
  const want = buildHash({ page: step.page, category: step.category });
  const now = parseHash(location.hash);
  if (now.page !== step.page || (step.category && now.category !== step.category)) {
    location.hash = want;
  }
  const { card } = state;
  card.innerHTML = `
    <p class="tour-progress" aria-hidden="true">${STEPS.map((_, k) => `<span class="${k === i ? "on" : ""}"></span>`).join("")}</p>
    <p class="eyebrow" style="margin:0">Step ${i + 1} of ${STEPS.length}</p>
    <h2 class="tour-title" id="tour-title">${esc(step.title)}</h2>
    <p class="tour-body">${esc(step.body)}</p>
    <div class="tour-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-tour="skip">Skip tour</button>
      <span class="grow"></span>
      ${i > 0 ? '<button type="button" class="btn btn-ghost btn-sm" data-tour="back">Back</button>' : ""}
      ${i < STEPS.length - 1
        ? '<button type="button" class="btn btn-sm" data-tour="next">Next</button>'
        : '<button type="button" class="btn btn-sm" data-tour="finish">Finish</button>'}
    </div>
    ${i === STEPS.length - 1 ? `<button type="button" class="btn btn-ghost btn-sm mt-16 tour-ask" data-tour="ask">${ICONS.sparkle}Finish and ask the COE Analyst anything</button>` : ""}
    <p class="visually-hidden" aria-live="polite">Step ${i + 1} of ${STEPS.length}: ${esc(step.title)}</p>`;
  card.querySelectorAll(".tour-title, .tour-body").forEach((el) => enter(el, { rise: 4, duration: DURATION.tab }));
  state.target = null;
  place();
  const target = await waitFor(`[data-anchor="${step.anchor}"]`);
  if (!state || state.i !== i) return;
  state.target = target;
  state.ro?.disconnect();
  if (target) { state.ro = new ResizeObserver(state.onMove); state.ro.observe(target); }
  if (target) {
    // Scroll only when the target is not already fully in view (below the sticky header).
    const r = target.getBoundingClientRect();
    const inView = r.top >= 60 && r.bottom <= window.innerHeight - 8;
    if (!inView) target.scrollIntoView({ block: target.offsetHeight > window.innerHeight * 0.6 ? "start" : "center", behavior: "instant" });
  }
  place();
  card.querySelector('[data-tour="next"], [data-tour="finish"]')?.focus({ preventScroll: true });
}

export function endTour() {
  if (!state) return;
  store.set(TOUR_SEEN, true);
  state.ro?.disconnect();
  window.removeEventListener("resize", state.onMove);
  window.removeEventListener("scroll", state.onMove, true);
  document.removeEventListener("keydown", state.onKey, true);
  const { spot } = state;
  state.blocker.remove();                     // the page is usable at once
  state.card.remove();
  // The dimming lifts gently instead of snapping off.
  spot.classList.add("is-leaving");
  if (reducedMotion() || !spot.animate) spot.remove();
  else {
    spot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DURATION.tab, easing: EASING.out, fill: "forwards" })
      .finished.catch(() => {}).then(() => spot.remove());
  }
  document.body.classList.remove("touring");
  const focus = state.lastFocus;
  state = null;
  if (focus?.isConnected) focus.focus({ preventScroll: true });
  document.dispatchEvent(new CustomEvent("coe:tour-ended"));
}

export function isTouring() { return Boolean(state); }

export function startTour(step = 1) {
  document.querySelector(".tour-offer")?.remove();
  document.dispatchEvent(new CustomEvent("coe:tour-start"));   // e.g. the analyst panel steps aside
  if (state) { show(Math.max(0, Math.min(STEPS.length - 1, step - 1))); return; }
  const blocker = document.createElement("div");
  blocker.className = "tour-blocker";
  const spot = document.createElement("div");
  spot.className = "tour-spot is-waiting";
  const card = document.createElement("div");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "tour-title");
  document.body.append(blocker, spot, card);
  document.body.classList.add("touring");

  let frame;
  const onMove = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); endTour(); return; }
    if (e.key === "Tab") {                                     // keep focus inside the tour card
      const items = [...card.querySelectorAll("button")];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  };
  card.addEventListener("click", (e) => {
    const action = e.target.closest("[data-tour]")?.dataset.tour;
    if (!action || !state) return;
    if (action === "next") show(state.i + 1);
    else if (action === "back") show(state.i - 1);
    else if (action === "skip" || action === "finish") endTour();
    else if (action === "ask") { endTour(); document.dispatchEvent(new CustomEvent("coe:open-analyst")); }
  });
  window.addEventListener("resize", onMove);
  window.addEventListener("scroll", onMove, true);
  document.addEventListener("keydown", onKey, true);
  state = { i: 0, spot, card, blocker, onMove, onKey, target: null, placed: false, lastFocus: document.activeElement };
  show(Math.max(0, Math.min(STEPS.length - 1, step - 1)));
}

/** First visit: offer the tour, never force it. */
export function offerTour() {
  if (store.get(TOUR_SEEN, false) || document.querySelector(".tour-offer")) return;
  const el = document.createElement("div");
  el.className = "tour-offer";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", "Take a tour");
  el.innerHTML = `<div><strong>New to COE Forecast?</strong><div class="small muted">Take a 2-minute tour of what everything means.</div></div>
    <div class="row"><button type="button" class="btn btn-sm" data-offer="start">Take the tour</button>
    <button type="button" class="btn btn-ghost btn-sm" data-offer="dismiss">Not now</button></div>`;
  el.addEventListener("click", (e) => {
    const action = e.target.closest("[data-offer]")?.dataset.offer;
    if (!action) return;
    el.remove();
    store.set(TOUR_SEEN, true);
    if (action === "start") startTour(1);
  });
  document.body.appendChild(el);
}
