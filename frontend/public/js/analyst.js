// Ask Compass: a side panel that explains what the viewer is looking at. It is
// opened from the header on every page, so it is part of the app rather than a
// separate chatbot page.
//
// * Context: the current page publishes identifiers (page, category, quota
//   change, bid, event) via context.js; the server rebuilds the numbers from the
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
import { buildHash, clampQuota, parseHash, scenarioPct } from "./route.js";
import { scenarioLabel } from "./forecast-math.js";
import { startTour } from "./tour.js";
import { ICONS, clientId, esc, html, money, raw, toast } from "./util.js";

// these are the storage key and limits so that the chat stays small and cannot hang
const THREAD_KEY = "coe-analyst-thread";
const MAX_TURNS_SENT = 12;
const TIMEOUT_MS = 75_000;
const PAGE_NAMES = { overview: "Overview", forecast: "Forecast", scenario: "Scenario Lab", bid: "Bid planner", plan: "My plan",
                     policy: "Policy Lab", model: "Model performance", alerts: "Watchlist", learn: "Learn" };
// this maps action targets to page anchors so that the panel can highlight them
const HIGHLIGHT = {
  "category-cards": "category-cards", "forecast-chart": "forecast-chart", recommendation: "recommendation",
  "scenario-picker": "scenario-picker", "forecast-table": "forecast-table", "bid-chart": "bid-chart",
  "scenario-chart": "scenario-chart",
  "bid-suggestions": "bid-suggestions", "policy-chart": "policy-chart", "policy-events": "policy-events",
  "model-summary": "model-summary", leaderboard: "leaderboard", "error-by-horizon": "error-by-horizon",
  "watchlist-form": "watchlist-form",
};

// these are starter questions per page so that users know what to ask
const SUGGESTIONS = {
  overview: ["Explain this page like I'm buying my first car", "Why do all categories show the same outlook?", "What's the difference between Cat A and Cat B?"],
  forecast: ["Why is this showing {label}?", "Explain this chart simply", "How certain is this forecast?", "What if supply rises 10%?"],
  scenario: ["Why did the forecast change?", "What if supply rises 15%?", "Does an increase in quota usually reduce premiums?"],
  bid: ["How much should I bid for a 90% chance?", "Why does a higher bid not cost more?", "What does chance of winning mean?"],
  plan: ["Explain my plan simply", "What does PQP mean?", "Alert me when Cat {cat} falls below $120k"],
  policy: ["What changed Cat {cat} prices the most?", "What does unclear mean?", "Does an increase in quota usually reduce premiums?"],
  model: ["Why should I trust this model?", "Why is the model less certain further ahead?", "What is sMAPE?"],
  alerts: ["Alert me when Cat A falls below $120k", "How does the watchlist tell me about changes?"],
  learn: ["Explain COE like I'm buying my first car", "What does the 80% range mean?", "Compare Cat A and Cat B"],
};

// these are the panel's state so that all the functions below can share it
let panel = null;
let fab = null;
let thread = [];              // [{ role, content, actions?, provenance?, notice?, mode?, error?, question? }]
let busy = false;
let status = null;
let lastFocus = null;

// this restores the chat from this tab so that a reload does not lose it
function load() {
  try { thread = (JSON.parse(sessionStorage.getItem(THREAD_KEY)) || []).filter((m) => !m.pending); } catch { thread = []; }
}
// this saves finished messages so that half-written replies are not restored
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

// this describes the view in a line so that the user sees what the analyst is looking at
function describeView(v) {
  const bits = [PAGE_NAMES[v.page] || "COE Compass"];
  if (v.category) bits.unshift(`Cat ${v.category}`);
  if (v.page === "scenario" && v.quota_pct != null) bits.push(scenarioLabel(v.quota_pct));
  return bits.join(" · ");
}

