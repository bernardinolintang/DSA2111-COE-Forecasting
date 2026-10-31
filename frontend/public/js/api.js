// Thin client for the FastAPI backend (served under /api by nginx).
// GET responses are cached for the session so switching tabs is instant.

// these keep each GET in memory so that switching tabs does not refetch the same data
const cache = new Map();
const settled = new Map();     // path -> data, once a cached GET has resolved

// this sends one request and turns any failure into a readable message so that pages can show it as
// is
async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // the request never reached the service (offline, DNS, the pod restarting), this says so in
    // plain words so that the user knows it is not their input
    throw new Error("COE Compass can't reach its data service right now. Check your connection and try again.");
  }
  // this handles empty replies like DELETE so that res.json() is not called on nothing
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // this joins FastAPI's validation errors so that the user sees all of them
    const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join(", ") : data.detail;
    const fallback = res.status >= 500
      ? `The data service is temporarily unavailable (${res.status}). It usually recovers within a minute.`
      : `Request failed (${res.status})`;
    throw new Error(detail || fallback);
  }
  return data;
}

// this is the one object pages call so that caching lives in one place
export const api = {
  get(path, { fresh = false } = {}) {
    // this stores the promise itself so that two callers at the same time share one request
    if (fresh || !cache.has(path)) {
      const p = request("GET", path).then(
        // this only keeps the answer if this is still the newest request so that an old reply
        // cannot replace a fresh one
        (data) => { if (cache.get(path) === p) settled.set(path, data); return data; },
        (err) => { if (cache.get(path) === p) cache.delete(path); throw err; },
      );
      cache.set(path, p);
    }
    return cache.get(path);
  },
  // this returns the cached response if it has already arrived (it never fetches) so that a page
  // can draw straight away
  peek: (path) => settled.get(path),
  // this warms the cache, e.g. on hover, so that the next page renders at once
  prefetch(...paths) { for (const path of paths) api.get(path).catch(() => {}); },
  post: (path, body) => request("POST", path, body),
  del: (path) => request("DELETE", path),
  // this empties the cache so that "Try again" really reloads the data
  clear: () => { cache.clear(); settled.clear(); },
};
