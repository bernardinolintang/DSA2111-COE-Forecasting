// Thin client for the FastAPI backend (served under /api by nginx).
// GET responses are cached for the session so switching tabs is instant.

const cache = new Map();

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
      const p = request("GET", path).catch((err) => { cache.delete(path); throw err; });
      cache.set(path, p);
    }
    return cache.get(path);
  },
  post: (path, body) => request("POST", path, body),
  del: (path) => request("DELETE", path),
  clear: () => cache.clear(),
};
