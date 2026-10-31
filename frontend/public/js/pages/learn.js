// Learn: three layers of help, kept apart so nobody has to dig through one giant FAQ.
//   guide    how COE itself works (the domain)
//   how      how COE Compass makes and checks its forecasts (the product)
//   sources  where the data comes from, how fresh it is, and the audit trail
//   faq      how to use each tool, and what the states and messages mean
//   about    who runs this, what it is not, and what is stored
// Model performance (pages/model.js) sits in the same section of the navigation.

import { api } from "../api.js";
import { setView } from "../context.js";
import { explain } from "../glossary.js";
import { LEARN_SECTIONS } from "../route.js";
import { html, money, mount, pct, sgt } from "../util.js";

// this is the source dataset link so that it is only stored once
const DATASET_URL = "https://data.gov.sg/datasets/d_69b3380ad7e51aff3a7dcc84eba52b8a/view";

/** One question: a native disclosure, so it works with the keyboard and without JS state. */
const qa = (question, answer, open = false) => html`
  <details class="faq-item"${open ? html` open` : ""}><summary>${question}</summary><div class="faq-body">${answer}</div></details>`;

// this is the heading of each section so that the page can draw it from the route
const HEAD = {
  guide: ["COE guide", "How COE works.", "The essentials of Singapore's Certificate of Entitlement, before any forecasting comes into it."],
  how: ["How it works", "How COE Compass makes forecasts.", "What goes in, how the models are checked, and what the numbers can and cannot tell you."],
  sources: ["Data sources", "Where the data comes from.", "Every figure in COE Compass traces back to a public dataset and a model run you can look up."],
  faq: ["FAQ and help", "Using COE Compass.", "How to get an answer from each tool, and what the messages you may see mean."],
  about: ["About", "About COE Compass.", "What this is, who runs it, and what it stores about you."],
};

// this writes the COE guide so that first-time buyers can learn the basics
function guide(categories) {
  return html`
    ${qa("What is a COE?", html`
      <p>A Certificate of Entitlement (COE) is the right to own and use a vehicle in Singapore for 10 years. The number of COEs is limited,
        so they are sold by auction. The price a COE sells for is called the <strong>premium</strong> (officially, the Quota Premium)
        ${explain("premium", "premium")}.</p>
      <p>The premium is only one part of what a car costs. The price of a new car also includes the vehicle itself, the Additional
        Registration Fee, excise duty, GST and the registration fee. COE Compass forecasts the COE premium only.</p>`, true)}
    ${qa("What are Categories A to E?", html`
      <div class="table-wrap"><table class="data"><thead><tr><th>Category</th><th>For</th><th>Details</th></tr></thead><tbody>
        ${categories.map((c) => html`<tr><td><strong>${c.name}</strong></td><td>${c.title}</td><td class="wrap">${c.description}</td></tr>`)}
      </tbody></table></div>
      <p>Cat E is an open category: its COEs can register any vehicle except a motorcycle. In practice they are mostly used for
        larger cars, which is why the Cat E premium usually follows Cat B.</p>`)}
    ${qa("How does COE bidding work?", html`
      <ol>
        <li>Bidding exercises normally run twice a month, each over three working days.</li>
        <li>You (or, more often, your car dealer on your behalf) submit a bid with a <strong>reserve price</strong>: the most you are
          willing to pay ${explain("reserve-price", "reserve price")}. A bid deposit is paid when the bid goes in.</li>
        <li>While the exercise is open, the current COE price is published and rises as bids come in. You can raise your reserve price
          until it closes, but not lower or withdraw it.</li>
        <li>When it closes, the available COEs go to the highest bids. <strong>Everyone who succeeds pays the same premium</strong>, the
          cut-off price at which the quota was filled, not their own bid.</li>
      </ol>
      <p>So a higher reserve price improves your chance of getting a COE without raising what you pay, unless the premium itself ends
        up that high. The <a href="#/bid/A">Bid planner</a> shows that trade-off.</p>`)}
    ${qa("What determines the premium?", html`
      <ul>
        <li><strong>Supply</strong>: the quota of COEs released ${explain("quota", "quota")}.</li>
        <li><strong>Demand</strong>: how many people bid. Bids received divided by the quota is a simple measure of pressure
          ${explain("bids-per-coe", "bids per COE")}.</li>
        <li><strong>The economy</strong>: incomes, interest rates and car-loan rules change how much buyers can pay.</li>
        <li><strong>Policy</strong>: changes to loan limits, category definitions or the way quotas are set can shift premiums for years.
          The <a href="#/policy/B">Policy Lab</a> measures what past changes did.</li>
      </ul>`)}
    ${qa("What does quota mean, and who sets it?", html`
      <p>The quota is the number of COEs available in each bidding exercise. The Land Transport Authority announces it for three months
        at a time (February to April, May to July, August to October, November to January), based mainly on how many vehicles were
        taken off the road.</p>
      <p>More COEs for the same number of bidders generally means a lower premium. You can test how much the forecast moves in the
        <a href="#/scenario/A">Scenario Lab</a>.</p>`)}
    ${qa("What happens when my COE expires?", html`
      <p>Before the 10 years are up you can either deregister the vehicle, or renew the COE without bidding by paying the
        <strong>Prevailing Quota Premium (PQP)</strong>: the average premium in your vehicle's category over the previous three months
        ${explain("pqp", "Prevailing Quota Premium")}.</p>
      <ul><li>Renewing for <strong>10 years</strong> costs the full PQP, and the COE can be renewed again later.</li>
        <li>Renewing for <strong>5 years</strong> costs half the PQP, but that COE cannot be renewed again.</li></ul>
      <p><a href="#/plan?intent=renew">My plan</a> estimates the PQP for your category and where it may be heading.</p>`)}
    <p class="caption mt-24">General information, simplified. For the official rules, current fees and deposit amounts, see LTA's
      <a href="https://onemotoring.lta.gov.sg" target="_blank" rel="noopener">OneMotoring<span class="visually-hidden"> (opens in a new tab)</span> ↗</a>.</p>`;
}

