// Price alerts: saved in Postgres against an anonymous browser ID, scored
// against the latest forecast every time they are listed.

import { api } from "../api.js";
import { CATEGORY_CODES, ICONS, clientId, errorBox, html, money, mount, onSegment, raw, segmented, toast } from "../util.js";

const STATUS = {
  triggered: { cls: "pill-buy", text: "Triggered" },
  likely: { cls: "pill-accent", text: "Likely" },
  possible: { cls: "pill-wait", text: "Possible" },
  unlikely: { cls: "pill-neutral", text: "Unlikely" },
};

function alertCard(a) {
  const s = STATUS[a.status];
  const outlook = a.status === "triggered"
    ? `The latest premium (${money(a.latest_premium)}) has already crossed your target.`
    : `${a.probability_pct.toFixed(0)}% chance within the next quota quarter${a.when ? ` (most likely by ${a.when})` : ""}. Latest: ${money(a.latest_premium)}.`;
  return html`
    <div class="card alert-item">
      <div>
        <div class="row"><span class="alert-title">Cat ${a.category} ${a.direction} ${money(a.target)}</span>
          <span class="pill ${s.cls}">${s.text}</span></div>
        ${a.label ? html`<div class="small mt-8">${a.label}</div>` : ""}
        <div class="alert-meta mt-8">${outlook}</div>
      </div>
      <button class="icon-btn" data-delete="${a.id}" aria-label="Delete alert">${raw(ICONS.trash)}</button>
    </div>`;
}

export async function render(root) {
  const cid = clientId();
  const form = { category: "A", direction: "below" };

  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Alerts</p>
      <h1 class="headline">Tell me when it's time.</h1>
      <p class="subtitle">Set a target premium. After every bidding exercise we re-score it against the new forecast, so you see how likely it is to be hit next quarter.</p>
    </section>
    <section class="container">
      <form class="card card-lg mt-24" id="alert-form" novalidate>
        <div class="form-row">
          <div class="field"><label>Category</label>
            ${segmented("a-cat", CATEGORY_CODES.map((c) => ({ value: c, label: `Cat ${c}` })), "A", "Category")}</div>
          <div class="field"><label>Notify when premium is</label>
            ${segmented("a-dir", [{ value: "below", label: "Below" }, { value: "above", label: "Above" }], "below", "Direction")}</div>
          <div class="field" style="flex:1;min-width:160px"><label for="a-target">Target ($)</label>
            <input id="a-target" inputmode="numeric" placeholder="e.g. 95,000" required></div>
          <div class="field" style="flex:1;min-width:160px"><label for="a-label">Note (optional)</label>
            <input id="a-label" maxlength="80" placeholder="My next car"></div>
          <button class="btn" type="submit">Create alert</button>
        </div>
        <p class="tiny mt-16">No sign-up: alerts are linked to a random ID stored in this browser, and no personal data is kept.</p>
      </form>
      <div class="stack mt-24" id="alerts"></div>
    </section>`);

  onSegment(root, "a-cat", (c) => { form.category = c; });
  onSegment(root, "a-dir", (d) => { form.direction = d; });

  const list = root.querySelector("#alerts");
  async function load() {
    try {
      const alerts = await api.get(`/alerts?client_id=${cid}`, { fresh: true });
      mount(list, alerts.length ? html`${alerts.map(alertCard)}`
        : html`<div class="card empty">${raw(`<div style="width:36px;height:36px;margin:0 auto 12px;color:var(--ink-3)">${ICONS.bell}</div>`)}No alerts yet. Create one above.</div>`);
    } catch (err) {
      mount(list, errorBox(err));
    }
  }

  root.querySelector("#alert-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const target = Number(root.querySelector("#a-target").value.replace(/[^0-9.]/g, ""));
    if (!target || target <= 0) { toast("Enter a target premium, e.g. 95000"); return; }
    try {
      await api.post("/alerts", { client_id: cid, category: form.category, direction: form.direction,
                                  target: Math.round(target), label: root.querySelector("#a-label").value.trim() || null });
      root.querySelector("#a-target").value = "";
      root.querySelector("#a-label").value = "";
      toast("Alert created");
      await load();
    } catch (err) {
      toast(err.message);
    }
  });

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-delete]");
    if (!btn) return;
    try {
      await api.del(`/alerts/${btn.dataset.delete}?client_id=${cid}`);
      toast("Alert deleted");
      await load();
    } catch (err) {
      toast(err.message);
    }
  });

  await load();
}