// this redraws the panel header so that it follows the page
function paintContext() {
  if (!panel) return;
  const v = getView();
  panel.querySelector("#analyst-where").textContent = describeView(v);
  const facts = (v.facts || []).slice(0, 6);
  panel.querySelector("#analyst-facts").innerHTML = facts.map((f) =>
    `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join("");
  const label = ((v.facts || []).find((f) => f.label === "Outlook")?.value || "this outlook").toLowerCase();
  const signals = new Set((v.facts || []).filter((f) => /^Cat [A-E]$/.test(f.label)).map((f) => f.value.split(" · ")[1]));
  const list = (SUGGESTIONS[v.page] || SUGGESTIONS.overview)
    .map((s) => s.replace("{label}", label).replace("{cat}", v.category || "B")
      .replace("Why do all categories show the same outlook?",
        signals.size === 1 ? "Why do all categories show the same outlook?" : "Which category has the clearest outlook?"));
  panel.querySelector("#analyst-suggest").innerHTML = list.map((s) =>
    `<button type="button" class="chip-q" data-q="${esc(s)}">${esc(s)}</button>`).join("");
}

// this draws a confirm card for a saved action so that nothing happens without a click
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

// this puts the caret inside the last paragraph so that it sits right after the text
function withCaret(markup) {
  const i = Math.max(markup.lastIndexOf("</p>"), markup.lastIndexOf("</li>"));
  return i < 0 ? `${markup}<span class="caret"></span>` : `${markup.slice(0, i)}<span class="caret"></span>${markup.slice(i)}`;
}

// this draws one assistant message so that streaming, errors and actions all show the same way
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

// this checks if the user is near the bottom so that streaming does not pull them away
function nearBottom(list) { return list.scrollHeight - list.scrollTop - list.clientHeight < 60; }

// this redraws the whole chat so that it always matches the thread
function paintThread() {
  if (!panel) return;
  const list = panel.querySelector("#analyst-log");
  if (!thread.length) {
    list.innerHTML = `<div class="analyst-empty"><p><strong>Ask about what you're looking at.</strong></p>
      <p class="small muted">Compass answers from this app's own forecasts and data, says when something is a forecast rather than a fact, and can open pages or set up the planner for you. It won't tell you to buy or to wait.</p></div>`;
  } else {
    list.innerHTML = thread.map((m, i) => (m.role === "user"
      ? `<div class="msg msg-user"><div class="bubble">${esc(m.content)}</div></div>` : botBubble(m, i))).join("");
  }
  list.scrollTop = list.scrollHeight;
  const sendBtn = panel.querySelector(".analyst-send");
  sendBtn.disabled = busy;
  sendBtn.setAttribute("aria-label", busy ? "Compass is answering" : "Send");
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

// this shows the current mode so that the user knows if a model or basic mode is answering
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
// this opens a page from an action so that the analyst can move the user around
function go(params) {
  const hash = buildHash(params);
  if (location.hash !== hash) location.hash = hash;
}

// this flashes a page element so that the analyst can point at what it is explaining
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
      if (p.page === "scenario" || (p.page === "forecast" && scenarioPct(p.scenario))) {
        const quota = clampQuota(p.quota_pct ?? scenarioPct(p.scenario) ?? 0);
        location.hash = `#/scenario/${p.category || v.category || "A"}${quota ? `?quota=${quota}` : ""}`;
        return;
      }
      if (p.page === "policy" && here.page === "policy" && pageAction("setCategory")) {
        if (p.category) pageAction("setCategory")(p.category);
        if (p.event) pageAction("highlightEvent")(p.event);
        return;
      }
      go(p);
      return;
    }
    case "set_supply_scenario": {
      // the Scenario Lab's slider takes a whole percent or one of the modelled scenarios so that
      // both forms work
      const cat = p.category || v.category || "A";
      const quota = clampQuota(p.quota_pct ?? scenarioPct(p.scenario) ?? 0);
      if (v.page === "scenario" && v.category === cat && pageAction("setQuota")) pageAction("setQuota")(quota);
      else location.hash = `#/scenario/${cat}${quota ? `?quota=${quota}` : ""}`;
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
      // persistent actions (prepare_watch, prepare_remove_watch) never run here so that only a
      // Confirm click can change the watchlist
  }
}

// this runs a confirmed watchlist change so that it only happens after the click
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
// the thinking dots stay up for at least MIN_THINKING_MS so that a fast answer does not just
// flicker. after that streamed text is shown exactly as it arrives, and an answer in one piece
// fades in once. repaints are batched per frame
const MIN_THINKING_MS = 450;
let revealFrame = 0;

// this asks for one repaint so that many text chunks in a frame draw once
function schedule() { if (!revealFrame) revealFrame = requestAnimationFrame(tick); }

// this shows whatever has arrived so that the reply appears as it is written
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

// this finishes a message and runs its actions so that they only happen once the reply is done
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

// this turns a message into an error with retry so that a failure is easy to recover from
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

// this parses one Server-Sent Event so that onEvent gets clean data
function parseEvent(raw) {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  try { return { event, data: data ? JSON.parse(data) : {} }; } catch { return { event, data: {} }; }
}

// this handles each event type so that status, text and actions update the right thing
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
    fail(i, `Compass isn't available right now (${data.text || "error"}). The rest of the app still works.`);
  }
}

