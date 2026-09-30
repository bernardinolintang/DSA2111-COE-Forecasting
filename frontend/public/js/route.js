// Hash URLs, e.g. #/forecast/A?scenario=quota_plus_10. Pure functions (no DOM),
// shared by the router, the tour and the analyst, and unit-tested in Node.

export const PAGES = ["overview", "forecast", "bid", "policy", "model", "alerts"];
const WITH_CATEGORY = new Set(["forecast", "bid", "policy"]);
const QUERY_KEYS = ["scenario", "bid", "event", "section"];

/** "#/forecast/A?scenario=x" -> { path: "forecast/A", page: "forecast", category: "A", query: { scenario: "x" } } */
export function parseHash(hash) {
  const h = String(hash || "").replace(/^#\/?/, "");
  const [path, qs = ""] = h.split("?");
  const [first = "", second] = path.split("/");
  const page = first === "" ? "overview" : first === "watchlist" ? "alerts" : first;
  const category = second && /^[A-E]$/.test(second) ? second : null;
  return { path, page, category, query: Object.fromEntries(new URLSearchParams(qs)) };
}

/** { page: "bid", category: "A", bid: 125000 } -> "#/bid/A?bid=125000" */
export function buildHash({ page = "overview", category, ...rest } = {}) {
  if (!PAGES.includes(page)) page = "overview";
  let path = page === "overview" ? "" : page;
  if (WITH_CATEGORY.has(page) && category) path += `/${category}`;
  const query = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const v = rest[key];
    if (v == null || v === "" || (key === "scenario" && v === "base")) continue;
    query.set(key, String(v));
  }
  const qs = query.toString();
  return `#/${path}${qs ? `?${qs}` : ""}`;
}
