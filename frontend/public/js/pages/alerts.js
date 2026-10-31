// Watchlist (route #/alerts): target premiums saved in Postgres against an
// anonymous browser ID, re-scored against the latest forecast on every visit.
//
// Honest by design: there is no email or push channel, so this is presented as
// a watchlist. Status changes are flagged the next time the viewer opens the app
// (see watch.js), with an optional browser notification while a tab is open.

import { api } from "../api.js";
import { setView } from "../context.js";
import { explain } from "../glossary.js";
import { DURATION, collapse, enter, flip } from "../motion.js";
import { markSeen, notificationsEnabled, setNotifications } from "../watch.js";
import {
  CATEGORY_CODES, ICONS, clientId, errorBox, html, money, mount, onSegment, parseMoney, raw, segmented, toast,
} from "../util.js";

// these are the status labels so that each one has its own wording and style
const STATUS = {
  triggered: { cls: "pill-buy", text: "Reached", help: "The latest premium has already crossed your target." },
  likely: { cls: "pill-accent", text: "Likely", help: "50% or higher chance within the next quota quarter." },
  possible: { cls: "pill-wait", text: "Possible", help: "20–50% chance within the next quota quarter." },
  unlikely: { cls: "pill-neutral", text: "Unlikely", help: "Under 20% chance within the next quota quarter." },
};

// this draws one target so that all rows look the same
function alertCard(a) {
  const s = STATUS[a.status];
  const outlook = a.status === "triggered"
    ? `The latest premium (${money(a.latest_premium)}) has already crossed your target.`
    : `${a.probability_pct.toFixed(0)}% estimated chance within the next quota quarter${a.when ? `, most likely by ${a.when}` : ""}.`;
  return html`
    <div class="card alert-item" data-alert="${a.id}">
      <div>
        <div class="row"><span class="alert-title">Cat ${a.category} ${a.direction} ${money(a.target)}</span>
          <span class="pill ${s.cls}" title="${s.help}">${s.text}</span></div>
        ${a.label ? html`<div class="small mt-8">${a.label}</div>` : ""}
        <p class="alert-meta mt-8">${outlook}</p>
        <dl class="alert-facts mt-8">
          <div><dt>Latest premium</dt><dd>${money(a.latest_premium)}</dd></div>
          ${a.next_label ? html`<div><dt>Next exercise</dt><dd>${a.next_label} · median ${money(a.next_q50)}</dd></div>` : ""}
          ${a.horizon_label ? html`<div><dt>End of quarter</dt><dd>${a.horizon_label} · median ${money(a.horizon_q50)}</dd></div>` : ""}
        </dl>
      </div>
      <div class="alert-actions">
        <button class="icon-btn" type="button" data-delete="${a.id}" aria-label="Remove Cat ${a.category} ${a.direction} ${money(a.target)}">${raw(ICONS.trash)}</button>
      </div>
    </div>`;
}

