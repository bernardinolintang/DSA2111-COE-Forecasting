// Single-page app shell: hash router, navigation state, the market status bar,
// theme toggle, and the app-wide helpers (Help menu, guided tour, Ask Compass,
// watchlist notices).

import { installAnalyst } from "./analyst.js";
import { api } from "./api.js";
import { resetView } from "./context.js";
import { installExplain, openGlossaryDialog } from "./glossary.js";
import * as alerts from "./pages/alerts.js";
import * as bid from "./pages/bid.js";
import * as forecast from "./pages/forecast.js";
import * as learn from "./pages/learn.js";
import * as model from "./pages/model.js";
import * as overview from "./pages/overview.js";
import * as plan from "./pages/plan.js";
import * as policy from "./pages/policy.js";
import * as scenario from "./pages/scenario.js";
import { attachThumb, takeShared } from "./motion.js";
import { buildHash, parseHash, scenarioPct } from "./route.js";
import { offerTour, startTour } from "./tour.js";
import { ICONS, errorBox, html, money, mount, pct, sgt, store } from "./util.js";
import { startWatch } from "./watch.js";

// Five places in the main navigation; Plan, Explore and Learn each hold a few
// pages, listed in SECTIONS and shown as tabs under the header.
const ROUTES = [
  { pattern: /^$/, page: overview, id: "overview", nav: "overview", title: "COE Compass" },
  { pattern: /^forecast(?:\/([A-E]))?$/, page: forecast, id: "forecast", nav: "forecast", title: "Forecast", param: "category" },
  { pattern: /^plan$/, page: plan, id: "plan", nav: "plan", title: "My plan" },
  { pattern: /^bid(?:\/([A-E]))?$/, page: bid, id: "bid", nav: "plan", title: "Bid planner", param: "category" },
  { pattern: /^(?:alerts|watchlist)$/, page: alerts, id: "alerts", nav: "plan", title: "Watchlist" },
  { pattern: /^scenario(?:\/([A-E]))?$/, page: scenario, id: "scenario", nav: "explore", title: "Scenario Lab", param: "category" },
  { pattern: /^policy(?:\/([A-E]))?$/, page: policy, id: "policy", nav: "explore", title: "Policy Lab", param: "category" },
  { pattern: /^learn(?:\/(guide|how|sources|faq|about))?$/, page: learn, id: "learn", nav: "learn", title: "Learn", param: "section" },
  { pattern: /^model$/, page: model, id: "model", nav: "learn", title: "Model performance" },
];
const DEFAULTS = { forecast: "A", bid: "A", policy: "B", scenario: "A", learn: "guide" };
const SECTIONS = {
  plan: [
    { key: "plan", label: "My plan", to: () => "#/plan" },
    { key: "bid", label: "Bid planner", to: (c) => `#/bid/${c || "A"}` },
    { key: "alerts", label: "Watchlist", to: () => "#/alerts" },
  ],
  explore: [
    { key: "scenario", label: "Scenario Lab", to: (c) => `#/scenario/${c || "A"}` },
    { key: "policy", label: "Policy Lab", to: (c) => `#/policy/${c || "B"}` },
  ],
  learn: [
    { key: "learn:guide", label: "COE guide", to: () => "#/learn" },
    { key: "learn:how", label: "How it works", to: () => "#/learn/how" },
    { key: "model", label: "Model performance", to: () => "#/model" },
    { key: "learn:sources", label: "Data sources", to: () => "#/learn/sources" },
    { key: "learn:faq", label: "FAQ and help", to: () => "#/learn/faq" },
    { key: "learn:about", label: "About", to: () => "#/learn/about" },
  ],
};

const app = document.getElementById("app");
const subnav = document.getElementById("subnav");
let renderToken = 0;
// The page on screen: { route, destroy, navigate }. A page may set
// page.navigate(params) to handle a change of category or query in place
// (returning false declines), so switching Cat A -> B keeps the layout, slides
// the selection and morphs the data instead of re-rendering the whole page.
let current = null;
const SHARED_WAIT_MS = 220;      // longest the old page is held for a shared-element transition

