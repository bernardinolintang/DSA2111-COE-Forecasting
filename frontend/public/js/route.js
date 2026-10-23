// Hash URLs, e.g. #/scenario/A?quota=10. Pure functions (no DOM), shared by the
// router, the tour and the analyst, and unit-tested in Node.

export const PAGES = ["overview", "forecast", "scenario", "bid", "plan", "policy", "model", "alerts", "learn"];
const WITH_CATEGORY = new Set(["forecast", "scenario", "bid", "policy"]);
const QUERY_KEYS = ["quota", "bid", "event", "section", "intent"];
export const LEARN_SECTIONS = ["guide", "how", "sources", "faq", "about"];
export const QUOTA_RANGE = [-20, 20];

/** "#/scenario/A?quota=10" -> { path: "scenario/A", page: "scenario", category: "A", query: { quota: "10" } } */
export function parseHash(hash) {
  const h = String(hash || "").replace(/^#\/?/, "");
  const [path, qs = ""] = h.split("?");
  const [first = "", second] = path.split("/");
  const page = first === "" ? "overview" : first === "watchlist" ? "alerts" : first;
  const category = second && /^[A-E]$/.test(second) ? second : null;
  return { path, page, category, query: Object.fromEntries(new URLSearchParams(qs)) };
}

/** A supply scenario id as a quota change in percent: "quota_plus_10" -> 10, "base" -> 0, else null. */
export function scenarioPct(id) {
  if (id === "base") return 0;
  const m = /^quota_(plus|minus)_(\d{1,2})$/.exec(String(id || ""));
  return m ? (m[1] === "plus" ? 1 : -1) * Number(m[2]) : null;
}

/** A quota change from a URL or the analyst, as a whole percentage inside the modelled range (else 0). */
export function clampQuota(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(QUOTA_RANGE[0], Math.min(QUOTA_RANGE[1], n));
}

/** { page: "bid", category: "A", bid: 125000 } -> "#/bid/A?bid=125000" */
export function buildHash({ page = "overview", category, scenario, ...rest } = {}) {
  if (!PAGES.includes(page)) page = "overview";
  // Supply what-ifs live in the Scenario Lab: an old forecast + scenario link goes there.
  if (page === "forecast" && scenarioPct(scenario)) page = "scenario";
  if (page === "scenario" && rest.quota == null && scenarioPct(scenario) != null) rest.quota = scenarioPct(scenario);
  let path = page === "overview" ? "" : page;
  if (WITH_CATEGORY.has(page) && category) path += `/${category}`;
  if (page === "learn" && LEARN_SECTIONS.includes(rest.section) && rest.section !== "guide") path += `/${rest.section}`;
  const query = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const v = rest[key];
    if (v == null || v === "" || (key === "quota" && !Number(v)) || (key === "section" && page === "learn")) continue;
    query.set(key, String(v));
  }
  const qs = query.toString();
  return `#/${path}${qs ? `?${qs}` : ""}`;
}
