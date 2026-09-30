// COE Analyst: a side panel that explains what the viewer is looking at.
//
// * Context: the current page publishes identifiers (page, category, scenario,
//   bid, event) via context.js; the server rebuilds the numbers from the
//   database. The header shows the page's own facts so the viewer can see what
//   the analyst is looking at.
// * Actions: the server returns validated actions from a fixed whitelist. Safe
//   ones (navigate, set scenario/bid, highlight, tour) run automatically;
//   watchlist changes are shown as a confirmation card and only happen on click.
// * Failure: if the analyst is unreachable the panel says so and the rest of the
//   app is unaffected. No API key ever reaches the browser.

import { api } from "./api.js";
import { getView, onView, pageAction } from "./context.js";
import { DURATION, EASING, enter, reducedMotion } from "./motion.js";
import { buildHash, parseHash } from "./route.js";
import { startTour } from "./tour.js";
import { ICONS, clientId, esc, html, money, raw, toast } from "./util.js";

const THREAD_KEY = "coe-analyst-thread";
const MAX_TURNS_SENT = 12;
const TIMEOUT_MS = 75_000;
const PAGE_NAMES = { overview: "Overview", forecast: "Forecast", bid: "Bid planner", policy: "Policy Lab", model: "Model", alerts: "Watchlist" };
const SCENARIO_NAMES = { base: "As announced", quota_minus_20: "−20% supply", quota_minus_10: "−10% supply", quota_plus_10: "+10% supply", quota_plus_20: "+20% supply" };
const HIGHLIGHT = {
  "category-cards": "category-cards", "forecast-chart": "forecast-chart", recommendation: "recommendation",
  "scenario-picker": "scenario-picker", "forecast-table": "forecast-table", "bid-chart": "bid-chart",
  "bid-suggestions": "bid-suggestions", "policy-chart": "policy-chart", "policy-events": "policy-events",
  "model-summary": "model-summary", leaderboard: "leaderboard", "error-by-horizon": "error-by-horizon",
  "watchlist-form": "watchlist-form",
};

const SUGGESTIONS = {
  overview: ["Explain this page like I'm buying my first car", "Why do all categories say Lean buy?", "What's the difference between Cat A and Cat B?"],
  forecast: ["Why is this saying {label}?", "What does the 80% range mean?", "How certain is this forecast?", "What if supply rises 10%?"],
  bid: ["How much should I bid for a 90% chance?", "Why does a higher bid not cost more?", "What does chance of winning mean?"],
  policy: ["What changed Cat {cat} prices the most?", "What does n.s. mean?", "Does an increase in quota usually reduce premiums?"],
  model: ["Why should I trust this model?", "Why is the model less certain further ahead?", "What is sMAPE?"],
  alerts: ["Alert me when Cat A falls below $120k", "How does the watchlist tell me about changes?"],
};

let panel = null;
let fab = null;
let thread = [];              // [{ role, content, actions?, provenance?, notice?, mode?, error?, question? }]
let busy = false;
let status = null;
let lastFocus = null;

