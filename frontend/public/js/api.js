// Thin client for the FastAPI backend (served under /api by nginx).
// GET responses are cached for the session so switching tabs is instant.

const cache = new Map();
const settled = new Map();     // path -> data, once a cached GET has resolved

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join(", ") : data.detail;
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  get(path, { fresh = false } = {}) {
    if (fresh || !cache.has(path)) {
      const p = request("GET", path).then(
        (data) => { if (cache.get(path) === p) settled.set(path, data); return data; },
        (err) => { if (cache.get(path) === p) cache.delete(path); throw err; },
      );
      cache.set(path, p);
    }
    return cache.get(path);
  },
  /** The cached response for path if it has already arrived, else undefined (never fetches). */
  peek: (path) => settled.get(path),
  /** Warm the cache (e.g. on hover) so a following navigation renders at once. */
  prefetch(...paths) { for (const path of paths) api.get(path).catch(() => {}); },
  post: (path, body) => request("POST", path, body),
  del: (path) => request("DELETE", path),
  clear: () => { cache.clear(); settled.clear(); },
};
