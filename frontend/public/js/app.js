// Single-page app shell: hash router, navigation state, theme toggle, and the
// app-wide helpers (Help menu, guided tour, COE Analyst, watchlist notices).

import { installAnalyst } from "./analyst.js";
import { resetView } from "./context.js";
import { installExplain, openGlossaryDialog } from "./glossary.js";
import * as alerts from "./pages/alerts.js";
import * as bid from "./pages/bid.js";
import * as forecast from "./pages/forecast.js";
import * as model from "./pages/model.js";
import * as overview from "./pages/overview.js";
import * as policy from "./pages/policy.js";
import { attachThumb, takeShared } from "./motion.js";
import { parseHash } from "./route.js";
import { offerTour, startTour } from "./tour.js";
import { ICONS, errorBox, mount, store } from "./util.js";
import { startWatch } from "./watch.js";

const ROUTES = [
  { pattern: /^$/, page: overview, nav: "overview", title: "COE Forecast" },
  { pattern: /^forecast(?:\/([A-E]))?$/, page: forecast, nav: "forecast", title: "Forecast", param: "category" },
  { pattern: /^bid(?:\/([A-E]))?$/, page: bid, nav: "bid", title: "Bid planner", param: "category" },
  { pattern: /^policy(?:\/([A-E]))?$/, page: policy, nav: "policy", title: "Policy Lab", param: "category" },
  { pattern: /^model$/, page: model, nav: "model", title: "Model" },
  { pattern: /^(?:alerts|watchlist)$/, page: alerts, nav: "alerts", title: "Watchlist" },
];
const DEFAULT_CATEGORY = { forecast: "A", bid: "A", policy: "B" };

const app = document.getElementById("app");
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

async function route() {
  const { path, query } = parseHash(location.hash);
  if (path === "how") return;            // in-page anchor on the home page
  const match = ROUTES.map((r) => [r, path.match(r.pattern)]).find(([, m]) => m);
  const [r, m] = match || [ROUTES[0], []];
  const params = r.param ? { [r.param]: m[1] || DEFAULT_CATEGORY[r.nav] } : {};
  const hash = location.hash || "#/";

  // Same page, new category/query: the page updates in place (keeps scroll too).
  if (current?.route === r && typeof current.navigate === "function"
      && current.navigate({ ...params, query }) !== false) {
    if (currentKey) scrollPositions.set(currentKey, window.scrollY);
    currentKey = hash;
    freshNavigation = false;
    takeShared(hash);
    document.dispatchEvent(new CustomEvent("coe:routed", { detail: { page: r.nav, inPlace: true } }));
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
    document.title = r.title === "COE Forecast" ? "COE Forecast" : `${r.title} · COE Forecast`;
    document.querySelectorAll(".nav-links a").forEach((a) => {
      if (a.dataset.nav === r.nav) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    window.scrollTo({ top: 0, behavior: "instant" });
    app.replaceChildren(view);
    resetView({ page: r.nav, category: params.category || null });
    rendering = r.page.render(view, { ...params, query }, page);
  }

  if (shared) {
    // Overview card -> Forecast: the card's category, premium and signal morph
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
  document.dispatchEvent(new CustomEvent("coe:routed", { detail: { page: r.nav } }));
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

// ---- Help menu: tour, analyst, glossary -------------------------------------
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
});

attachThumb(document.querySelector(".nav-links"), {
  items: "a", attr: "aria-current", isActive: (a) => a.getAttribute("aria-current") === "page", tag: "li",
});
installExplain();
installAnalyst();
route().then(() => { offerTour(); startWatch(); });
