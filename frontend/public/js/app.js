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

// five places in the main navigation, Plan, Explore and Learn each hold a few pages listed in
// SECTIONS and shown as tabs so that the header stays short
// this maps each url pattern to a page so that one list controls the whole router
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
// these are the default params so that a link without a category still opens something useful
const DEFAULTS = { forecast: "A", bid: "A", policy: "B", scenario: "A", learn: "guide" };
// these are the tabs of each section so that the sub navigation can be drawn from data
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
// this is the page on screen: { route, destroy, navigate }. a page may set page.navigate(params) to
// handle a change of category or query in place (returning false declines) so that switching Cat A
// to B keeps the layout and morphs the data
let current = null;
const SHARED_WAIT_MS = 220;      // longest the old page is held for a shared-element transition

// new navigations start at the top and Back/Forward restores where you were so that scrolling feels
// like a normal site
history.scrollRestoration = "manual";
const scrollPositions = new Map();
let currentKey = null;
let freshNavigation = true;
// this notes a link click so that the router can tell a new navigation from Back/Forward
document.addEventListener("click", (e) => {
  if (e.target.closest('a[href^="#/"]')) freshNavigation = true;
}, true);

// this waits for some ms so that it can race against a slow page
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

// this reads the url and shows the right page so that every link is just a hash change
async function route() {
  const { path, query } = parseHash(location.hash);
  // this leaves the home page's in-page anchor alone so that it does not trigger a page load
  if (path === "how") return;            // in-page anchor on the home page
  // supply what-ifs moved to the Scenario Lab, this forwards old forecast + scenario links so that
  // they still work
  const legacy = /^forecast(?:\/([A-E]))?$/.exec(path);
  if (legacy && scenarioPct(query.scenario)) {
    location.replace(buildHash({ page: "scenario", category: legacy[1] || "A", scenario: query.scenario }));
    return;
  }
  const match = ROUTES.map((r) => [r, path.match(r.pattern)]).find(([, m]) => m);
  const [r, m] = match || [ROUTES[0], []];
  const params = r.param ? { [r.param]: m[1] || DEFAULTS[r.id] } : {};
  const hash = location.hash || "#/";

  // same page, new category or query: the page updates in place so that the scroll position is kept
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

  // each navigation renders into a fresh container, a slower older page keeps writing into its own
  // detached container so that it can never overwrite the page the viewer moved on to
  const view = document.createElement("div");
  view.className = "view";
  const page = { route: r, navigate: null, destroy: null };
  let rendering = null;
  // this removes the old page and draws the new one so that both paths below can share it
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
    // Overview card to Forecast: the card's category, premium and outlook morph into the same items
    // on the Forecast page. the old page is held for at most SHARED_WAIT_MS so that a slow load
    // cannot freeze the transition
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

  // this waits for the page, stale results get cleaned up so that an old page cannot leave timers
  // running
  try {
    const result = await rendering;
    if (token === renderToken) page.destroy = result;
    else if (typeof result === "function") result();
  } catch (err) {
    if (token === renderToken) mount(view, `<section class="container section">${errorBox(err)}</section>`);
  }
  // this stops if the user has moved on so that scroll and events only apply to the current page
  if (token !== renderToken) return;
  if (restore) window.scrollTo({ top: restore, behavior: "instant" });
  document.dispatchEvent(new CustomEvent("coe:routed", { detail: { page: r.id } }));
}

// ---- market status bar: every category's latest premium, on every page ------
const statusBar = document.getElementById("statusbar-inner");
// this draws the latest premiums on every page so that the market is always in view
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
  // this builds one category item so that the bar can map over all five
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
// charts use CSS custom properties, so switching theme needs no re-render so that the viewer keeps
// their scenario, bid and scroll position
const themeBtn = document.getElementById("theme-toggle");
// this uses the viewer's choice or the OS setting so that the first visit matches their system
function effectiveTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
// this draws the matching icon and label so that the button says what a click will do
function paintThemeButton() {
  const dark = effectiveTheme() === "dark";
  themeBtn.innerHTML = dark ? ICONS.sun : ICONS.moon;
  themeBtn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}
// this flips the theme and remembers it so that the choice survives a reload
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
// this closes the menu, focus can go back to the button so that keyboard users do not get lost
function closeHelp(focus = false) {
  helpMenu.hidden = true;
  helpBtn.setAttribute("aria-expanded", "false");
  if (focus) helpBtn.focus();
}
// this toggles the menu so that the same button opens and closes it
helpBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = helpMenu.hidden;
  helpMenu.hidden = !open;
  helpBtn.setAttribute("aria-expanded", String(open));
  if (open) helpMenu.querySelector("button").focus();
});
// this runs the picked menu item so that all help actions go through one handler
helpMenu.addEventListener("click", (e) => {
  const action = e.target.closest("[data-help]")?.dataset.help;
  if (!action) return;
  closeHelp();
  if (action === "tour") startTour(1);
  else if (action === "analyst") document.dispatchEvent(new CustomEvent("coe:open-analyst"));
  else if (action === "glossary") openGlossaryDialog();
  else if (action === "faq") location.hash = "#/learn/faq";
});
// this adds Escape and arrow keys so that the menu works without a mouse
helpMenu.addEventListener("keydown", (e) => {
  const items = [...helpMenu.querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") closeHelp(true);
  else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
// this closes the menu on an outside click so that it behaves like a normal dropdown
document.addEventListener("click", (e) => { if (!helpMenu.hidden && !helpMenu.contains(e.target)) closeHelp(); });

// this reroutes on every hash change so that links and Back/Forward all work
window.addEventListener("hashchange", route);
// this catches clicks for the whole app so that buttons added later work with no extra wiring
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href="#how"]');
  if (a) { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }
  // "Try again" on a notice: this clears the cache and reloads the page being viewed so that the
  // data is fresh
  if (e.target.closest("[data-reload]")) {
    api.clear();
    if (typeof current?.destroy === "function") current.destroy();
    current = null;
    route();
    paintStatus();
  }
  // page buttons that open the tour, the glossary or the analyst go through here so that pages do
  // not need to import them
  const act = e.target.closest("[data-app]")?.dataset.app;
  if (act === "tour") startTour(1);
  else if (act === "glossary") openGlossaryDialog();
  else if (act === "analyst") document.dispatchEvent(new CustomEvent("coe:open-analyst"));
});

// this starts the shared widgets then the first page so that the tour offer only shows once the
// page exists
attachThumb(document.querySelector(".nav-links"), {
  items: "a", attr: "aria-current", isActive: (a) => a.getAttribute("aria-current") === "page", tag: "li",
});
installExplain();
installAnalyst();
paintStatus();
route().then(() => { offerTour(); startWatch(); });