// these are the steps of the forecast process so that the how section can list them
const PIPELINE = [
  ["Collect", "After each bidding exercise, the published results and quotas are fetched from data.gov.sg, with inflation, interest rates and GDP from the Department of Statistics."],
  ["Model", "Several forecasting methods are trained side by side. One of them, Box-Tiao intervention analysis, measures what each past policy change did to premiums."],
  ["Validate", "Every method is scored on bidding exercises it never saw, re-forecasting from each one, against the simplest benchmark: tomorrow's premium equals today's."],
  ["Quantify uncertainty", "Each forecast is a range, not a number. We check how often real results fell inside the 80% range."],
  ["Publish", "The newest forecast is stored with its model run, timestamp and the data it used, then shown here."],
];

// this explains the method with live numbers so that the page always matches the latest run
function how(live) {
  const ours = live.metrics?.leaderboard.find((r) => r.model === "hybrid");
  const naive = live.metrics?.leaderboard.find((r) => r.model === "naive");
  const tested = live.metrics?.test_period.exercises;
  const outside = ours ? Math.round(100 - ours.coverage80) : null;
  return html`
    <ol class="pipeline">
      ${PIPELINE.map(([title, body], i) => html`<li class="card step"><div class="step-num">${i + 1}</div><h3>${title}</h3><p>${body}</p></li>`)}
    </ol>
    ${live.summary?.run ? html`<p class="caption mt-16">Latest: model run #${live.summary.run.id}, published ${sgt(live.summary.run.finished_at || live.summary.run.created_at)},
      with results through ${live.summary.data_through?.label || "the latest exercise"}.</p>` : ""}

    <h2 class="title mt-40">Questions about the forecasts</h2>
    <div class="mt-16">
    ${qa("How are forecasts generated?", html`
      <p>COE Compass averages two models ${explain("hybrid", "hybrid model")}. A Temporal Fusion Transformer ${explain("tft", "Temporal Fusion Transformer")}
        reads price history, bidding pressure, the economy and things known in advance, such as announced quotas. A statistical model
        with Box-Tiao intervention terms ${explain("box-tiao", "Box-Tiao intervention analysis")} accounts for past policy shocks.
        Blending them proved more reliable than either alone.</p>`, true)}
    ${qa("Why is the forecast a range rather than one number?", html`
      <p>Because nobody knows the next premium, and a single number would hide that. COE premiums move close to a random walk
        ${explain("random-walk", "random walk")}: the best single guess for the next premium is usually today's. What a model can add is
        an honest picture of how far the premium could land from that guess. The median ${explain("median", "median forecast")} is the
        middle of the range, not a promise.</p>`)}
    ${qa("What does the 80% range mean?", html`
      <p>The model expects the premium to land inside it about 8 times out of 10 ${explain("range-80", "80% range")}. That also means
        roughly 1 time in 10 it ends up above the range, and 1 in 10 below. A wider range means more uncertainty. It is not a guarantee.</p>
      ${ours ? html`<p>We check this claim: in the test, <strong>${pct(ours.coverage80, { sign: false })}</strong> of real results fell inside the 80% range
        ${explain("coverage", "interval coverage")}.</p>` : ""}`)}
    ${qa("What does the market outlook mean, and why doesn't it say buy or wait?", html`
      <p>The outlook says which way the forecast leans by the end of the next quota quarter, and how clearly
        ${explain("outlook", "market outlook")}. It stops short of telling you to buy or to wait, because the model forecasts one cost,
        the COE premium, and knows nothing about your need for a car, your finances or the car you want. It shows the evidence and
        leaves the decision with you.</p>`)}
    ${qa("What does chance of winning mean?", html`
      <p>In the Bid planner, it is the estimated probability that your bid is at or above the next premium, so that you would get a COE
        ${explain("win-probability", "chance of winning")}. It comes straight from the forecast range for the next exercise.</p>`)}
    ${qa("How often are forecasts updated?", html`
      <p>After every bidding exercise, so normally twice a month. A scheduled job collects the new results, retrains the models and
        publishes a new forecast. The time of the last update is shown at the top of every page and under every forecast.</p>`)}
    ${qa("Can COE Compass guarantee the next premium?", html`
      <p><strong>No.</strong> ${ours ? html`In the test on ${tested || "held-out"} past exercises the median forecast was off by
        ${pct(ours.mape, { sign: false })} on average, and about ${outside} in 100 real results fell outside the 80% range.` : ""}
        Policy announcements and sudden shifts in demand can move premiums in ways no model sees coming. Use the ranges to plan for
        more than one outcome.</p>`)}
    ${qa("How do you know the model is any good?", html`
      <p>By testing it on results it never saw, and comparing it with simpler methods ${explain("backtest", "out-of-sample backtest")}.
        ${ours && naive ? html`It scores ${money(ours.pinball)} of pinball loss ${explain("pinball", "pinball loss")} against ${money(naive.pinball)}
        for the simplest benchmark.` : ""} The full comparison, including where the model struggles, is on the
        <a href="#/model">Model performance</a> page.</p>`)}
    </div>
    <p class="mt-24"><a class="link-arrow" href="#/model?section=technical">View the technical methodology and evaluation</a></p>`;
}

