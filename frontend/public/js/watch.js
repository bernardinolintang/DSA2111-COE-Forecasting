// Watchlist change detection.
//
// Targets are re-scored on the server after every bidding exercise, but there is
// no email or push channel. Instead, whenever COE Compass is open we compare each
// target's status with what the viewer last saw on the Watchlist page and:
//   * show a badge on the Plan link (and its Watchlist tab) and a short notice,
//   * optionally show a browser notification (only while a tab is open).
// Per-viewer state lives in localStorage; nothing here is required for the app
// to work, and every storage access is guarded by util.store.

import { api } from "./api.js";
import { clientId, money, store, toast } from "./util.js";

const SEEN = "coe-watch-seen";          // { id: status } as last seen on the Watchlist page
const NOTIFIED = "coe-watch-notified";  // { id: status } already announced, so polls don't repeat
const NOTIFY = "coe-watch-notify";      // viewer opted in to browser notifications
const RANK = { unlikely: 0, possible: 1, likely: 2, triggered: 3 };
const LABEL = { unlikely: "unlikely", possible: "possible", likely: "likely", triggered: "reached" };
const POLL_MS = 15 * 60 * 1000;

export function notificationsEnabled() {
  return Boolean(store.get(NOTIFY, false)) && "Notification" in window && Notification.permission === "granted";
}

export async function setNotifications(on) {
  if (!on || !("Notification" in window)) { store.set(NOTIFY, false); return; }
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  store.set(NOTIFY, permission === "granted");
}

let badgeCount = 0;

function badgeOn(link, name, n) {
  if (!link) return;
  let badge = link.querySelector(".nav-badge");
  if (!n) { badge?.remove(); link.removeAttribute("aria-label"); return; }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "nav-badge";
    badge.setAttribute("aria-hidden", "true");
    link.appendChild(badge);
  }
  badge.textContent = String(n);
  link.setAttribute("aria-label", `${name}, ${n} watchlist update${n > 1 ? "s" : ""}`);
}

/** The count sits on Plan in the main navigation and on its Watchlist tab when that is showing. */
function setBadge(n) {
  badgeCount = n;
  badgeOn(document.querySelector('.nav-links a[data-nav="plan"]'), "Plan", n);
  badgeOn(document.querySelector('.subnav a[data-sub="alerts"]'), "Watchlist", n);
}

/** Called by the Watchlist page: everything on screen now counts as seen. */
export function markSeen(alerts) {
  const statuses = Object.fromEntries(alerts.map((a) => [a.id, a.status]));
  store.set(SEEN, statuses);
  store.set(NOTIFIED, statuses);
  setBadge(0);
}

const describe = (a) => `Cat ${a.category} ${a.direction} ${money(a.target)}`;

export async function checkWatchlist() {
  if (/^#\/(alerts|watchlist)/.test(location.hash)) return;     // the page itself marks things seen
  let alerts;
  try {
    alerts = await api.get(`/alerts?client_id=${clientId()}`, { fresh: true });
  } catch {
    return;                                                        // quietly retry on the next poll
  }
  const seen = store.get(SEEN, null);
  if (seen === null) { markSeen(alerts); return; }                 // first visit: set a baseline
  for (const a of alerts) if (!(a.id in seen)) seen[a.id] = a.status;   // new targets are not "changes"
  store.set(SEEN, seen);

  const changed = alerts.filter((a) => seen[a.id] !== a.status);
  setBadge(changed.length);
  const notified = store.get(NOTIFIED, {});
  const fresh = changed.filter((a) => notified[a.id] !== a.status);
  if (!fresh.length) return;
  store.set(NOTIFIED, { ...notified, ...Object.fromEntries(fresh.map((a) => [a.id, a.status])) });

  toast(fresh.length === 1
    ? `Watchlist: ${describe(fresh[0])} is now ${LABEL[fresh[0].status]}.`
    : `${fresh.length} watchlist targets changed since your last visit.`);
  if (notificationsEnabled()) {
    for (const a of fresh.filter((x) => RANK[x.status] >= RANK.likely && RANK[x.status] > RANK[seen[x.id]])) {
      try {
        new Notification("COE Compass", { body: `${describe(a)} is now ${LABEL[a.status]}.`, tag: `coe-watch-${a.id}` });
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  }
}

export function startWatch() {
  document.addEventListener("coe:subnav", () => setBadge(badgeCount));     // the tabs are redrawn on navigation
  setTimeout(checkWatchlist, 1500);
  setInterval(checkWatchlist, POLL_MS);
}