// Scroll: new navigations start at the top; Back/Forward restores where you were.
history.scrollRestoration = "manual";
const scrollPositions = new Map();
let currentKey = null;
let freshNavigation = true;
document.addEventListener("click", (e) => {
  if (e.target.closest('a[href^="#/"]')) freshNavigation = true;
}, true);

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The tabs for the current section; category links keep the category being viewed. */
function paintSubnav(r, params) {
  const items = SECTIONS[r.nav];
  if (!items) { subnav.hidden = true; subnav.replaceChildren(); return; }
  const active = r.id === "learn" ? `learn:${params.section}` : r.id;
  mount(subnav, html`<ul class="subnav-inner">${items.map((item) => html`
    <li><a href="${item.to(params.category)}" data-sub="${item.key.replace("learn:", "learn-")}"
      ${item.key === active ? html`aria-current="page"` : ""}>${item.label}</a></li>`)}</ul>`);
  subnav.setAttribute("aria-label", `${r.nav[0].toUpperCase()}${r.nav.slice(1)} pages`);
  subnav.hidden = false;
  document.dispatchEvent(new CustomEvent("coe:subnav"));
}

async function route() {
  const { path, query } = parseHash(location.hash);
  if (path === "how") return;            // in-page anchor on the home page
  // Supply what-ifs moved to the Scenario Lab: old forecast + scenario links follow.
  const legacy = /^forecast(?:\/([A-E]))?$/.exec(path);
  if (legacy && scenarioPct(query.scenario)) {
    location.replace(buildHash({ page: "scenario", category: legacy[1] || "A", scenario: query.scenario }));
    return;
  }
  const match = ROUTES.map((r) => [r, path.match(r.pattern)]).find(([, m]) => m);
  const [r, m] = match || [ROUTES[0], []];
  const params = r.param ? { [r.param]: m[1] || DEFAULTS[r.id] } : {};
  const hash = location.hash || "#/";

  // Same page, new category/query: the page updates in place (keeps scroll too).
  if (current?.route === r && typeof current.navigate === "function"
      && current.navigate({ ...params, query }) !== false) {
    if (currentKey) scrollPositions.set(currentKey, window.scrollY);
    currentKey = hash;
    freshNavigation = false;
    takeShared(hash);
    paintSubnav(r, params);
    document.dispatchEvent(new CustomEvent("coe:routed", { detail: { page: r.id, inPlace: true } }));
    return;
  }

  if (currentKey) scrollPositions.set(currentKey, window.scrollY);
  currentKey = hash;
  const restore = freshNavigation ? 0 : scrollPositions.get(currentKey) || 0;
  freshNavigation = false;
  const token = ++renderToken;
  const shared = takeShared(hash);

  // Each navigation renders into a fresh container. A slower, older page that is
  // still awaiting data keeps writing into its own (now detached) container and
  // can never overwrite the page the viewer has moved on to.
  const view = document.createElement("div");
  view.className = "view";
  const page = { route: r, navigate: null, destroy: null };
  let rendering = null;
  function swapIn() {
    if (typeof current?.destroy === "function") current.destroy();
    current = page;
    document.title = r.id === "overview" ? "COE Compass" : `${r.title} · COE Compass`;
    document.querySelectorAll(".nav-links a").forEach((a) => {
      if (a.dataset.nav === r.nav) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    paintSubnav(r, params);
    window.scrollTo({ top: 0, behavior: "instant" });
    app.replaceChildren(view);
    resetView({ page: r.id, category: params.category || null });
    rendering = r.page.render(view, { ...params, query }, page);
  }

  if (shared) {
    // Overview card -> Forecast: the card's category, premium and outlook morph
    // into the same items on the Forecast page (View Transition API). The old
    // page is held for at most SHARED_WAIT_MS while the new one renders
    // (usually instant: the card prefetched its data on hover/focus).
    document.documentElement.classList.add(shared.className);
    const vt = document.startViewTransition(async () => {
      swapIn();
      await Promise.race([rendering.catch(() => {}), wait(SHARED_WAIT_MS)]);
      view.querySelectorAll(".page-enter").forEach((el) => el.classList.remove("page-enter"));
    });
    vt.finished.catch(() => {}).finally(() => document.documentElement.classList.remove(shared.className));
    await vt.updateCallbackDone.catch(() => {});
    if (!rendering) swapIn();
  } else {
    view.classList.add("view-enter");
    swapIn();
  }

  try {
    const result = await rendering;
    if (token === renderToken) page.destroy = result;
    else if (typeof result === "function") result();
  } catch (err) {
    if (token === renderToken) mount(view, `<section class="container section">${errorBox(err)}</section>`);
  }
  if (token !== renderToken) return;
  if (restore) window.scrollTo({ top: restore, behavior: "instant" });
  document.dispatchEvent(new CustomEvent("coe:routed", { detail: { page: r.id } }));
}

// ---- market status bar: every category's latest premium, on every page ------
const statusBar = document.getElementById("statusbar-inner");
async function paintStatus() {
  let s;
  try {
    s = await api.get("/summary");
  } catch {
    mount(statusBar, html`<span class="status-meta">Market status is temporarily unavailable. Pages show the last data they could load.</span>`);
    return;
  }
  if (!s.categories.length) {
    mount(statusBar, html`<span class="status-meta">No bidding results loaded yet.</span>`);
    return;
  }
  const item = (c) => {
    const d = c.change_pct;
    const dir = d == null || Math.abs(d) < 0.05 ? "flat" : d > 0 ? "up" : "down";
    const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "•";
    return html`<a class="status-item" href="#/forecast/${c.code}" title="${c.name}: ${c.title}, ${c.latest.label}">
      <span class="status-cat"><span class="visually-hidden">Cat </span>${c.code}</span><strong>${money(c.latest.premium)}</strong>
      <span class="status-delta ${dir}"><span aria-hidden="true">${arrow}</span><span class="visually-hidden">${dir === "up" ? "up" : dir === "down" ? "down" : "unchanged"}</span> ${pct(d, { sign: false })}</span></a>`;
  };
  mount(statusBar, html`
    <div class="status-prices"><span class="status-lead">Latest COE</span>${s.categories.map(item)}</div>
    <div class="status-info">
      ${s.next_exercise ? html`<span class="status-meta"><span class="status-k">Next exercise</span> ${s.next_exercise.label}</span>` : ""}
      ${s.run ? html`<span class="status-meta" title="Forecast last updated ${sgt(s.run.finished_at || s.run.created_at)}"><span class="status-k">Forecast updated</span> ${sgt(s.run.finished_at || s.run.created_at, { year: false })}</span>`
        : html`<span class="status-meta">No forecast yet</span>`}
      <a class="status-meta" href="#/learn/sources" title="Data sources"><span class="status-k">Data</span> LTA</a>
    </div>`);
}

// ---- theme: follows the OS unless the viewer picks one --------------------
// Charts use CSS custom properties, so switching theme needs no re-render (and
// keeps the viewer's scenario, bid and scroll position).
const themeBtn = document.getElementById("theme-toggle");
function effectiveTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function paintThemeButton() {
  const dark = effectiveTheme() === "dark";
  themeBtn.innerHTML = dark ? ICONS.sun : ICONS.moon;
  themeBtn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}
themeBtn.addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("coe-theme", next);
  paintThemeButton();
});
paintThemeButton();