// this draws the page and returns a cleanup function so that the router can remove it later
export async function render(root) {
  const cid = clientId();
  const form = { category: "A", direction: "below" };
  let alerts = [];

  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Watchlist</p>
      <h1 class="headline">Watch a target price.</h1>
      <p class="subtitle">Save the premium you're watching for. After every bidding exercise each target is re-scored against the new forecast, and any change is flagged the next time you open COE Compass.</p>
    </section>
    <section class="container">
      <form class="card card-lg mt-24" id="alert-form" novalidate data-anchor="watchlist-form">
        <div class="form-row">
          <div class="field"><span class="field-label" id="a-cat-label">Category</span>
            ${segmented("a-cat", CATEGORY_CODES.map((c) => ({ value: c, label: `Cat ${c}` })), "A", "Category")}</div>
          <div class="field"><span class="field-label">Flag when the premium is</span>
            ${segmented("a-dir", [{ value: "below", label: "Below" }, { value: "above", label: "Above" }], "below", "Direction")}</div>
          <div class="field field-grow"><label for="a-target">Target ($)</label>
            <input id="a-target" inputmode="numeric" autocomplete="off" placeholder="e.g. 95,000" required
                   aria-describedby="a-target-error" aria-invalid="false">
            <p class="field-error" id="a-target-error" role="alert" hidden></p></div>
          <div class="field field-grow"><label for="a-label">Note (optional)</label>
            <input id="a-label" maxlength="80" placeholder="My next car"></div>
          <button class="btn" type="submit" id="a-submit" disabled>Add to watchlist</button>
        </div>
        <p class="caption mt-16">No sign-up: your watchlist is linked to a random ID stored in this browser, and no personal data is kept.
          There are no emails or push messages: you'll see updates here and a notice when you next open the app. ${explain("watchlist", "watchlist")}</p>
      </form>

      <div class="card mt-24 notify-card">
        <div class="row-between">
          <div><h2 class="title" style="font-size:19px">Browser notifications</h2>
            <p class="small muted mt-8" id="notify-text"></p></div>
          <button class="btn btn-ghost btn-sm" type="button" id="notify-toggle"></button>
        </div>
      </div>

      <div class="stack mt-24" id="alerts" aria-live="polite"></div>
    </section>`);

  const targetInput = root.querySelector("#a-target");
  const labelInput = root.querySelector("#a-label");
  const submit = root.querySelector("#a-submit");
  const errorEl = root.querySelector("#a-target-error");
  let touched = false;
  let busy = false;
  let doneTimer;
  const SUBMIT_LABEL = "Add to watchlist";
  /** Back to the normal label (after the short "Added" confirmation, or as soon as the user types). */
  function resetSubmit() {
    clearTimeout(doneTimer);
    submit.classList.remove("is-done");
    if (!busy) submit.textContent = SUBMIT_LABEL;
  }

  /** Validate the target; show the message only once the user has interacted. */
  function validate() {
    const r = parseMoney(targetInput.value);
    let message = r.ok ? null : r.error;
    if (r.ok && alerts.some((a) => a.category === form.category && a.direction === form.direction && a.target === r.value)) {
      message = `You're already watching Cat ${form.category} ${form.direction} ${money(r.value)}.`;
    }
    const show = message && (touched || !r.empty);
    errorEl.hidden = !show;
    errorEl.textContent = show ? message : "";
    targetInput.setAttribute("aria-invalid", show ? "true" : "false");
    submit.disabled = busy || Boolean(message);
    return message ? null : r.value;
  }

  // these connect the form so that any change is checked right away
  onSegment(root, "a-cat", (c) => { form.category = c; validate(); });
  onSegment(root, "a-dir", (d) => { form.direction = d; validate(); });
  targetInput.addEventListener("input", () => { resetSubmit(); validate(); });
  targetInput.addEventListener("blur", () => {
    touched = true;
    const value = validate();
    if (value != null) targetInput.value = new Intl.NumberFormat("en-SG").format(value);
  });

  const list = root.querySelector("#alerts");
  // this keeps the list fresh, with animate new targets fade in and the others glide to their new
  // places so that the change is easy to follow
  async function load({ animate = false } = {}) {
    try {
      alerts = await api.get(`/alerts?client_id=${cid}`, { fresh: true });
      const settle = animate ? flip(list, "data-alert") : null;
      const wasEmpty = !list.querySelector("[data-alert]");
      mount(list, alerts.length ? html`${alerts.map(alertCard)}`
        : html`<div class="card empty"><div class="empty-icon">${raw(ICONS.bell)}</div>Nothing on your watchlist yet. Add a target above,
            or let <a href="#/plan">My plan</a> suggest a level worth watching.</div>`);
      settle?.();
      if (animate && !alerts.length && !wasEmpty) enter(list.firstElementChild, { rise: 0 });
      markSeen(alerts);
      setView({ facts: [{ label: "Targets watched", value: String(alerts.length) },
        ...alerts.slice(0, 4).map((a) => ({ label: `Cat ${a.category} ${a.direction} ${money(a.target)}`, value: STATUS[a.status].text }))] });
    } catch (err) {
      mount(list, errorBox(err));
    }
    validate();
  }

  // this saves a new target so that it can be re-scored after each exercise
  root.querySelector("#alert-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    touched = true;
    const target = validate();
    if (target == null || busy) { targetInput.focus(); return; }
    resetSubmit();
    busy = true;
    submit.disabled = true;
    submit.textContent = "Adding…";
    let added = false;
    try {
      await api.post("/alerts", { client_id: cid, category: form.category, direction: form.direction,
                                  target, label: labelInput.value.trim() || null });
      targetInput.value = "";
      labelInput.value = "";
      touched = false;
      toast(`Watching Cat ${form.category} ${form.direction} ${money(target)}`);
      added = true;
      await load({ animate: true });
    } catch (err) {
      toast(err.message);
    } finally {
      busy = false;
      if (added) {
        // a short calm confirmation on the button itself, then back to normal so that the user
        // knows it worked
        submit.innerHTML = `${ICONS.check}Added`;
        submit.classList.add("is-done");
        doneTimer = setTimeout(resetSubmit, 1400);
      } else {
        submit.textContent = SUBMIT_LABEL;
      }
      validate();
    }
  });

  // removing asks for confirmation inline (no modal) so that it is hard to do by accident, and it
  // can be undone by adding the target again
  list.addEventListener("click", async (e) => {
    const card = e.target.closest("[data-alert]");
    if (!card) return;
    const actions = card.querySelector(".alert-actions");
    const id = card.dataset.alert;
    if (e.target.closest("[data-delete]")) {
      mount(actions, html`<span class="small muted">Remove?</span>
        <button class="btn btn-sm btn-danger" type="button" data-confirm-delete="${id}">Remove</button>
        <button class="btn btn-sm btn-ghost" type="button" data-cancel-delete>Cancel</button>`);
      enter(actions, { rise: 0, duration: DURATION.micro });
      actions.querySelector("[data-confirm-delete]").focus();
      return;
    }
    if (e.target.closest("[data-cancel-delete]")) {
      const a = alerts.find((x) => String(x.id) === id);
      mount(actions, html`<button class="icon-btn" type="button" data-delete="${id}" aria-label="Remove Cat ${a.category} ${a.direction} ${money(a.target)}">${raw(ICONS.trash)}</button>`);
      actions.querySelector("[data-delete]").focus();
      return;
    }
    const confirmBtn = e.target.closest("[data-confirm-delete]");
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Removing…";
      try {
        await api.del(`/alerts/${id}?client_id=${cid}`);
        toast("Removed from your watchlist");
        // only after the removal succeeded the row collapses and the rows below slide up so that a
        // failed delete does not look done
        await collapse(card, { gap: 16 });
        await load({ animate: true });
      } catch (err) {
        toast(err.message);
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Remove";
      }
    }
  });

  // browser notifications are optional and only work while COE Compass is open in a tab so that the
  // page never promises more than it can do
  const notifyText = root.querySelector("#notify-text");
  const notifyBtn = root.querySelector("#notify-toggle");
  // this shows the notification state so that the button says what a click will do
  function paintNotify() {
    if (!("Notification" in window)) {
      notifyText.textContent = "This browser doesn't support notifications. You'll still see changes here and on the next visit.";
      notifyBtn.hidden = true;
      return;
    }
    const on = notificationsEnabled();
    const blocked = Notification.permission === "denied";
    notifyText.textContent = blocked
      ? "Notifications are blocked for this site in your browser settings."
      : on ? "On: while COE Compass is open in a tab, we'll show a notification when a target becomes likely or is reached."
      : "Off. Turn on to get a browser notification when a target becomes likely or is reached, only while COE Compass is open in a tab.";
    notifyBtn.textContent = on ? "Turn off" : "Turn on";
    notifyBtn.disabled = blocked;
  }
  notifyBtn.addEventListener("click", async () => {
    await setNotifications(!notificationsEnabled());
    paintNotify();
  });
  paintNotify();

  // this reloads when the analyst changes the list so that the page stays current
  const onChanged = () => load({ animate: true });
  document.addEventListener("coe:watchlist-changed", onChanged);
  await load();
  // this cleans up when leaving so that the timer and listener stop
  return () => { clearTimeout(doneTimer); document.removeEventListener("coe:watchlist-changed", onChanged); };
}