// this lists the data sources and freshness so that a reader can check where numbers came from
function sources(live) {
  const s = live.summary;
  return html`
    <div class="table-wrap card"><table class="data sources">
      <thead><tr><th>Data</th><th>Published by</th><th>Used for</th></tr></thead>
      <tbody>
        <tr><td class="wrap"><strong>COE bidding results</strong><br>Premium, quota, bids received and successful bids for every exercise since 2010</td>
          <td class="wrap">Land Transport Authority, via <a href="${DATASET_URL}" target="_blank" rel="noopener">data.gov.sg<span class="visually-hidden"> (opens in a new tab)</span> ↗</a></td>
          <td class="wrap">Everything: history, forecasts, bidding pressure</td></tr>
        <tr><td class="wrap"><strong>Consumer prices, interest rates and GDP</strong><br>CPI, 3-month compounded SORA, real GDP</td>
          <td class="wrap">Department of Statistics Singapore, via <a href="https://tablebuilder.singstat.gov.sg" target="_blank" rel="noopener">SingStat Table Builder<span class="visually-hidden"> (opens in a new tab)</span> ↗</a></td>
          <td class="wrap">Economic context for the forecasting model</td></tr>
        <tr><td class="wrap"><strong>Policy events</strong><br>Loan rules, category changes, quota injections</td>
          <td class="wrap">Announcements by LTA and MAS and contemporary reports; each event links to its source in the <a href="#/policy/B">Policy Lab</a></td>
          <td class="wrap">Measuring what past policies did to premiums</td></tr>
      </tbody></table></div>

    <div class="grid grid-3 mt-24">
      <div class="card"><h2 class="title-sm">How fresh is it?</h2>
        <p class="small muted mt-8">${s?.data_through ? html`Results through the <strong>${s.data_through.label}</strong> bidding exercise are included.` : "No results are loaded yet."}
          ${s?.run ? html`The forecast was last published <strong>${sgt(s.run.finished_at || s.run.created_at)}</strong> (model run #${s.run.id}).` : ""}
          New results are picked up after each exercise.</p></div>
      <div class="card"><h2 class="title-sm">Can a forecast be traced?</h2>
        <p class="small muted mt-8">Yes. Every forecast is stored with the model run that produced it and the last result it used, and carries
          an ID such as <span class="mono">A-2026-10-E1-r39</span> ${explain("provenance", "forecast details")}. Past runs are listed under
          <a href="#/model?section=technical">Model performance</a>.</p></div>
      <div class="card"><h2 class="title-sm">Licence</h2>
        <p class="small muted mt-8">Government datasets are used under the Singapore Open Data Licence. COE Compass is not affiliated with
          or endorsed by LTA, MAS or the Department of Statistics, and any errors here are ours.</p></div>
    </div>
    <p class="mt-24"><a class="link-arrow" href="/api/docs" target="_blank" rel="noopener">API documentation</a></p>`;
}

// this answers common questions so that users can help themselves
function faq() {
  return html`
    <div class="help-actions">
      <button type="button" class="btn" data-app="tour">Take the 2-minute tour</button>
      <button type="button" class="btn btn-outline" data-app="glossary">What the terms mean</button>
      <button type="button" class="btn btn-outline" data-app="analyst">Ask Compass</button>
    </div>
    <div class="mt-24">
    ${qa("How do I read the forecast chart?", html`
      <p>The solid line is the recorded premium. The dashed line is the median forecast for the next six bidding exercises. The darker
        band is the 50% range and the lighter band the 80% range: the wider they are, the less certain the forecast. Hover over or tap
        the chart to read exact values, and use <em>Table view</em> for the numbers behind it. The small <strong>i</strong> buttons
        explain any term.</p>`, true)}
    ${qa("How do I use the Bid planner?", html`
      <p>Open <a href="#/bid/A">Plan → Bid planner</a>, choose your category, then type a bid or drag the slider. The large figure is the
        estimated chance that bid wins the next exercise. Underneath, a sentence says where your bid sits in the forecast, and
        <em>Explore nearby bids</em> shows how the chance changes a little higher or lower. Remember that if you win you pay the premium,
        not your bid.</p>`)}
    ${qa("How do I compare supply scenarios?", html`
      <p>Open <a href="#/scenario/A">Explore → Scenario Lab</a> and drag the slider between −20% and +20%. The expected premium and the
        chart update as you drag, with the as-announced forecast kept as a grey dashed line. The table underneath puts the modelled
        scenarios side by side.</p>`)}
    ${qa("How do I create an alert?", html`
      <p>Open <a href="#/alerts">Plan → Watchlist</a>, pick a category, choose <em>Below</em> or <em>Above</em>, enter a premium and add it.
        You can also ask Compass, for example “watch Cat A below $120,000”, and confirm. Each target is re-scored after every bidding
        exercise.</p>`)}
    ${qa("Will COE Compass email or message me?", html`
      <p>No. There is no sign-up, so there is nowhere to send a message. Changes to your watchlist are flagged the next time you open
        COE Compass, and you can switch on browser notifications that work while a tab is open.</p>`)}
    ${qa("What does “Latest forecast temporarily unavailable” mean?", html`
      <p>The page could reach the recorded results but not a forecast, usually because the model is being retrained or its service is
        restarting. Recorded COE results stay available, and the forecast returns by itself. <em>Try again</em> reloads it.</p>`)}
    ${qa("Why do most categories show “No clear direction”?", html`
      <p>Because that is usually the truth. COE premiums are hard to predict, so the odds of a higher and a lower premium are often
        close to even. The app only calls a direction when one side reaches 55%. A flat outlook with a wide range is a finding, not a fault.</p>`)}
    ${qa("Where are my plan and my watchlist kept?", html`
      <p>Your plan stays in this browser. Watchlist targets are stored on the server against a random ID that also lives in this
        browser, with no name, email or account. Clearing your browser data, or using another device, starts afresh.</p>`)}
    </div>`;
}

// this says who runs the site and what it stores so that visitors can trust it
function about() {
  return html`
    <div class="grid grid-2">
      <div class="card"><h2 class="title-sm">What it is</h2>
        <p class="small muted mt-8">COE Compass turns Singapore's public COE data into forecasts, uncertainty ranges and planning tools, so that
          an expensive and confusing decision is easier to reason about. It was built by Group 7 for DSA2111 (Cloud-Based Data Science and
          Programming) at the National University of Singapore.</p></div>
      <div class="card"><h2 class="title-sm">What it is not</h2>
        <p class="small muted mt-8"><strong>Not a government service.</strong> COE Compass is independent and is not affiliated with or endorsed by
          the Land Transport Authority. <strong>Not financial advice.</strong> Forecasts are probabilistic estimates for education and research,
          and no forecast can guarantee a premium.</p></div>
      <div class="card"><h2 class="title-sm">Privacy</h2>
        <p class="small muted mt-8">There are no accounts and no tracking. A random ID is kept in your browser so your watchlist can be found again;
          targets you add are stored against it. Your plan and settings never leave your browser. If you use Ask Compass while its AI
          model is switched on, your question is sent to the language-model provider shown in the panel, so leave personal details out.</p></div>
      <div class="card"><h2 class="title-sm">How it runs</h2>
        <p class="small muted mt-8">Four containers on Kubernetes: a PostgreSQL database, a scheduled machine-learning job that retrains after each
          bidding exercise, an API, and this website. If one restarts, the others keep serving what they have, which is why you may briefly
          see history without a forecast.</p></div>
    </div>
    <p class="mt-24 row"><a class="link-arrow" href="#/learn/how">How the forecasts are made</a>
      <a class="link-arrow" href="#/learn/sources">Data sources</a><a class="link-arrow" href="#/model">Model performance</a></p>`;
}

// this draws the chosen section so that each one has its own route
export async function render(root, { section = "guide" } = {}) {
  const sec = LEARN_SECTIONS.includes(section) ? section : "guide";
  const [eyebrow, title, subtitle] = HEAD[sec];
  mount(root, html`
    <section class="container page-head page-enter">
      <p class="eyebrow">Learn · ${eyebrow}</p>
      <h1 class="headline">${title}</h1>
      <p class="subtitle">${subtitle}</p>
    </section>
    <section class="container learn mt-24" id="learn-body" data-anchor="learn-${sec}"><div class="skeleton" style="height:320px"></div></section>`);
  setView({ facts: [{ label: "Section", value: eyebrow }] });

  // live facts are a bonus so that each section still renders if they can't be loaded
  const need = { guide: ["categories"], how: ["summary", "metrics"], sources: ["summary"] }[sec] || [];
  const paths = { categories: "/categories", summary: "/summary", metrics: "/model/metrics" };
  const loaded = await Promise.all(need.map((k) => api.get(paths[k]).catch(() => null)));
  const live = Object.fromEntries(need.map((k, i) => [k, loaded[i]]));
  if (!root.isConnected) return undefined;
  const body = sec === "guide" ? guide(live.categories || [])
    : sec === "how" ? how(live) : sec === "sources" ? sources(live) : sec === "faq" ? faq() : about();
  // reading sections keep a comfortable line length so that long text is easy to read, tables and
  // card grids use the full width
  const narrow = sec === "guide" || sec === "how" || sec === "faq";
  mount(root.querySelector("#learn-body"), narrow ? html`<div class="measure">${body}</div>` : body);
  return undefined;
}