function load() {
  try { thread = (JSON.parse(sessionStorage.getItem(THREAD_KEY)) || []).filter((m) => !m.pending); } catch { thread = []; }
}
function save() {
  const done = thread.filter((m) => !m.pending).slice(-30)
    .map(({ shown, revealAfter, final, ...m }) => m);            // drop streaming bookkeeping
  try { sessionStorage.setItem(THREAD_KEY, JSON.stringify(done)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/** Minimal, safe formatting: paragraphs, "- " bullets and **bold**, all escaped first. */
export function formatReply(text) {
  const blocks = String(text || "").trim().split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-•*]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

function describeView(v) {
  const bits = [PAGE_NAMES[v.page] || "COE Forecast"];
  if (v.category) bits.unshift(`Cat ${v.category}`);
  if (v.page === "forecast" && v.scenario) bits.push(SCENARIO_NAMES[v.scenario] || v.scenario);
  return bits.join(" · ");
}

function paintContext() {
  if (!panel) return;
  const v = getView();
  panel.querySelector("#analyst-where").textContent = describeView(v);
  const facts = (v.facts || []).slice(0, 6);
  panel.querySelector("#analyst-facts").innerHTML = facts.map((f) =>
    `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join("");
  const label = (v.facts || []).find((f) => f.label === "Recommendation")?.value.split(" · ")[0] || "Buy now";
  const signals = new Set((v.facts || []).filter((f) => /^Cat [A-E]$/.test(f.label)).map((f) => f.value.split(" · ")[1]));
  const allSame = signals.size === 1 ? [...signals][0] : null;
  const list = (SUGGESTIONS[v.page] || SUGGESTIONS.overview)
    .map((s) => s.replace("{label}", label).replace("{cat}", v.category || "B")
      .replace("Why do all categories say Lean buy?", allSame ? `Why do all categories say ${allSame}?` : "Which category has the clearest signal?"));
  panel.querySelector("#analyst-suggest").innerHTML = list.map((s) =>
    `<button type="button" class="chip-q" data-q="${esc(s)}">${esc(s)}</button>`).join("");
}

function actionCard(a, index, msgIndex) {
  if (!a.confirm) return html`<div class="action-chip">${raw(ICONS.send)}${a.summary}</div>`;
  const state = a.state || "pending";
  if (state === "done") return html`<div class="action-chip is-done">${raw(ICONS.check)}${a.summary} — done</div>`;
  if (state === "cancelled") return html`<div class="action-chip is-muted">${a.summary} — cancelled</div>`;
  return html`<div class="confirm-card" role="group" aria-label="Confirm: ${a.summary}">
    <div class="small"><strong>${a.summary}</strong></div>
    <div class="caption">Nothing is saved until you confirm.</div>
    <div class="row mt-8">
      <button type="button" class="btn btn-sm" data-confirm="${msgIndex}:${index}"${state === "working" ? " disabled" : ""}>${state === "working" ? "Saving…" : a.type === "prepare_remove_watch" ? "Confirm removal" : "Confirm"}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cancel="${msgIndex}:${index}">Cancel</button>
    </div></div>`;
}

function withCaret(markup) {
  const i = Math.max(markup.lastIndexOf("</p>"), markup.lastIndexOf("</li>"));
  return i < 0 ? `${markup}<span class="caret"></span>` : `${markup.slice(0, i)}<span class="caret"></span>${markup.slice(i)}`;
}

function botBubble(m, i) {
  if (m.error) {
    return `<div class="msg msg-bot is-error" data-msg="${i}"><div class="bubble"><p>${esc(m.content)}</p>
      <button type="button" class="btn btn-ghost btn-sm mt-8" data-retry="${i}">Try again</button></div></div>`;
  }
  if (m.pending && !m.shown) {                                     // nothing to show yet: the thinking state
    return `<div class="msg msg-bot" data-msg="${i}"><div class="bubble thinking" role="status">
      <span class="typing" aria-hidden="true"><span></span><span></span><span></span></span>
      <span class="thinking-text">${esc(m.status || "Thinking…")}</span></div></div>`;
  }
  const text = m.pending ? m.content.slice(0, m.shown) : m.content;
  const appear = m.appear ? " appear" : "";                        // fade in once, when text first shows
  m.appear = false;
  return `<div class="msg msg-bot" data-msg="${i}"><div class="bubble${appear}">
    ${!m.pending && m.notice ? `<p class="notice">${esc(m.notice)}</p>` : ""}
    <div class="reply">${m.pending ? withCaret(formatReply(text)) : formatReply(text)}</div>
    ${m.pending ? "" : (m.actions || []).map((a, k) => String(actionCard(a, k, i))).join("")}
    ${!m.pending && m.provenance ? `<p class="provenance">${esc(m.provenance)}</p>` : ""}
  </div></div>`;
}

function nearBottom(list) { return list.scrollHeight - list.scrollTop - list.clientHeight < 60; }

function paintThread() {
  if (!panel) return;
  const list = panel.querySelector("#analyst-log");
  if (!thread.length) {
    list.innerHTML = `<div class="analyst-empty"><p><strong>Ask about what you're looking at.</strong></p>
      <p class="small muted">I use this app's own forecasts and data, say when something is a forecast rather than a fact, and can open pages or set up the planner for you.</p></div>`;
  } else {
    list.innerHTML = thread.map((m, i) => (m.role === "user"
      ? `<div class="msg msg-user"><div class="bubble">${esc(m.content)}</div></div>` : botBubble(m, i))).join("");
  }
  list.scrollTop = list.scrollHeight;
  const sendBtn = panel.querySelector(".analyst-send");
  sendBtn.disabled = busy;
  sendBtn.setAttribute("aria-label", busy ? "The analyst is answering" : "Send");
}

/** Re-render only the message being streamed (cheap, keeps scroll pinned). */
function paintMessage(i) {
  const list = panel?.querySelector("#analyst-log");
  const el = list?.querySelector(`[data-msg="${i}"]`);
  if (!el) { paintThread(); return; }
  const pinned = nearBottom(list);
  el.outerHTML = botBubble(thread[i], i);
  if (pinned) list.scrollTop = list.scrollHeight;
}

function paintStatus() {
  const badge = panel?.querySelector("#analyst-mode");
  if (!badge) return;
  if (!status) { badge.hidden = true; return; }
  badge.hidden = false;
  const provider = { groq: "Groq", anthropic: "Claude" }[status.provider];
  badge.textContent = status.mode === "llm" ? `AI${provider ? ` · ${provider}` : ""}` : "Basic mode";
  badge.title = status.mode === "llm"
    ? `Answers are written by ${status.model}${provider ? ` on ${provider}` : ""} from this app's data.`
    : "No AI model is configured on this server. I can still navigate, work out bids, explain terms and recommendations.";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function go(params) {
  const hash = buildHash(params);
  if (location.hash !== hash) location.hash = hash;
}

function flash(anchor) {
  const el = document.querySelector(`[data-anchor="${HIGHLIGHT[anchor]}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("is-highlighted");
  void el.offsetWidth;
  el.classList.add("is-highlighted");
}

/** Run one non-persistent action from the whitelist. */
export function perform(a) {
  const v = getView();
  const p = a.params || {};
  switch (a.type) {
    case "navigate": {
      const here = parseHash(location.hash);
      if (p.page === "policy" && here.page === "policy" && pageAction("setCategory")) {
        if (p.category) pageAction("setCategory")(p.category);
        if (p.event) pageAction("highlightEvent")(p.event);
        return;
      }
      go(p);
      return;
    }
    case "set_supply_scenario": {
      const cat = p.category || v.category || "A";
      if (v.page === "forecast" && v.category === cat && pageAction("setScenario")) pageAction("setScenario")(p.scenario);
      else go({ page: "forecast", category: cat, scenario: p.scenario });
      return;
    }
    case "set_bid_amount": {
      const cat = p.category || v.category || "A";
      if (v.page === "bid" && v.category === cat && pageAction("setBid")) pageAction("setBid")(p.amount);
      else go({ page: "bid", category: cat, bid: p.amount });
      return;
    }
    case "highlight":
      flash(p.target);
      return;
    case "open_tutorial":
      close();
      startTour(p.step || 1);
      return;
    default:
      // Persistent actions (prepare_watch / prepare_remove_watch) never run here.
  }
}

async function confirmAction(mi, ai) {
  const a = thread[mi]?.actions?.[ai];
  if (!a || a.state === "done" || a.state === "working") return;
  a.state = "working";
  paintThread();
  try {
    if (a.type === "prepare_watch") {
      const p = a.params;
      await api.post("/alerts", { client_id: clientId(), category: p.category, direction: p.direction,
                                  target: p.target, label: p.note || null });
      toast(`Watching Cat ${p.category} ${p.direction} ${money(p.target)}`);
    } else if (a.type === "prepare_remove_watch") {
      await api.del(`/alerts/${a.params.id}?client_id=${clientId()}`);
      toast("Removed from your watchlist");
    }
    a.state = "done";
    document.dispatchEvent(new CustomEvent("coe:watchlist-changed"));
  } catch (err) {
    a.state = "pending";
    toast(err.message);
  }
  save();
  paintThread();
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
// ---- Showing the answer ------------------------------------------------------
// The thinking dots stay up for at least MIN_THINKING_MS so a fast answer never
// just flickers. After that, streamed text is shown exactly as it arrives (real
// streaming, with a caret while more is coming; no typewriter effect), and an
// answer that arrives in one piece fades in once. Repaints are batched per frame.
const MIN_THINKING_MS = 450;
let revealFrame = 0;

function schedule() { if (!revealFrame) revealFrame = requestAnimationFrame(tick); }

function tick() {
  revealFrame = 0;
  const i = thread.length - 1;
  const m = thread[i];
  if (!m?.pending) return;
  if (performance.now() < m.revealAfter || (!m.content && !m.final)) { schedule(); return; }
  if (m.shown < m.content.length) {
    if (!m.shown) m.appear = true;
    m.shown = m.content.length;
    if (panel && !panel.hidden) paintMessage(i);
  }
  if (m.final) finish(i);
}

function finish(i) {
  const m = thread[i];
  Object.assign(m, m.final);
  delete m.pending;
  busy = false;
  save();
  paintThread();
  if (status && m.mode && m.mode !== status.mode && !m.notice) { status.mode = m.mode; paintStatus(); }
  for (const a of m.actions || []) if (!a.confirm) perform(a);
}

function fail(i, message) {
  const m = thread[i];
  if (!m?.pending) return;
  if (m.content) {                                              // keep what arrived, say it was cut short
    m.content += "\n\n(The connection dropped before the answer finished.)";
    m.final = { actions: [], provenance: null, notice: null, mode: m.mode };
    schedule();
    return;
  }
  thread[i] = { role: "assistant", content: message, error: true, question: m.question };
  busy = false;
  save();
  paintThread();
}

function parseEvent(raw) {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  try { return { event, data: data ? JSON.parse(data) : {} }; } catch { return { event, data: {} }; }
}

function onEvent(i, { event, data }) {
  const m = thread[i];
  if (!m?.pending) return;
  if (event === "status") {
    m.status = data.text;
    if (!m.shown && panel && !panel.hidden) paintMessage(i);
  } else if (event === "delta") {
    m.content += data.text || "";
    schedule();
  } else if (event === "done") {
    m.final = { actions: data.actions || [], provenance: data.provenance, notice: data.notice, mode: data.mode };
    schedule();
  } else if (event === "error") {
    fail(i, `The analyst isn't available right now (${data.text || "error"}). The rest of the app still works.`);
  }
}

export async function send(question) {
  question = String(question || "").trim();
  if (!question || busy) return;
  if (question.length > 1000) { toast("Please keep questions under 1,000 characters."); return; }
  open();
  const input = panel.querySelector("#analyst-input");
  input.value = "";
  resize(input);

  const v = getView();
  const view = { page: v.page || "overview" };
  if (v.category) view.category = v.category;
  if (v.page === "forecast" && v.scenario) view.scenario = v.scenario;
  if (v.page === "bid" && v.bid) view.bid = v.bid;
  if (v.page === "policy" && v.event) view.event = v.event;
  thread.push({ role: "user", content: question });
  const messages = thread.filter((m) => !m.error && !m.pending)
    .map((m) => ({ role: m.role, content: m.content })).slice(-MAX_TURNS_SENT);
  const i = thread.push({ role: "assistant", pending: true, content: "", shown: 0, status: "Thinking…", question,
                          revealAfter: performance.now() + MIN_THINKING_MS }) - 1;
  busy = true;
  save();
  paintThread();
  enter([...panel.querySelectorAll("#analyst-log .msg-user .bubble")].at(-1), { rise: 6, duration: DURATION.tab });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("/api/analyst/chat?stream=1", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ messages, view, client_id: clientId() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join(", ") : data.detail;
      throw new Error(detail || `The analyst returned an error (${res.status}).`);
    }
    if ((res.headers.get("content-type") || "").includes("text/event-stream") && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          onEvent(i, parseEvent(buffer.slice(0, cut)));
          buffer = buffer.slice(cut + 2);
        }
      }
      if (thread[i]?.pending && !thread[i].final) throw new Error("the answer was cut off");
    } else {                                                    // a plain JSON answer
      const data = await res.json();
      onEvent(i, { event: "delta", data: { text: data.reply } });
      onEvent(i, { event: "done", data });
    }
  } catch (err) {
    fail(i, err.name === "AbortError"
      ? "The analyst took too long to answer. The rest of the app still works — try again in a moment."
      : `The analyst isn't available right now (${err.message}). The rest of the app still works.`);
  } finally {
    clearTimeout(timer);
  }
}

function retry(i) {
  const m = thread[i];
  if (!m?.question) return;
  if (busy) return;
  thread.splice(i - 1, 2);                                        // drop the failed question + error
  send(m.question);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function resize(t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 140)}px`; }

function build() {
  panel = document.createElement("aside");
  panel.className = "analyst";
  panel.id = "analyst";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "analyst-title");
  panel.innerHTML = `
    <header class="analyst-head">
      <div class="row" style="gap:8px">${ICONS.sparkle}<h2 id="analyst-title">COE Analyst</h2>
        <span class="pill pill-neutral" id="analyst-mode" hidden></span></div>
      <div class="row" style="gap:2px">
        <button type="button" class="btn btn-ghost btn-sm" id="analyst-clear">New chat</button>
        <button type="button" class="icon-btn" id="analyst-close" aria-label="Close the analyst">${ICONS.close}</button>
      </div>
    </header>
    <section class="analyst-context" aria-label="What the analyst can see">
      <div class="caption">You're viewing</div>
      <div class="analyst-where" id="analyst-where"></div>
      <dl class="analyst-facts" id="analyst-facts"></dl>
    </section>
    <div class="analyst-log" id="analyst-log" aria-live="polite"></div>
    <div class="analyst-suggest" id="analyst-suggest" aria-label="Suggested questions"></div>
    <form class="analyst-compose" id="analyst-form">
      <label class="visually-hidden" for="analyst-input">Ask the COE Analyst</label>
      <textarea id="analyst-input" rows="1" maxlength="1000" placeholder="Ask about this page…"></textarea>
      <button type="submit" class="btn analyst-send" aria-label="Send">${ICONS.send}</button>
    </form>
    <p class="analyst-foot">Forecasts are probabilistic estimates, not financial advice.</p>`;
  document.body.appendChild(panel);

  const input = panel.querySelector("#analyst-input");
  panel.querySelector("#analyst-form").addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(input.value); }
  });
  input.addEventListener("input", () => resize(input));
  panel.querySelector("#analyst-close").addEventListener("click", () => close());
  panel.querySelector("#analyst-clear").addEventListener("click", () => { thread = []; save(); paintThread(); input.focus(); });
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  panel.addEventListener("click", (e) => {
    const q = e.target.closest("[data-q]");
    if (q) { send(q.dataset.q); return; }
    const c = e.target.closest("[data-confirm]");
    if (c) { const [mi, ai] = c.dataset.confirm.split(":").map(Number); confirmAction(mi, ai); return; }
    const x = e.target.closest("[data-cancel]");
    if (x) {
      const [mi, ai] = x.dataset.cancel.split(":").map(Number);
      const a = thread[mi]?.actions?.[ai];
      if (a) { a.state = "cancelled"; save(); paintThread(); }
      return;
    }
    const r = e.target.closest("[data-retry]");
    if (r) retry(Number(r.dataset.retry));
  });
  onView(paintContext);
}

let closing = null;             // the drawer's exit animation, while it runs

export function open() {
  if (!panel) build();
  if (closing) {                // reopened mid-exit: stay open
    closing.cancel();
    closing = null;
    fab?.setAttribute("aria-expanded", "true");
    panel.querySelector("#analyst-input").focus();
    return;
  }
  if (!panel.hidden) return;
  lastFocus = document.activeElement;
  panel.hidden = false;
  document.body.classList.add("analyst-open");
  fab?.setAttribute("aria-expanded", "true");
  paintContext();
  paintThread();
  paintStatus();
  panel.querySelector("#analyst-input").focus();
  if (!status) {
    api.get("/analyst/status").then((s) => { status = s; paintStatus(); }).catch(() => {});
  }
}

export function close() {
  if (!panel || panel.hidden || closing) return;
  fab?.setAttribute("aria-expanded", "false");
  const done = () => {
    closing = null;
    panel.hidden = true;
    document.body.classList.remove("analyst-open");
    (lastFocus?.isConnected ? lastFocus : fab)?.focus({ preventScroll: true });
  };
  // The drawer slides back out to the edge it came from (a fade with reduced motion).
  if (!panel.animate) { done(); return; }
  closing = panel.animate(
    reducedMotion() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: "none" }, { transform: "translateX(100%)" }],
    { duration: DURATION.drawer - 60, easing: EASING.in, fill: "forwards" });
  closing.onfinish = () => { const a = closing; done(); a?.cancel(); };
}

export function installAnalyst() {
  load();
  fab = document.createElement("button");
  fab.type = "button";
  fab.className = "analyst-fab";
  fab.setAttribute("aria-controls", "analyst");
  fab.setAttribute("aria-expanded", "false");
  fab.innerHTML = `${ICONS.sparkle}<span>Ask COE Analyst</span>`;
  fab.addEventListener("click", () => (panel && !panel.hidden ? close() : open()));
  document.body.appendChild(fab);
  document.addEventListener("coe:ask", (e) => send(e.detail?.question));
  document.addEventListener("coe:open-analyst", () => open());
  document.addEventListener("coe:tour-start", () => close());    // the tour needs the whole page
}
