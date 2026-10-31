// What the viewer is looking at, published by the current page.
//
// * view: identifiers Ask Compass sends to the server (page, category,
//   quota change, bid, event) plus a few display "facts" for the analyst's header.
//   The server re-reads every number from the database; facts are display only.
// * page actions: in-place handlers the current page offers (e.g. setQuota),
//   so the analyst can change the page without re-rendering it.

// these hold the current view and page actions so that the analyst can read them from anywhere
let view = { page: "overview" };
let actions = {};
const listeners = new Set();

// this returns the current view so that the analyst can send it with a question
export function getView() { return view; }

/** Replace the view (the router does this on every navigation). */
export function resetView(next) {
  view = { ...next };
  actions = {};
  listeners.forEach((fn) => fn(view));
}

/** Merge page state into the view. */
export function setView(partial) {
  view = { ...view, ...partial };
  listeners.forEach((fn) => fn(view));
}

// this lets the analyst listen to view changes so that its header stays current
export function onView(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// these let a page offer in-place actions so that the analyst can change the page with no reload
export function setPageActions(obj) { actions = obj || {}; }
export function pageAction(name) { return actions[name]; }

/** Keep the URL in sync with in-page state without triggering a re-render. */
export function replaceHash(hash) {
  if (location.hash !== hash) history.replaceState(null, "", hash);
}