// ---- Help menu: tour, analyst, glossary, FAQ --------------------------------
const helpBtn = document.getElementById("help-toggle");
const helpMenu = document.getElementById("help-menu");
helpBtn.innerHTML = ICONS.help;
function closeHelp(focus = false) {
  helpMenu.hidden = true;
  helpBtn.setAttribute("aria-expanded", "false");
  if (focus) helpBtn.focus();
}
helpBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = helpMenu.hidden;
  helpMenu.hidden = !open;
  helpBtn.setAttribute("aria-expanded", String(open));
  if (open) helpMenu.querySelector("button").focus();
});
helpMenu.addEventListener("click", (e) => {
  const action = e.target.closest("[data-help]")?.dataset.help;
  if (!action) return;
  closeHelp();
  if (action === "tour") startTour(1);
  else if (action === "analyst") document.dispatchEvent(new CustomEvent("coe:open-analyst"));
  else if (action === "glossary") openGlossaryDialog();
  else if (action === "faq") location.hash = "#/learn/faq";
});
helpMenu.addEventListener("keydown", (e) => {
  const items = [...helpMenu.querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") closeHelp(true);
  else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
document.addEventListener("click", (e) => { if (!helpMenu.hidden && !helpMenu.contains(e.target)) closeHelp(); });

window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href="#how"]');
  if (a) { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }
  // "Try again" on a notice: reload the data for the page being viewed.
  if (e.target.closest("[data-reload]")) {
    api.clear();
    if (typeof current?.destroy === "function") current.destroy();
    current = null;
    route();
    paintStatus();
  }
  // Page buttons that open the tour, the glossary or the analyst.
  const act = e.target.closest("[data-app]")?.dataset.app;
  if (act === "tour") startTour(1);
  else if (act === "glossary") openGlossaryDialog();
  else if (act === "analyst") document.dispatchEvent(new CustomEvent("coe:open-analyst"));
});

attachThumb(document.querySelector(".nav-links"), {
  items: "a", attr: "aria-current", isActive: (a) => a.getAttribute("aria-current") === "page", tag: "li",
});
installExplain();
installAnalyst();
paintStatus();
route().then(() => { offerTour(); startWatch(); });
