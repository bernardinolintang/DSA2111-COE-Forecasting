// "Explain this": small (i) buttons beside difficult terms open a popover with a
// plain-language explanation, optional technical detail, and a shortcut to ask
// the COE Analyst. Definitions come from GET /api/glossary (one source of truth
// shared with the analyst). Works without the AI.

import { api } from "./api.js";
import { ICONS, esc, html, raw } from "./util.js";

let termsPromise = null;
export function loadGlossary() {
  termsPromise ||= api.get("/glossary")
    .then((list) => Object.fromEntries(list.map((t) => [t.id, t])))
    .catch((err) => { termsPromise = null; throw err; });
  return termsPromise;
}

/** Render an explain button for a glossary term. */
export function explain(id, label) {
  return html`<button type="button" class="explain" data-explain="${id}" aria-haspopup="dialog"
    aria-label="Explain: ${label}" title="What does this mean?">i</button>`;
}

export function ask(question) {
  document.dispatchEvent(new CustomEvent("coe:ask", { detail: { question } }));
}

// ---------------------------------------------------------------------------
// Popover (one shared instance)
// ---------------------------------------------------------------------------
let pop = null;
let trigger = null;

function close(returnFocus = false) {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  if (returnFocus) trigger?.focus();
  trigger = null;
}

function position(btn) {
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const width = Math.min(340, vw - 32);
  pop.style.width = `${width}px`;
  pop.style.left = `${Math.max(16, Math.min(r.left + window.scrollX - 24, window.scrollX + vw - width - 16))}px`;
  const below = r.bottom + 8;
  const h = pop.offsetHeight;
  const top = below + h > window.innerHeight && r.top - h - 8 > 0 ? r.top - h - 8 : below;
  pop.style.top = `${top + window.scrollY}px`;
}

async function open(btn) {
  if (!pop) {
    pop = document.createElement("div");
    pop.className = "popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-labelledby", "pop-title");
    pop.hidden = true;
    document.body.appendChild(pop);
    pop.addEventListener("click", (e) => {
      if (e.target.closest(".pop-close")) close(true);
      const askBtn = e.target.closest("[data-ask]");
      if (askBtn) { close(); ask(askBtn.dataset.ask); }
    });
  }
  trigger = btn;
  btn.setAttribute("aria-expanded", "true");
  let t;
  try {
    t = (await loadGlossary())[btn.dataset.explain];
  } catch {
    t = null;
  }
  if (trigger !== btn) return;             // another button was clicked meanwhile
  pop.innerHTML = t ? String(html`
    <div class="pop-head"><strong id="pop-title">${t.term}</strong>
      <button type="button" class="icon-btn pop-close" aria-label="Close explanation">${raw(ICONS.close)}</button></div>
    <p>${t.simple}</p>
    <details><summary>Technical detail</summary><p class="small">${t.technical}</p></details>
    <button type="button" class="btn btn-ghost btn-sm mt-8" data-ask="${`Explain "${t.term}" using what I'm looking at.`}">
      ${raw(ICONS.sparkle)}Ask the analyst about this</button>`)
    : `<div class="pop-head"><strong id="pop-title">Explanation unavailable</strong>
       <button type="button" class="icon-btn pop-close" aria-label="Close">${ICONS.close}</button></div>
       <p class="small muted">The explanation couldn't be loaded. Check your connection and try again.</p>`;
  pop.hidden = false;
  position(btn);
  pop.querySelector(".pop-close").focus();
}

export function installExplain() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-explain]");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      if (trigger === btn && pop && !pop.hidden) close(true); else open(btn);
      return;
    }
    if (pop && !pop.hidden && !pop.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(true); });
  window.addEventListener("resize", () => close());
  document.addEventListener("coe:routed", () => close());
}

// ---------------------------------------------------------------------------
// Full glossary dialog (Help menu)
// ---------------------------------------------------------------------------
export async function openGlossaryDialog() {
  let dlg = document.getElementById("glossary-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "glossary-dialog";
    dlg.className = "dialog";
    dlg.setAttribute("aria-labelledby", "glossary-title");
    document.body.appendChild(dlg);
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest(".dialog-close")) dlg.close();
    });
  }
  dlg.innerHTML = `<div class="dialog-body"><div class="row-between"><h2 class="title" id="glossary-title">What the terms mean</h2>
    <button type="button" class="icon-btn dialog-close" aria-label="Close glossary">${ICONS.close}</button></div>
    <div id="glossary-list" class="mt-16"><div class="skeleton" style="height:120px"></div></div></div>`;
  dlg.showModal();
  try {
    const terms = Object.values(await loadGlossary());
    dlg.querySelector("#glossary-list").innerHTML = terms.map((t) => `
      <details class="glossary-item"><summary>${esc(t.term)}</summary>
        <p>${esc(t.simple)}</p><p class="small muted">${esc(t.technical)}</p></details>`).join("");
  } catch {
    dlg.querySelector("#glossary-list").innerHTML = `<p class="error-box">The glossary couldn't be loaded.</p>`;
  }
}