// this sends a question and streams the reply so that the panel updates as it comes
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
  if (v.page === "scenario" && v.quota_pct != null) view.quota_pct = v.quota_pct;
  if (v.page === "bid" && v.bid) view.bid = v.bid;
  if (v.page === "policy" && v.event) view.event = v.event;
  thread.push({ role: "user", content: question });
  // this sends only recent finished messages so that the request stays small
  const messages = thread.filter((m) => !m.error && !m.pending)
    .map((m) => ({ role: m.role, content: m.content })).slice(-MAX_TURNS_SENT);
  const i = thread.push({ role: "assistant", pending: true, content: "", shown: 0, status: "Thinking…", question,
                          revealAfter: performance.now() + MIN_THINKING_MS }) - 1;
  busy = true;
  save();
  paintThread();
  enter([...panel.querySelectorAll("#analyst-log .msg-user .bubble")].at(-1), { rise: 6, duration: DURATION.tab });

  // this aborts after the timeout so that a stuck request cannot hang the panel
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
      // this reads the stream chunk by chunk and splits on blank lines so that each event is
      // handled when complete
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
      // this handles a plain JSON reply so that it also works if streaming is not available
      const data = await res.json();
      onEvent(i, { event: "delta", data: { text: data.reply } });
      onEvent(i, { event: "done", data });
    }
  } catch (err) {
    fail(i, err.name === "AbortError"
      ? "Compass took too long to answer. The rest of the app still works. Try again in a moment."
      : `Compass isn't available right now (${err.message}). The rest of the app still works.`);
  } finally {
    clearTimeout(timer);
  }
}

// this resends a failed question so that the user does not have to type it again
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
// this grows the input with its text so that long questions stay readable
function resize(t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 140)}px`; }

// this builds the panel once so that its listeners are only attached one time
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
      <div class="row" style="gap:8px">${ICONS.sparkle}<h2 id="analyst-title">Ask Compass</h2>
        <span class="pill pill-neutral" id="analyst-mode" hidden></span></div>
      <div class="row" style="gap:2px">
        <button type="button" class="btn btn-ghost btn-sm" id="analyst-clear">New chat</button>
        <button type="button" class="icon-btn" id="analyst-close" aria-label="Close Ask Compass">${ICONS.close}</button>
      </div>
    </header>
    <section class="analyst-context" aria-label="What Compass can see">
      <div class="caption">You're viewing</div>
      <div class="analyst-where" id="analyst-where"></div>
      <dl class="analyst-facts" id="analyst-facts"></dl>
    </section>
    <div class="analyst-log" id="analyst-log" aria-live="polite"></div>
    <div class="analyst-suggest" id="analyst-suggest" aria-label="Suggested questions"></div>
    <form class="analyst-compose" id="analyst-form">
      <label class="visually-hidden" for="analyst-input">Ask Compass a question</label>
      <textarea id="analyst-input" rows="1" maxlength="1000" placeholder="Ask about this page…"></textarea>
      <button type="submit" class="btn analyst-send" aria-label="Send">${ICONS.send}</button>
    </form>
    <p class="analyst-foot">Forecasts are probabilistic estimates, not financial advice. COE Compass is independent of LTA.</p>`;
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
  // this handles clicks in one place so that buttons drawn later still work
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

// this tracks the closing animation so that opening again can cancel it
let closing = null;             // the drawer's exit animation, while it runs

// this opens the panel so that it also loads the chat and moves focus into it
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

// this closes the panel and gives focus back so that keyboard users do not get lost
export function close() {
  if (!panel || panel.hidden || closing) return;
  fab?.setAttribute("aria-expanded", "false");
  const done = () => {
    closing = null;
    panel.hidden = true;
    document.body.classList.remove("analyst-open");
    (lastFocus?.isConnected ? lastFocus : fab)?.focus({ preventScroll: true });
  };
  // the drawer slides back out to the edge it came from (a fade with reduced motion) so that it
  // matches how it opened
  if (!panel.animate) { done(); return; }
  closing = panel.animate(
    reducedMotion() ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: "none" }, { transform: "translateX(100%)" }],
    { duration: DURATION.drawer - 60, easing: EASING.in, fill: "forwards" });
  closing.onfinish = () => { const a = closing; done(); a?.cancel(); };
}

// this wires up the panel on start so that every page can use it
export function installAnalyst() {
  load();
  // the entry point is the "Ask Compass" button in the header so that it is present on every page
  fab = document.getElementById("ask-compass");
  fab.insertAdjacentHTML("afterbegin", ICONS.sparkle);
  fab.addEventListener("click", () => (panel && !panel.hidden ? close() : open()));
  document.addEventListener("coe:ask", (e) => send(e.detail?.question));
  document.addEventListener("coe:open-analyst", () => open());
  document.addEventListener("coe:tour-start", () => close());    // the tour needs the whole page
}
