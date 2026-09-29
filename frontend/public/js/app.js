// Single-page app shell: hash router, navigation state and theme toggle.

import { ICONS, errorBox, mount, store } from "./util.js";
import * as alerts from "./pages/alerts.js";
import * as bid from "./pages/bid.js";
import * as forecast from "./pages/forecast.js";
import * as model from "./pages/model.js";
import * as overview from "./pages/overview.js";
import * as policy from "./pages/policy.js";

const ROUTES = [
  { pattern: /^$/, page: overview, nav: "overview", title: "COE Forecast" },
  { pattern: /^forecast(?:\/([A-E]))?$/, page: forecast, nav: "forecast", title: "Forecast", param: "category" },
  { pattern: /^bid(?:\/([A-E]))?$/, page: bid, nav: "bid", title: "Bid planner", param: "category" },
  { pattern: /^policy$/, page: policy, nav: "policy", title: "Policy Lab" },
  { pattern: /^model$/, page: model, nav: "model", title: "Model" },
  { pattern: /^alerts$/, page: alerts, nav: "alerts", title: "Alerts" },
];

const app = document.getElementById("app");
let cleanup = null;
let renderToken = 0;

async function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  if (hash === "how") return;            // in-page anchor on the home page
  const match = ROUTES.map((r) => [r, hash.match(r.pattern)]).find(([, m]) => m);
  const [r, m] = match || [ROUTES[0], []];
  const params = r.param && m[1] ? { [r.param]: m[1] } : {};

  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  const token = ++renderToken;
  document.title = r.title === "COE Forecast" ? "COE Forecast" : `${r.title} · COE Forecast`;
  document.querySelectorAll(".nav-links a").forEach((a) => {
    if (a.dataset.nav === r.nav) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0, behavior: "instant" });

  try {
    const result = await r.page.render(app, params);
    if (token === renderToken) cleanup = result;
    else if (typeof result === "function") result();
  } catch (err) {
    if (token === renderToken) mount(app, `<section class="container section">${errorBox(err)}</section>`);
  }
}

// ---- theme: follows the OS unless the viewer picks one --------------------
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
  route();                                   // charts read colours at draw time
});
paintThemeButton();

window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href="#how"]');
  if (a) { e.preventDefault(); document.getElementById("how")?.scrollIntoView({ behavior: "smooth" }); }
});
route();
