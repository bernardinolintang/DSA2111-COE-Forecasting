// Builds the project report (IEEE conference layout, A4, two columns) as an editable Word file.
//
// NOTE: this generated the first draft (1 Oct 2026, run 39). The report has since been edited by
// hand (team sections, the market outlook instead of Buy / Wait, new tables), so re-running it
// overwrites those edits. Edit the .docx itself instead.
//
//   npm install docx            (once, anywhere on NODE_PATH)
//   node report/src/build_report.cjs [output.docx]
//
// Inputs : report/data/*.json (API snapshot of one model run) and report/figures/fig_*.png
// Output : report/Group7-report-DSA2111.docx
//
// Everything in the file is ordinary Word content: named paragraph styles, real
// tables, native equations and inline pictures, so it can be edited by hand afterwards.
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, AlignmentType, WidthType,
  BorderStyle, SectionType, TabStopType, Tab, LevelFormat, VerticalAlign, HeadingLevel, TableLayoutType,
  Math: OMath, MathRun, MathSum, MathSubScript, MathSubSuperScript, MathFraction, MathRoundBrackets,
} = require("docx");

const ROOT = path.join(__dirname, "..");
const load = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", name), "utf8"));
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "Group7-report-DSA2111.docx");

// ---------------------------------------------------------------------------
// Page geometry (IEEE conference template, A4), in twentieths of a point
// ---------------------------------------------------------------------------
const PAGE = { width: 11906, height: 16838 };
const MARGIN = { top: 1077, bottom: 2438, left: 812, right: 812 };   // 19 mm, 43 mm, 14.32 mm
const TEXT_W = PAGE.width - MARGIN.left - MARGIN.right;                // 10282
const GAP = 240;                                                       // 4.22 mm between columns
const COL_W = (TEXT_W - GAP) / 2;                                      // 5021
const FONT = "Times New Roman";
const COL_PX = 332, FULL_PX = 680;                                     // picture widths at 96 dpi

// ---------------------------------------------------------------------------
// Citations: numbered in order of first use (IEEE style)
// ---------------------------------------------------------------------------
const REFS = {
  koh1994: "W. T. H. Koh and D. K. C. Lee, “The vehicle quota system in Singapore: An assessment,” *Transp. Res. A, Policy Pract.*, vol. 28, no. 1, pp. 31–47, Jan. 1994, doi: 10.1016/0965-8564(94)90040-X.",
  phang1996: "S.-Y. Phang, W.-K. Wong, and N.-C. Chia, “Singapore’s experience with car quotas: Issues and policy processes,” *Transp. Policy*, vol. 3, no. 4, pp. 145–153, 1996.",
  koh2003: "W. T. H. Koh, “Control of vehicle ownership and market competition: Theory and Singapore’s experience with the vehicle quota system,” *Transp. Res. A, Policy Pract.*, vol. 37, no. 9, pp. 749–770, Nov. 2003, doi: 10.1016/S0965-8564(03)00046-6.",
  tan2003: "L. H. Tan, “Rationing rules and outcomes: The experience of Singapore’s vehicle quota system,” *IMF Staff Pap.*, vol. 50, no. 3, pp. 436–457, 2003.",
  hon2004: "M. T. Hon and S. K. Yong, “The price of owning a car: An analysis of auction quota premium in Singapore,” *Appl. Econ.*, vol. 36, no. 7, pp. 739–751, 2004, doi: 10.1080/0003684042000222115.",
  chu2012: "S. Chu, “Allocation flexibility and price efficiency within Singapore’s vehicle quota system,” *Transp. Res. A, Policy Pract.*, vol. 46, no. 10, pp. 1541–1550, Dec. 2012, doi: 10.1016/j.tra.2012.07.010.",
  chu2014: "S. Chu, “Mitigating supply and price volatilities in Singapore’s vehicle quota system,” *Transportation*, vol. 41, no. 5, pp. 1119–1134, 2014, doi: 10.1007/s11116-014-9542-5.",
  meng2015: "Q. Meng, Z. Lu, and M. I. B. Ohtman, “Determinants of certificate of entitlement premium for cars under vehicle quota system in Singapore,” *J. East. Asia Soc. Transp. Stud.*, vol. 11, pp. 126–140, 2015, doi: 10.11175/easts.11.126.",
  huang2018: "N. Huang, J. Li, and A. Ross, “The impact of the cost of car ownership on the house price gradient in Singapore,” *Reg. Sci. Urban Econ.*, vol. 68, pp. 160–171, Jan. 2018.",
  boxtiao1975: "G. E. P. Box and G. C. Tiao, “Intervention analysis with applications to economic and environmental problems,” *J. Amer. Statist. Assoc.*, vol. 70, no. 349, pp. 70–79, Mar. 1975.",
  boxjenkins2015: "G. E. P. Box, G. M. Jenkins, G. C. Reinsel, and G. M. Ljung, *Time Series Analysis: Forecasting and Control*, 5th ed. Hoboken, NJ, USA: Wiley, 2015.",
  boxcox1964: "G. E. P. Box and D. R. Cox, “An analysis of transformations,” *J. Roy. Statist. Soc. B, Methodol.*, vol. 26, no. 2, pp. 211–252, 1964.",
  hochreiter1997: "S. Hochreiter and J. Schmidhuber, “Long short-term memory,” *Neural Comput.*, vol. 9, no. 8, pp. 1735–1780, Nov. 1997.",
  vaswani2017: "A. Vaswani *et al.*, “Attention is all you need,” in *Adv. Neural Inf. Process. Syst.*, Long Beach, CA, USA, 2017, pp. 5998–6008.",
  salinas2020: "D. Salinas, V. Flunkert, J. Gasthaus, and T. Januschowski, “DeepAR: Probabilistic forecasting with autoregressive recurrent networks,” *Int. J. Forecasting*, vol. 36, no. 3, pp. 1181–1191, 2020.",
  lim2021: "B. Lim, S. Ö. Arık, N. Loeff, and T. Pfister, “Temporal fusion transformers for interpretable multi-horizon time series forecasting,” *Int. J. Forecasting*, vol. 37, no. 4, pp. 1748–1764, 2021, doi: 10.1016/j.ijforecast.2021.03.012.",
  zeng2023: "A. Zeng, M. Chen, L. Zhang, and Q. Xu, “Are transformers effective for time series forecasting?” in *Proc. AAAI Conf. Artif. Intell.*, Washington, DC, USA, 2023, vol. 37, no. 9, pp. 11121–11128.",
  makridakis2020: "S. Makridakis, E. Spiliotis, and V. Assimakopoulos, “The M4 competition: 100,000 time series and 61 forecasting methods,” *Int. J. Forecasting*, vol. 36, no. 1, pp. 54–74, 2020.",
  zhang2003: "G. P. Zhang, “Time series forecasting using a hybrid ARIMA and neural network model,” *Neurocomputing*, vol. 50, pp. 159–175, Jan. 2003.",
  friedman2001: "J. H. Friedman, “Greedy function approximation: A gradient boosting machine,” *Ann. Statist.*, vol. 29, no. 5, pp. 1189–1232, Oct. 2001.",
  lichtendahl2013: "K. C. Lichtendahl, Y. Grushka-Cockayne, and R. L. Winkler, “Is it better to average probabilities or quantiles?” *Manage. Sci.*, vol. 59, no. 7, pp. 1594–1611, Jul. 2013.",
  lakshmi2017: "B. Lakshminarayanan, A. Pritzel, and C. Blundell, “Simple and scalable predictive uncertainty estimation using deep ensembles,” in *Adv. Neural Inf. Process. Syst.*, Long Beach, CA, USA, 2017, pp. 6402–6413.",
  koenker1978: "R. Koenker and G. Bassett, “Regression quantiles,” *Econometrica*, vol. 46, no. 1, pp. 33–50, Jan. 1978.",
  gneiting2007: "T. Gneiting and A. E. Raftery, “Strictly proper scoring rules, prediction, and estimation,” *J. Amer. Statist. Assoc.*, vol. 102, no. 477, pp. 359–378, Mar. 2007.",
  hyndman2006: "R. J. Hyndman and A. B. Koehler, “Another look at measures of forecast accuracy,” *Int. J. Forecasting*, vol. 22, no. 4, pp. 679–688, 2006.",
  tashman2000: "L. J. Tashman, “Out-of-sample tests of forecasting accuracy: An analysis and review,” *Int. J. Forecasting*, vol. 16, no. 4, pp. 437–450, 2000.",
  diebold1995: "F. X. Diebold and R. S. Mariano, “Comparing predictive accuracy,” *J. Bus. Econ. Statist.*, vol. 13, no. 3, pp. 253–263, Jul. 1995.",
  newey1987: "W. K. Newey and K. D. West, “A simple, positive semi-definite, heteroskedasticity and autocorrelation consistent covariance matrix,” *Econometrica*, vol. 55, no. 3, pp. 703–708, May 1987.",
  merkel2014: "D. Merkel, “Docker: Lightweight Linux containers for consistent development and deployment,” *Linux J.*, vol. 2014, no. 239, Art. no. 2, Mar. 2014.",
  burns2016: "B. Burns, B. Grant, D. Oppenheimer, E. Brewer, and J. Wilkes, “Borg, Omega, and Kubernetes,” *Commun. ACM*, vol. 59, no. 5, pp. 50–57, May 2016.",
  sculley2015: "D. Sculley *et al.*, “Hidden technical debt in machine learning systems,” in *Adv. Neural Inf. Process. Syst.*, Montreal, QC, Canada, 2015, pp. 2503–2511.",
  lta: "Land Transport Authority, “COE bidding results / prices,” data.gov.sg. Accessed: Sep. 30, 2026. [Online]. Available: https://data.gov.sg/datasets/d_69b3380ad7e51aff3a7dcc84eba52b8a/view",
  singstat: "Singapore Department of Statistics, “SingStat Table Builder: Tables M213751, M700071 and M015661.” Accessed: Sep. 30, 2026. [Online]. Available: https://tablebuilder.singstat.gov.sg",
  quotasg: "Quota.sg, “Know the quota. Time your bid.” Accessed: Oct. 1, 2026. [Online]. Available: https://quota.sg",
  coesg: "COE SG, “Singapore COE prices and predictions.” Accessed: Oct. 1, 2026. [Online]. Available: https://coe.com.sg",
  sarima: "A. Lee, “coe-forecasting: SARIMA forecasts of COE prices,” GitHub repository. Accessed: Oct. 1, 2026. [Online]. Available: https://github.com/axellee1994/coe-forecasting",
};
const order = [];
/** Cite one or more references; consecutive runs of three or more collapse to a range. */
function cite(...keys) {
  const nums = keys.map((k) => {
    if (!REFS[k]) throw new Error(`unknown reference ${k}`);
    if (!order.includes(k)) order.push(k);
    return order.indexOf(k) + 1;
  }).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    if (j - i >= 2) parts.push(`[${nums[i]}]–[${nums[j]}]`);
    else for (let k = i; k <= j; k++) parts.push(`[${nums[k]}]`);
    i = j + 1;
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Inline mark-up: **bold**, *italic*, ~subscript~, ^superscript^, ==highlight==
// ---------------------------------------------------------------------------
function rich(text, base = {}) {
  const runs = [];
  for (const part of String(text).split(/(\*\*[^*]+\*\*|\*[^*]+\*|~[^~]+~|\^[^^]+\^|==[^=]+==)/)) {
    if (!part) continue;
    let opts = { ...base }, t = part;
    if (/^\*\*.+\*\*$/.test(part)) { t = part.slice(2, -2); opts.bold = true; }
    else if (/^\*.+\*$/.test(part)) { t = part.slice(1, -1); opts.italics = true; }
    else if (/^~.+~$/.test(part)) { t = part.slice(1, -1); opts.subScript = true; opts.italics = true; }
    else if (/^\^.+\^$/.test(part)) { t = part.slice(1, -1); opts.superScript = true; }
    else if (/^==.+==$/.test(part)) { t = part.slice(2, -2); opts.highlight = "yellow"; }
    runs.push(new TextRun({ text: t, font: FONT, ...opts }));
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------
const P = (text) => new Paragraph({ style: "IEEEBody", children: rich(text) });
const PN = (text) => new Paragraph({ style: "IEEEBody", indent: { firstLine: 0 }, children: rich(text) });
const H1 = (num, title) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: num ? `${num}. ${title}` : title, font: FONT })] });
const H2 = (letter, title) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: `${letter}. ${title}`, font: FONT })] });
const bullet = (text) => new Paragraph({ style: "IEEEBody", numbering: { reference: "ieee-bullets", level: 0 }, indent: { left: 432, hanging: 216, firstLine: 0 }, children: rich(text) });

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), data: b };
}
let figNo = 0;
/** A picture with its caption underneath. ``full`` centres the caption (full-width figures). */
function figure(name, widthPx, caption, alt, full = false) {
  figNo += 1;
  const { w, h, data } = pngSize(path.join(ROOT, "figures", `${name}.png`));
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 60 },
      children: [new ImageRun({ type: "png", data, transformation: { width: widthPx, height: Math.round(widthPx * h / w) },
        altText: { title: `Fig. ${figNo}`, description: alt, name: `Fig${figNo}` } })],
    }),
    new Paragraph({ style: "IEEEFigureCaption", alignment: full ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
      children: rich(`Fig. ${figNo}. ${caption}`) }),
  ];
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
let tableNo = 0;
const rule = (size) => ({ style: BorderStyle.SINGLE, size, color: "000000" });
const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
/**
 * A table in IEEE style: number and small-caps title above, 8 pt text, horizontal rules only.
 * ``aligns`` is one letter per column (l, c, r); a cell may contain "\n" for line breaks.
 */
function table(title, widths, aligns, header, rows, note, keepRows = true) {
  tableNo += 1;
  const total = widths.reduce((a, b) => a + b, 0);
  const align = { l: AlignmentType.LEFT, c: AlignmentType.CENTER, r: AlignmentType.RIGHT };
  const cell = (text, i, kind, last, keep) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    margins: { top: 28, bottom: 28, left: 50, right: 50 },
    verticalAlign: VerticalAlign.CENTER,
    borders: { top: kind === "head" ? rule(8) : NONE, bottom: kind === "head" ? rule(4) : last ? rule(8) : NONE, left: NONE, right: NONE },
    children: String(text).split("\n").map((l) => new Paragraph({
      style: "IEEETableText", alignment: kind === "head" ? AlignmentType.CENTER : align[aligns[i]], keepNext: keep,
      children: rich(l, kind === "head" ? { bold: true } : {}),
    })),
  });
  const out = [
    new Paragraph({ style: "IEEETableTitle", keepNext: true, spacing: { before: 140, after: 0 }, children: [new TextRun({ text: `TABLE ${ROMAN[tableNo - 1]}`, font: FONT })] }),
    new Paragraph({ style: "IEEETableTitle", keepNext: true, spacing: { before: 0, after: 60 }, children: [new TextRun({ text: title, font: FONT, smallCaps: true })] }),
    new Table({
      width: { size: total, type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, alignment: AlignmentType.CENTER,
      borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: header.map((h, i) => cell(h, i, "head", false, true)) }),
        ...rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, "body", ri === rows.length - 1, keepRows && ri < rows.length - 1)) })),
      ],
    }),
  ];
  out.push(new Paragraph({ style: "IEEETableNote", children: rich(note || " ") }));
  return out;
}

// Native Word equations (editable with the equation editor)
const mr = (t) => new MathRun(t);
const sub = (a, b) => new MathSubScript({ children: [mr(a)], subScript: [mr(b)] });
const subsup = (a, b, c) => new MathSubSuperScript({ children: [mr(a)], subScript: [mr(b)], superScript: [mr(c)] });
let eqNo = 0;
function equation(children) {
  eqNo += 1;
  return new Paragraph({
    style: "IEEEEquation",
    tabStops: [{ type: TabStopType.CENTER, position: Math.round(COL_W / 2) }, { type: TabStopType.RIGHT, position: COL_W }],
    children: [new TextRun({ children: [new Tab()], font: FONT }), new OMath({ children }), new TextRun({ children: [new Tab(), `(${eqNo})`], font: FONT })],
  });
}

const money = (v) => Math.round(v).toLocaleString("en-US");
const signed = (v, d = 1) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(d)}`;
const plain = (v, d = 1) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

// ---------------------------------------------------------------------------
// Data behind the tables
// ---------------------------------------------------------------------------
const metrics = load("model_metrics.json");
const events = load("policy_events.json");
const meas = load("measurements.json");
const dm = metrics.run.metrics.diebold_mariano;
const NAMES = { hybrid: "**Hybrid (ours)**", naive: "Random walk", arima: "ARIMA", lstm: "Seq2Seq LSTM", arimax_boxtiao: "ARIMAX + Box-Tiao",
  tft_no_policy: "TFT, no policy inputs", tft: "TFT, policy inputs", gbm: "Gradient boosting" };
const PLAIN_NAMES = Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, v.replace(/\*/g, "")]));

const leaderboardRows = metrics.leaderboard.map((r) => {
  const b = (s) => (r.model === "hybrid" ? `**${s}**` : s);
  return [NAMES[r.model], b(money(r.pinball)), b(money(r.mae)), b(r.mape.toFixed(2)), b(r.coverage80.toFixed(1)),
    r.direction == null ? "–" : b(r.direction.toFixed(1)), r.model === "hybrid" ? "–" : dm[r.model].p_value.toFixed(2)];
});

const categoryRows = ["A", "B", "C", "D", "E"].map((cat) => {
  const rows = metrics.by_category.filter((r) => r.category === cat);
  const get = (m) => rows.find((r) => r.model === m);
  const best = rows.reduce((a, b) => (b.pinball < a.pinball ? b : a));
  return [`Cat ${cat}`, money(get("hybrid").pinball), money(get("naive").pinball), `${PLAIN_NAMES[best.model]} (${money(best.pinball)})`, get("hybrid").coverage80.toFixed(1)];
});

const EVENT_LABEL = {
  mas_loan_curbs_2013: "MAS car-loan curbs (Mar 2013)", cat_a_power_cap_2014: "Cat A 97 kW power cap (Feb 2014)",
  mas_loan_easing_2016: "MAS eases car loans (Jun 2016)", zero_growth_2018: "Zero vehicle growth (Feb 2018)",
  covid_resumption_2020: "Post-lockdown quota release (Jul 2020 to Jun 2021)", ev_reclassification_2022: "EV reclassification to 110 kW (May 2022)",
  cut_and_fill_2023: "Quota cut-and-fill smoothing (May 2023)", quota_injection_2025: "20,000-COE injection (Feb 2025)",
};
const policyRows = events.map((e, i) => {
  const a = e.effects.find((x) => x.category === "A");
  const cats = e.categories.length === 5 ? "A–E" : e.categories.join(", ");
  return [`P${i + 1}`, EVENT_LABEL[e.code], cats, `${signed(a.pct_effect)} (${plain(a.pct_low)}, ${plain(a.pct_high)})`, a.p_value.toFixed(2)];
});
const allEffects = events.flatMap((e) => e.effects.map((x) => ({ ...x, code: e.code })));
const significant = allEffects.filter((x) => x.significant);
if (significant.length !== 2) throw new Error("text assumes exactly two significant intervention effects");

const lat = Object.values(meas.api_latency_ms);
const latRange = (k) => `${Math.min(...lat.map((x) => x[k])).toFixed(1)}–${Math.max(...lat.map((x) => x[k])).toFixed(1)} ms`;
const durations = Object.values(meas.pipeline_duration_s);

// ---------------------------------------------------------------------------
// Content. Blocks alternate between two-column text and full-width figures.
// ---------------------------------------------------------------------------
const blocks = [];
function push(cols, children) {
  const last = blocks[blocks.length - 1];
  if (last && last.cols === cols) last.children.push(...children.flat(Infinity));
  else blocks.push({ cols, children: children.flat(Infinity) });
}
const two = (...children) => push(2, children);
const one = (...children) => push(1, children);

const AUTHORS = [
  ["Andrei Loh Jun Jie", "e1526256@nus.edu.sg"], ["Bernardino Realino Aryo Lintang", "e1122404@nus.edu.sg"],
  ["Leow Yu Xuan Chloe", "e1528726@nus.edu.sg"], ["Sarah Lim Ying Tong", "e1156850@nus.edu.sg"],
  ["Tan Guan Ming Terence", "e1398756@nus.edu.sg"], ["Lionel Yee Jen Mok", "e1398354@nus.edu.sg"],
];
function authorBlock() {
  const w = [3427, 3428, 3427];
  const cellFor = ([name, email], i) => new TableCell({
    width: { size: w[i % 3], type: WidthType.DXA }, borders: { top: NONE, bottom: NONE, left: NONE, right: NONE },
    margins: { top: 40, bottom: 80, left: 60, right: 60 },
    children: [
      new Paragraph({ style: "IEEEAuthor", children: [new TextRun({ text: name, font: FONT, size: 22 })] }),
      new Paragraph({ style: "IEEEAuthor", children: [new TextRun({ text: "DSA2111 Group 7", font: FONT, italics: true })] }),
      new Paragraph({ style: "IEEEAuthor", children: [new TextRun({ text: "National University of Singapore", font: FONT, italics: true })] }),
      new Paragraph({ style: "IEEEAuthor", children: [new TextRun({ text: "Singapore", font: FONT })] }),
      new Paragraph({ style: "IEEEAuthor", children: [new TextRun({ text: email, font: FONT })] }),
    ],
  });
  return new Table({
    width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: w, layout: TableLayoutType.FIXED,
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows: [0, 3].map((s) => new TableRow({ children: AUTHORS.slice(s, s + 3).map(cellFor) })),
  });
}

// ---- Title block (single column) -------------------------------------------
one(
  new Paragraph({ style: "IEEETitle", children: [new TextRun({ text: "Policy-Aware Probabilistic Forecasting of Singapore COE Premiums Using Temporal Fusion Transformers on a Cloud-Native Platform", font: FONT })] }),
  authorBlock(),
  new Paragraph({ spacing: { before: 0, after: 60 }, children: [] }),
);

// ---- Abstract and Section I --------------------------------------------------
two(
  new Paragraph({ style: "IEEEAbstract", children: [
    new TextRun({ text: "Abstract—", font: FONT, bold: true, italics: true }),
    ...rich("In Singapore every new vehicle needs a Certificate of Entitlement (COE), bought at a twice-monthly auction whose supply is fixed by a government quota. With premiums above S$100,000, the timing of a purchase is a major financial decision, yet public tools mostly chart past prices or publish single-number predictions without stated uncertainty or tested accuracy. Policy changes, such as the 2022 electric-vehicle reclassification and the 2025 quota injection, also break the patterns that purely historical models rely on. We present COE Forecast, a cloud-native system that produces probabilistic, policy-aware forecasts for all five COE categories and turns them into decisions. Box-Tiao intervention analysis first estimates the level shift of eight policy events. The estimates and the announced quotas then enter a Temporal Fusion Transformer (TFT), written from scratch in PyTorch, as known-future inputs; its quantile head is anchored to a calibrated random walk and cannot produce crossing quantiles. The published forecast averages the quantiles of the TFT and a Box-Tiao ARIMAX model and feeds a buy-or-wait signal, a bid planner, supply what-if scenarios and a bounded AI analyst. The system runs as four Docker containers on Kubernetes with scheduled retraining. In a rolling-origin backtest over the last 72 bidding exercises (2,010 forecasts, one to six exercises ahead) the hybrid achieved the lowest pooled pinball loss of eight methods (S$1,928), the lowest mean absolute error (S$5,549; MAPE 6.81%), 59.6% directional accuracy and 87.9% coverage for its nominal 80% interval. Its margin over a random walk is 0.45% and is not statistically significant under a Diebold-Mariano test (p = 0.74): COE premiums are close to a random walk over one quota quarter. The value of the system therefore lies in calibrated ranges, a published backtest and decision support, not in point accuracy, which existing tools do not disclose.", { bold: true }),
  ] }),
  new Paragraph({ style: "IEEEAbstract", children: [
    new TextRun({ text: "Keywords—", font: FONT, bold: true, italics: true }),
    ...rich("certificate of entitlement, probabilistic forecasting, Temporal Fusion Transformer, intervention analysis, quantile regression, Docker, Kubernetes", { bold: true }),
  ] }),

  H1("I", "Introduction"),
  P(`Singapore controls its vehicle population through the Vehicle Quota System (VQS), introduced in May 1990 ${cite("koh1994", "phang1996")}. Anyone registering a new vehicle must first obtain a Certificate of Entitlement (COE), which gives the right to own and use the vehicle for ten years. COEs are sold in bidding exercises held twice a month in five categories: small cars (Cat A), large cars (Cat B), goods vehicles and buses (Cat C), motorcycles (Cat D) and an open category (Cat E). In each exercise every successful bidder pays the same clearing price, the quota premium. In the second exercise of September 2026 the premium was S$131,890 for Cat A and S$133,000 for Cat B, a six-figure commitment made before the car is registered.`),
  P(`Fig. 1 plots the premium of all five categories from January 2010 to September 2026, the 396 bidding exercises used in this study. Three features stand out. First, the series move in long swings and not around a stable mean: Cat A rose from S$18,502 in January 2010 to S$92,100 in January 2013, fell to S$23,568 in December 2018 and reached S$133,009 in September 2026. Second, large moves can be abrupt: Cat B peaked at S$150,001 in October 2023 and cleared at S$85,010 five exercises later. Third, the markers P1 to P8 are policy interventions, among them car-loan curbs, changes to category rules and a 20,000-COE injection. Supply is set by a quota that follows the deregistration of ten-year-old vehicles ${cite("chu2014")}, so it cannot respond to demand in the short term, and a change in rules or quota can move prices sharply.`),
  P(`A buyer who must decide whether to commit now or wait a few months therefore faces a forecasting problem under uncertainty, and the tools available to the public do not treat it as one. Motoring portals chart past results and publish commentary. COE SG posts a next-round point prediction that it describes as “a simple model + a bit of guessing” ${cite("coesg")}. Quota.sg forecasts the quarterly quota and issues buy, wait or caution signals with a stated accuracy of ±5–8%, but with no interval around a forecast and no published backtest ${cite("quotasg")}. The academic literature on the VQS concentrates on auction design, efficiency and equity ${cite("koh1994", "koh2003", "tan2003", "chu2012")}; the few forecasting studies fit structural or autoregressive models and judge them by in-sample fit ${cite("hon2004", "meng2015")}. None gives a multi-step probability distribution, uses what is already known about the future (announced quota, policy start dates), or shows on unseen data that it beats the simplest benchmark, “the next premium equals the last one”.`),
  P(`We formulate the task as follows. For a category and a forecast origin *t*, given the premium history, covariates observed up to *t* and covariates known for the next *H* = 6 exercises (one quota quarter), estimate the quantiles of the premium at *t* + 1, …, *t* + *H* at seven levels from 5% to 95%. The quantiles must then answer three practical questions: whether waiting is likely to save a meaningful amount, how high a reserve price must be to win with a given probability, and how the answer changes if the next quota is larger or smaller.`),
  P(`Our approach combines two traditions. Box-Tiao intervention analysis ${cite("boxtiao1975")} estimates, for each category, the level shift attributable to each policy event while an ARIMA process absorbs ordinary dynamics. A Temporal Fusion Transformer (TFT) ${cite("lim2021")} then receives those estimates, the policy indicators and the announced quota as known-future inputs, next to past premiums, bidding pressure and macroeconomic indicators. Because each category has only 396 observations, we assume from the start that a deep model may not beat simple ones ${cite("makridakis2020", "zeng2023")}: the network is built so that before training it is exactly a calibrated random walk, and its forecast is averaged with an econometric model. Every claim is then tested against seven baselines on three held-out years. The main contributions are:`),
  bullet(`**A hybrid, policy-aware probabilistic forecaster.** Box-Tiao estimates of eight policy events and announced quotas enter a from-scratch TFT whose monotone quantile head is anchored to a random walk; its quantiles are averaged with those of a Box-Tiao ARIMAX model.`),
  bullet(`**A benchmark-first evaluation without leakage.** A three-year rolling-origin backtest compares eight methods with a proper scoring rule, interval coverage and Diebold-Mariano tests, and reports openly that COE premiums are close to a random walk.`),
  bullet(`**A reproducible cloud-native decision-support platform.** Four containers run on Docker Compose or Kubernetes with self-healing, autoscaling and scheduled retraining, and turn forecasts into a buy-or-wait signal, bid probabilities, supply scenarios, policy explanations and a tool-bounded AI analyst, covered by 149 automated tests.`),
  P(`Section II reviews related work, Section III describes the system, Section IV reports the experiments and Section V concludes.`),
);

one(figure("fig_history", FULL_PX,
  "COE premiums of the five categories, January 2010 to September 2026 (396 bidding exercises). P1 to P8 mark the policy interventions of Table II; the shaded region is the held-out test period.",
  "Line chart of COE premiums for categories A to E from 2010 to 2026 with eight policy events marked and the last three years shaded as the test period.", true));

// ---- Section II ----------------------------------------------------------------
two(
  H1("II", "Related Work"),
  H2("A", "The Vehicle Quota System and COE Price Studies"),
  P(`Early work on the VQS asked whether an auctioned quota is an efficient and fair way to ration cars. Koh and Lee ${cite("koh1994")} reviewed the first years of the scheme, its bidding strategies and the case for transferable certificates; Phang *et al.* ${cite("phang1996")} documented the issues it raised and the policy process behind its revisions. Koh ${cite("koh2003")} later showed that a per-vehicle premium favours distributors of expensive cars, for whom it is a smaller share of the price, and Tan ${cite("tan2003")} assessed how the rationing rules shaped outcomes. These studies evaluate policy, not predictive accuracy.`),
  P(`A second group treats the premium as a time series. Hon and Yong ${cite("hon2004")} fitted a structural time-series model and reported a stable seasonal pattern. Meng *et al.* ${cite("meng2015")} combined a survey of bidders with an autoregressive model with exogenous variables and reported a close fit to observed premiums. Chu found that the number of categories and the change from sealed to open bidding affected price efficiency ${cite("chu2012")}, and that deregistrations fall when premiums are high, so that a quota tied to deregistrations amplifies boom-and-bust cycles ${cite("chu2014")}; his proposal to smooth supply by borrowing from future quota is close in spirit to the cut-and-fill adjustment of 2023 (P7 in Fig. 1). Huang *et al.* ${cite("huang2018")} used the quota as an instrument for the premium when measuring its effect on house prices, which supports treating quota as an exogenous, known driver. For forecasting, the common limitations are that models are judged by in-sample fit or coefficient significance, give a single expected value, and treat policy changes as outside the model.`),
  H2("B", "Forecasting Methods"),
  P(`ARIMA models ${cite("boxjenkins2015")} remain the reference for short univariate series, and intervention analysis ${cite("boxtiao1975")} extends them with step, pulse or temporary inputs for known events. Recurrent networks such as the LSTM ${cite("hochreiter1997")} and DeepAR ${cite("salinas2020")} learn non-linear dynamics from many related series, and attention ${cite("vaswani2017")} lets a model weigh distant time steps directly. The TFT ${cite("lim2021")} combines these ideas for multi-horizon forecasting: it separates static, observed and known-future inputs, selects variables with gating networks and outputs quantiles, and it reported lower quantile losses than DeepAR and other benchmarks on electricity, traffic, retail and volatility data.`),
  P(`Evidence from forecasting competitions argues for caution. In the M4 competition ${cite("makridakis2020")} pure machine-learning entries were less accurate than statistical benchmarks, while combinations and hybrids performed best. Zeng *et al.* ${cite("zeng2023")} showed that a one-layer linear model outperforms several transformer forecasters on standard long-horizon benchmarks. Hybridisation is a long-standing response: Zhang ${cite("zhang2003")} combined ARIMA with a neural network fitted to its residuals; averaging the quantiles of several forecasters gives sharper distributions than averaging their probabilities ${cite("lichtendahl2013")}; and deep ensembles of independently initialised networks give better-calibrated uncertainty ${cite("lakshmi2017")}. Gradient-boosted trees ${cite("friedman2001")} are a strong tabular baseline.`),
  H2("C", "Evaluating Probabilistic Forecasts"),
  P(`Quantile forecasts are scored with the pinball loss ${cite("koenker1978")}, a proper scoring rule ${cite("gneiting2007")} that rewards both calibration and sharpness. Point accuracy is usually reported as the mean absolute error (MAE) and as percentage errors (MAPE, sMAPE), whose weaknesses are discussed in ${cite("hyndman2006")}. Because observations are ordered in time, accuracy must be measured out of sample with rolling forecast origins ${cite("tashman2000")}, and differences between two methods should be tested, for example with the Diebold-Mariano (DM) test ${cite("diebold1995")} and a variance estimate that is robust to the autocorrelation of overlapping multi-step errors ${cite("newey1987")}. We adopt all of these in Section IV.`),
  H2("D", "Existing Tools and Deployment Practice"),
  P(`Among public tools, Quota.sg models the quarterly quota from deregistration records and issues timing signals ${cite("quotasg")}; COE SG publishes next-round point predictions ${cite("coesg")}; and an open-source project fits one SARIMA model per category for one-round-ahead forecasts, reporting a MAPE of 1.86–4.63% over 24 rounds, better than a naive forecast in three of five categories ${cite("sarima")}. None publishes prediction intervals. On the engineering side, containers ${cite("merkel2014")} and orchestration with Kubernetes ${cite("burns2016")} make a service portable and self-healing, and Sculley *et al.* ${cite("sculley2015")} warn that most of the cost of a machine-learning system lies in data dependencies, configuration and serving, not in model code. This motivates our separation of batch training from online serving.`),
  H2("E", "Gaps Addressed"),
  P(`Three gaps follow from this review: (i) there is no multi-horizon probabilistic forecast of COE premiums; (ii) policy events and announced quotas are not used as model inputs; and (iii) accuracy claims are not tested out of sample against a naive benchmark with statistical tests. Section III addresses (i) and (ii), and Section IV addresses (iii).`),

);

one(figure("fig_architecture", FULL_PX,
  "Deployment architecture. The same four containers run under Docker Compose on a laptop and as the Kubernetes objects shown in italics in a MicroK8s namespace on the Ronin cloud VM.",
  "Architecture diagram: browser to nginx web container to FastAPI container to PostgreSQL, with a batch ML job writing to the database and calling open data APIs, an optional LLM provider and operations scripts.", true));

two(
  // ---- Section III -------------------------------------------------------------
  H1("III", "Proposed System Design"),
  H2("A", "Overview and Architecture"),
  P(`COE Forecast consists of four services (Fig. 2). A batch **ml** job ingests data, evaluates and trains the models and writes forecasts to PostgreSQL. A stateless **api** service reads those pre-computed results and applies the decision rules. A **web** service serves a single-page application and proxies API calls. The **db** service stores raw data, model runs and user watchlists.`),
  P(`Reading Fig. 2 from left to right, the browser talks only to nginx, which serves static files and forwards requests under /api/ to FastAPI. FastAPI reads from the database and writes only watchlist rows. The ml job is the only writer of data and forecasts and the only component that calls the open-data APIs. A language-model provider, used by the COE Analyst, is optional. Two design choices follow from this layout. First, training is batch and serving is online, so the API image needs no PyTorch (318 MB against 1.87 GB for the ml image), answers from pre-computed tables and can be replicated freely. Second, the schema is one idempotent SQL file applied by both ml and api at start-up, so containers can start in any order.`),
  P(`The batch job follows the nine stages of Fig. 3. Stages 1 to 5 prepare the data, stage 6 is the backtest of Section IV, and stages 7 to 9 train the production models, forecast and store the run. The following subsections describe them in order.`),
  figure("fig_pipeline", COL_PX,
    "Stages of the batch pipeline. Shaded stages fit models; the last stage stores every output of the run under one run identifier.",
    "Flow diagram of nine pipeline stages from ingestion to persistence."),

  H2("B", "Data and Features"),
  P(`Bidding results come from the LTA dataset on data.gov.sg ${cite("lta")}: 1,980 rows covering 396 exercises from January 2010 to September 2026 in five categories, each with quota, bids received, successful bids and premium. The consumer price index, the 3-month compounded SORA and real GDP come from SingStat ${cite("singstat")}. Each macroeconomic series is lagged by its publication delay (one month for CPI and SORA, two months after the quarter for GDP), so that a forecast never uses a figure that was not yet public. A CSV snapshot of all raw data is stored in the image; if a download fails, the pipeline falls back to it.`),
  P(`Table I lists the 24 model inputs by TFT input type. Known-future inputs are those whose values are available over the forecast horizon: the quota for the rest of the current quota quarter is announced, the calendar is deterministic and policy start dates are public. The ten-year quota gap encodes the expiry cycle, because vehicles registered ten years earlier are the main source of current deregistrations and therefore of quota. Observed inputs include bidding pressure, measured as the log ratio of bids received to quota. The target is transformed per category with a Box-Cox transform ${cite("boxcox1964")} to stabilise its variance and is then scaled to the range 0 to 1. Transform parameters, feature scalers and intervention estimates are fitted on training rows only.`),
  table("Model Inputs by TFT Input Type", [1050, 3421, 550], "llc", ["Type", "Variables", "No."], [
    ["Static", "COE category (learned embedding)", "1"],
    ["Known future", "Log quota; quarter-on-quarter quota change; quota ten years earlier against now, with an availability flag; month of year (sine, cosine); first or second exercise of the month; position in the quota quarter; Box-Tiao policy effect; eight policy indicators", "17"],
    ["Observed past", "Scaled premium and its first difference; log bids per COE; share of quota allocated; CPI inflation; 3-month SORA; real GDP growth", "7"],
  ], "Known-future inputs feed both the encoder and the decoder; observed inputs feed the encoder only."),

  H2("C", "Box-Tiao Intervention Analysis"),
  P(`For each category we fit a regression with ARIMA errors to the Box-Cox premium *y*~t~:`),
  equation([sub("y", "t"), mr(" = "), new MathSum({ children: [sub("ω", "k"), sub("I", "k"), mr("(t)")], subScript: [mr("k")] }), mr(" + "), sub("N", "t")]),
  PN(`where *I*~k~(*t*) is the indicator of event *k* (a step from its first bidding month, or a temporary level for the release of unallocated quota in 2020 and 2021), ω~k~ is its level shift and *N*~t~ follows an ARIMA(*p*, 1, *q*) process with *p*, *q* ≤ 2 chosen by AIC. An event is included only when at least 12 exercises precede it and 6 follow it in the fitting data. The five categories are fitted in parallel worker processes. Each ω~k~ is converted into a percentage effect relative to the mean level of the 12 exercises before the event (Table II), and the sum of ω~k~*I*~k~(*t*) becomes the *policy effect* input of the TFT. Indicators of events that cannot yet be estimated are set to zero, so that the network never receives an input whose weights were not trained.`),
  P(`Table II shows that the estimates are imprecise. With a differenced error process, a permanent step is identified mainly by the change at a single exercise, so most confidence intervals include zero. Of the ${allEffects.length} event-category effects only two are significant at the 5% level: the 2013 loan curbs on Cat E (−32.3%, interval −37.9% to −26.3%) and the release of unallocated quota in 2020 and 2021 on Cat D (+32.9%, interval 26.8% to 39.2%). For Cat A the point estimates have plausible signs, for example −10.8% for the loan curbs and −7.8% for the 2025 injection, but none is significant. The application therefore presents these numbers as estimated associations with their intervals and p-values, not as proven causal effects.`),
  table("Policy Interventions and Box-Tiao Estimates for Cat A", [330, 1791, 560, 1740, 600], "llccc",
    ["ID", "Event (first bidding month)", "Cat.", "Effect on Cat A, %\n(95% interval)", "p"], policyRows,
    "Estimated on all data by the production run. Cat. lists the categories to which each indicator is applied."),

  H2("D", "Temporal Fusion Transformer"),
  P(`Fig. 4 shows the network, implemented from scratch in about 260 lines of PyTorch so that every block can be inspected and the image stays small. The category embedding passes through four gated residual networks (GRNs), which produce context vectors for variable selection (*c*~s~), for the initial LSTM state (*c*~h~, *c*~c~) and for static enrichment (*c*~e~). A variable selection network embeds each scalar input, processes it with its own GRN and combines the results with softmax weights, which also serve as a measure of variable importance. An LSTM encoder reads 24 past exercises and a decoder reads the six future steps; a gated skip connection, static enrichment and interpretable multi-head attention with a causal mask follow. The model has 88,120 parameters (hidden size 16, four attention heads, dropout 0.3).`),
  figure("fig_tft", COL_PX,
    "The Temporal Fusion Transformer as implemented. Subscripts s, e, h and c denote the static context vectors for variable selection, enrichment and the initial LSTM hidden and cell states.",
    "Block diagram of the Temporal Fusion Transformer from inputs at the bottom to the quantile head at the top."),
  P(`We depart from ${cite("lim2021")} in three ways, each motivated by the data. (i) *Anchoring*: the head predicts the change from the last observed premium, not its level. (ii) *Random-walk scaling*: the change is expressed in units of the typical *h*-step move *s*~h~, estimated from the inter-decile range of training changes, and the output bias is initialised at standard normal quantiles. The forecast quantile at level τ and step *h* is`),
  equation([sub("ŷ", "t+h"), mr("(τ) = "), sub("y", "t"), mr(" + "), sub("s", "h"), sub("z", "h"), mr("(τ)")]),
  PN(`so an untrained network is exactly a random walk with intervals of the right width, and training only has to improve on the strongest simple baseline. (iii) *Monotone head*: *z*~h~(τ) is built as a median plus or minus cumulative softplus increments, which guarantees p10 ≤ p50 ≤ p90 without post-processing. The network minimises the pinball loss`),
  equation([sub("ρ", "τ"), mr("(y, q) = max{τ(y − q), (τ − 1)(y − q)}")]),
  PN(`averaged over seven quantile levels, six steps and all windows, with AdamW (learning rate 10^−3^, weight decay 10^−4^, batch size 64, gradient clipping at 1.0). Three seeds are trained in parallel and their quantiles averaged ${cite("lakshmi2017")}.`),

  H2("E", "Hybrid Forecast and Decision Layer"),
  P(`The published forecast is the equal-weight average of the TFT quantiles and those of a Box-Tiao ARIMAX model (BT), taken in S$ after the transforms are inverted:`),
  equation([subsup("q", "h", "hyb"), mr("(τ) = "), new MathFraction({ numerator: [mr("1")], denominator: [mr("2")] }),
    new MathRoundBrackets({ children: [subsup("q", "h", "TFT"), mr("(τ) + "), subsup("q", "h", "BT"), mr("(τ)")] })]),
  PN(`The weights are fixed in advance, so nothing is tuned on the test period, and an average of monotone quantile functions is itself monotone ${cite("lichtendahl2013")}.`),
  P(`Four functions turn the quantiles into decisions. *Buy or wait*: the rule returns “wait” when the median six exercises ahead is at least 8% below the latest premium, and “buy” otherwise. The interface words the result by conviction (“Buy now” or “Lean buy”, “Wait” or “Lean wait”) and shows the probability that prices will be higher and the probability that waiting saves at least 8%, both read from the forecast distribution. *Bid planner*: all winners pay the clearing premium, so a reserve price *b* wins whenever the premium does not exceed it:`),
  equation([mr("P(win | b) = P("), sub("y", "t+1"), mr(" ≤ b) = "), sub("F", "t+1"), mr("(b)")]),
  PN(`where *F*~t+1~ is the forecast distribution, obtained by linear interpolation between the seven quantiles. *Supply scenarios*: the quota of the next, not yet announced, quota quarter is multiplied by 0.8, 0.9, 1.1 or 1.2 and the forecast is recomputed. *Watchlist*: anonymous target premiums are stored and scored again after every run.`),
  P(`The *COE Analyst* is a side panel that answers questions about the numbers on screen. It is deliberately bounded: the browser sends only identifiers (page, category, scenario); the server rebuilds every figure from the database; calculations such as bid odds are done by server-side tools and not by the language model; actions are restricted to a whitelist; and any change to the watchlist requires confirmation by the user. Without an API key, or when the provider fails, a deterministic rule-based mode answers the same core questions.`),

  H2("F", "Implementation and Deployment"),
  P(`In the pipeline of Fig. 3, independent work (one ARIMA search per category, one network per seed and fold) is distributed over worker processes started with the *spawn* method, which avoids the deadlocks that forked children can inherit from PyTorch thread pools. Table III summarises the containers. The API is written with FastAPI and exposes 19 documented routes; the front end is a dependency-free single-page application that draws its charts in SVG.`),
  table("Containers and Kubernetes Objects", [640, 2080, 2301], "lll", ["Service", "Image and stack", "Kubernetes objects"], [
    ["web", "nginx:alpine; static SPA and reverse proxy (94 MB)", "Deployment ×2; NodePort Service 30080; probes"],
    ["api", "Python 3.12, FastAPI, Uvicorn with 2 workers, SQLAlchemy (318 MB)", "Deployment ×2 with rolling updates; Service; HPA 2–5 pods at 70% CPU; probes"],
    ["db", "postgres:16-alpine; 11 tables", "Deployment ×1; 1 Gi PersistentVolumeClaim; Secret"],
    ["ml", "Python 3.12, PyTorch 2.5 (CPU), statsmodels, scikit-learn (1.87 GB)", "Job for the first full run; CronJob every Wednesday 17:30 SGT"],
  ], "HPA: HorizontalPodAutoscaler. Images are built once and pushed to the MicroK8s registry at localhost:32000."),
  P(`On Kubernetes, web and api run as two-replica Deployments behind Services with readiness and liveness probes, and the API is updated by rolling replacement with no unavailable pod. A HorizontalPodAutoscaler scales the API between two and five pods, PostgreSQL uses a persistent volume claim, a Job trains the first model, and a CronJob retrains every Wednesday evening after bidding closes. Bash scripts build the images, push them to the registry, create the database secret and apply the manifests with kustomize; others back up the database and trigger retraining.`),
);

one(figure("fig_ui", FULL_PX,
  "The working prototype. (a) Forecast page: latest premium, six-exercise fan chart with 50% and 80% ranges, and the buy-or-wait signal. (b) Bid planner: probability that a reserve price clears the next exercise.",
  "Two screenshots of the COE Forecast web application: the forecast page for Cat A and the bid planner.", true));

two(
  P(`Fig. 5(a) shows the forecast page for Cat A after the second exercise of September 2026: the latest premium of S$131,890, a median forecast of S$133,316 for the second exercise of December, shaded 50% and 80% ranges that widen with the horizon, and a “Lean buy” signal. Fig. 5(b) shows the bid planner: a reserve price of S$137,700 has a 75% chance of clearing the first exercise of October, and the reserve prices for 50%, 75%, 90% and 95% confidence are listed below it.`),
  H2("G", "Verification"),
  P(`Correctness is checked at four levels: 19 unit tests of the feature pipeline and the networks (for example, that quantiles never cross, that attention is causal and that the Box-Tiao routine recovers a known level shift), 63 API tests against a live database, 14 front-end unit tests and 53 browser end-to-end tests with Playwright. All 149 pass on the evaluated build. Leakage is prevented structurally: one function fits every data-dependent quantity on a given panel and another applies it, so the backtest cannot use test rows by accident.`),

  // ---- Section IV ---------------------------------------------------------------
  H1("IV", "Experiment Evaluations and Performance Comparisons"),
  H2("A", "Experimental Setup"),
  P(`All results come from pipeline run 39, with data up to the second exercise of September 2026. The last 72 exercises (October 2023 to September 2026) are held out; this period contains the collapse from the October 2023 peak, the 2025 quota injection and the rise of 2026 (Fig. 1). Nothing from it is used for scaling, Box-Tiao estimation, training or the choice of epochs. A forecast is issued from each of 67 origins for one to six exercises ahead in five categories, which gives 2,010 forecast-outcome pairs per model. At each origin a model sees only data up to that origin, and future quota follows the production rule: the announced quota for the rest of the quarter, then no change.`),
  P(`The hybrid is compared with seven alternatives that receive the same information: a random walk with empirical intervals; ARIMA; ARIMAX with Box-Tiao indicators, which stands for the econometric approach of ${cite("hon2004", "meng2015")}; gradient boosting with a quantile loss ${cite("friedman2001")}; a sequence-to-sequence LSTM ${cite("hochreiter1997")}; the TFT alone; and the TFT without any policy input, as an ablation. The metrics are those of Section II-C: pinball loss over p10, p50 and p90 in S$ (the primary metric), MAE and MAPE of the median, coverage of the 80% interval, directional accuracy (scored only when the median moves by more than 0.5%), and a DM test on the per-origin pinball loss expressed as a percentage of the premium, with a Newey-West variance of five lags.`),
  P(`The number of training epochs is chosen by cross-validation on three one-year folds that precede the test period (Fig. 6). The validation loss of the TFT is lowest after three epochs and rises steadily afterwards; without policy inputs the minimum is at two epochs, and for the much smaller LSTM (5,579 parameters) at seven. With 1,475 training windows the networks start to overfit almost immediately, a first sign that little structure beyond a random walk is available.`),
  figure("fig_cv", COL_PX,
    "Validation loss by training epoch, averaged over three rolling folds and three seeds. Large markers show the epoch count selected for each network.",
    "Line chart of validation pinball loss against training epochs for three neural networks."),

  H2("B", "Overall Accuracy"),
  P(`Table IV ranks the eight methods by pooled pinball loss. The hybrid is first with S$1,928, followed by the random walk (S$1,937) and ARIMA (S$1,948). It also has the lowest MAE (S$5,549 against S$5,640 for the random walk), the lowest MAPE (6.81%) and the highest directional accuracy (59.6%). Its 80% interval covers 87.9% of outcomes and is therefore somewhat wider than necessary; the ARIMA intervals are wider still (above 91%), whereas gradient boosting covers only 54.7%. The hybrid improves on both of its members, by 3.4% in pinball loss on the TFT and by 1.6% on the ARIMAX model.`),
  table("Out-of-Sample Accuracy, All Categories and Horizons (2,010 Forecasts per Model)", [1560, 620, 580, 640, 520, 520, 581], "lcccccc",
    ["Model", "Pinball\n(S$)", "MAE\n(S$)", "MAPE\n(%)", "Cov.\n(%)", "Dir.\n(%)", "DM p"], leaderboardRows,
    "Cov.: share of outcomes inside the 80% interval. Dir.: directional accuracy. DM p: two-sided Diebold-Mariano p-value against the hybrid."),
  P(`These differences are small. The pinball loss of the hybrid is 0.45% below that of the random walk, and no DM test rejects equal accuracy at the 5% level: p = 0.74 against the random walk and p = 0.07 against the TFT without policy inputs, the closest case. On the percentage loss used by the test, which weights the five categories equally, the hybrid is 0.013 percentage points worse than the random walk. The correct reading is that the hybrid is the best-ranked method on S$ loss but is statistically indistinguishable from a random walk.`),

  H2("C", "Accuracy by Horizon and Category"),
  P(`Fig. 7 shows where the hybrid gains. One and two exercises ahead it is 1.4% and 1.0% worse than the random walk, and only the LSTM is marginally better (+0.7% at one step). From four exercises ahead the hybrid is better, by 0.7% to 1.9%. The ARIMAX model is poor at short horizons (−5.4% at one step) but positive at five and six exercises, and the TFT alone is below the random walk at every horizon; averaging the two cancels part of their errors.`),
  figure("fig_skill", COL_PX,
    "Improvement in pinball loss over the random walk at each horizon (positive is better). ARIMA and gradient boosting (−22% at one step) are omitted for clarity.",
    "Line chart of percentage improvement in pinball loss over the random walk for four models at horizons one to six."),
  P(`By category (Table V), the hybrid beats the random walk for Cat B (S$2,908 against S$2,975) and Cat C (S$1,385 against S$1,440) and is slightly worse for Cat A, Cat D and Cat E. No single method wins everywhere: an ARIMA variant is best for Cat A and Cat E, the hybrid for Cat B, the LSTM for Cat C and the random walk itself for Cat D. Coverage also varies, from 76.9% for Cat A to 96.0% for Cat C, so the intervals are slightly too narrow for Cat A and too wide for Cat C.`),
  table("Pinball Loss (S$) and Hybrid Coverage by Category", [600, 720, 760, 2241, 700], "lcclc",
    ["Cat.", "Hybrid", "Random walk", "Best model (pinball)", "Hybrid\ncov. (%)"], categoryRows,
    "402 forecasts per category and model."),
);

one(figure("fig_backtest", FULL_PX,
  "Out-of-sample hybrid forecasts for Cat A against the realised premium at 67 forecast origins.",
  "Two line charts of Cat A premiums with median forecasts and 80% intervals, one exercise ahead and six exercises ahead.", true));

two(
  P(`Fig. 8 shows what these numbers mean for Cat A. One exercise ahead, the median follows the realised premium with a lag of one step and the 80% band is narrow. Six exercises ahead the band is much wider and contains most outcomes, but the median again lags: it missed the fall from S$106,000 in October 2023 to S$65,010 in January 2024, which lies below the interval, and it followed the rise of late 2025 only after it had happened. Turning points are not predicted; what the model offers is an honest range.`),

  H2("D", "Policy Inputs, Interpretability and Predictability"),
  P(`*Value of the policy inputs.* The ablation does not support the hypothesis that policy inputs improve the neural forecast in this test period: the TFT has a pinball loss of S$1,997 with policy inputs and S$1,982 without them. The same holds for the econometric model, where ARIMAX with interventions (S$1,959) is no better than plain ARIMA (S$1,948). Two facts explain this. Seven of the eight events precede the test period, so their effect is already contained in the premium history that every model observes; and the one event inside it, the 2025 injection, cannot be estimated from the fitting data and is switched off by design. In this period, policy awareness improves explanation, through the Policy Lab page, and not accuracy.`),
  P(`*Interpretability.* Fig. 9 shows the variable-selection weights of the production TFT. Among past inputs the interest rate (SORA) receives 48.1% of the weight, far more than any other variable. Among known-future inputs the month of the year (23.8%) and the indicator of the 2025 injection (10.0%) lead, followed by the ten-year data flag and the quarterly quota change. Attention over the 24 past exercises is almost flat, with 4.0% to 4.3% on each lag, so no particular lag is singled out. Selection weights describe what the network attends to and not causal influence, and for a model trained for three epochs they should be read as indicative.`),
  figure("fig_importance", COL_PX,
    "Variable-selection weights of the production TFT, averaged over recent windows of all categories: the top six of 24 encoder inputs and of 17 decoder inputs.",
    "Two horizontal bar charts of the six largest variable-selection weights for past inputs and for known-future inputs."),
  P(`*Predictability.* As a model-free check, a linear regression of the *h*-step log change on momentum, bidding pressure and quota changes, fitted before the test period, has an out-of-sample R^2^ relative to a no-change forecast of 0.020, 0.009 and 0.030 at one, three and six exercises. At most 3% of the variance of premium changes is predictable from public data of this kind, which agrees with the narrow margins of Table IV.`),

  H2("E", "Decision Layer and Scenarios"),
  P(`Across the 335 six-step forecasts of the test period the median was never more than 2.2% below the premium at the origin, so the 8% “wait” rule was never triggered, although the premium did fall by 8% or more in 54 cases (16.1%). The rule as proposed would therefore present a near coin flip as a confident “Buy now”. We kept the rule but report conviction and the two probabilities behind it. In the current forecast all five categories read “Lean buy” with low conviction, and the stated chance that waiting saves 8% is 19% to 28%, of the same order as the 16.1% base rate. Supply scenarios move the forecast in the expected direction, but modestly: a 20% larger quota next quarter lowers the six-step median by 1.0% to 1.6%, and a 20% smaller quota raises it by 0.5% to 1.4%. The hybrid responds half as much as the TFT alone because its ARIMAX member does not use quota.`),

  H2("F", "System Performance"),
  P(`Table VI reports measurements on a laptop running the Docker Compose stack. The complete pipeline, including the backtest and 27 cross-validation training jobs, took ${Math.round(Math.min(...durations))} to ${Math.round(Math.max(...durations))} s in the last three runs, so weekly retraining is inexpensive. The eight API endpoints that we timed had median latencies of ${latRange("median").replace(" ms", "")} ms and 95th percentiles of at most ${Math.max(...lat.map((x) => x.p95)).toFixed(1)} ms over 100 sequential requests each, because every response is read from pre-computed tables.`),
  table("Operational Measurements (Docker Compose, Laptop)", [2900, 2121], "ll", ["Measurement", "Value"], [
    ["Full pipeline run, last three runs", `${Math.round(Math.min(...durations))}–${Math.round(Math.max(...durations))} s`],
    ["API median latency, 8 endpoints", latRange("median")],
    ["API 95th-percentile latency", latRange("p95")],
    ["Image size: web / api / ml", "94 MB / 318 MB / 1.87 GB"],
    ["Parameters: TFT / LSTM", "88,120 / 5,579"],
    ["Tests passed: ML / API / UI unit / end-to-end", "19 / 63 / 14 / 53"],
  ], "Latency: 100 sequential requests per endpoint through nginx after warm-up."),

  H2("G", "Comparison With Existing Methods"),
  P(`Table VII compares the system with the public tools reviewed in Section II-D, as observed on 1 October 2026. COE Forecast is the only one that publishes prediction intervals and a multi-year backtest against several baselines, and the only one with a bid-level win probability. Quantitatively, our result agrees with the only other published out-of-sample test that we found: the SARIMA project ${cite("sarima")} beats a naive forecast by at most 0.2 percentage points of MAPE in three categories and loses in two, and at the same one-step horizon our hybrid has a MAPE of 3.97% against 3.99% for the random walk. Both results indicate that a next-round point forecast of the COE premium can hardly be improved beyond the last premium, a fact that tools publishing a single number do not disclose. The contribution of our system is to state the uncertainty (S$116,388 to S$151,655 for Cat A in the second exercise of December 2026), to test it and to convert it into bid and timing decisions.`),
  table("Comparison With Public COE Tools", [1421, 880, 800, 880, 1040], "lcccc",
    ["Capability", `Quota.sg\n${cite("quotasg")}`, `COE SG\n${cite("coesg")}`, `SARIMA\n${cite("sarima")}`, "This work"], [
      ["Forecast target", "Quota; timing signal", "Premium, next round", "Premium, next round", "Premium, six exercises"],
      ["Prediction intervals", "No", "No", "No", "p5 to p95"],
      ["Published backtest", "No", "No", "24 rounds", "72 exercises"],
      ["Baselines compared", "None", "None", "Naive", "Seven"],
      ["Policy events modelled", "Quota injections", "No", "No", "Eight events"],
      ["Supply what-if", "–", "–", "–", "±10%, ±20%"],
      ["Bid win probability", "–", "–", "–", "Yes"],
    ], "A dash means that the feature was not offered on the public pages that we reviewed."),

  H2("H", "Usefulness and Market Value"),
  P(`For a private buyer the prototype answers questions that a price chart cannot: how likely a given reserve price is to win, how wide the plausible range is for the next quarter, and whether waiting has a realistic chance of saving money. Repeated buyers have more to gain. Dealers price packages that include a COE, and fleet and leasing operators renew many vehicles every year, so calibrated ranges and scenario budgets have recurring value for them. A commercial version would offer a time-limited pass for private buyers and an API with portfolio upload for dealers and fleets, with the public site serving as evidence of forecast quality. The LTA data are published under the Singapore Open Data Licence, which permits commercial reuse with attribution.`),

  // ---- Section V ----------------------------------------------------------------
  H1("V", "Conclusions"),
  P(`We built COE Forecast, a cloud-native system that forecasts Singapore COE premiums in five categories six exercises ahead as probability distributions. It combines Box-Tiao intervention analysis, a Temporal Fusion Transformer with a random-walk-anchored monotone quantile head, and quantile averaging with an econometric model. In a three-year rolling-origin backtest the hybrid had the lowest pinball loss (S$1,928), MAE (S$5,549) and MAPE (6.81%) of eight methods and the best directional accuracy (59.6%), with 87.9% coverage of its 80% interval.`),
  P(`The main contributions are the hybrid policy-aware forecaster, an evaluation protocol that excludes leakage and tests every claim against a naive benchmark, and a reproducible platform of four containers on Kubernetes that turns forecasts into buy-or-wait signals, bid probabilities, scenarios and explanations. Unlike existing tools, the system publishes its uncertainty and its own backtest.`),
  P(`The work has clear limitations. The advantage over a random walk is 0.45% and is not statistically significant, and turning points are not anticipated. Policy inputs did not improve accuracy in the test period, and most Box-Tiao effects have wide confidence intervals. The intervals are too wide on average and too narrow for Cat A. Each category has only 396 observations, and no data on deregistrations, vehicle population or dealer order books are used. Operationally, the database is a single replica, the watchlist cannot notify users when the site is closed, and the language-model path of the analyst was tested mainly with scripted clients.`),
  P(`Future work will (i) calibrate the intervals per category with adaptive conformal methods; (ii) add the LTA deregistration and vehicle-population series and the published quota schedule as inputs; (iii) keep a public ledger of forecasts issued before each exercise, so that accuracy is verified prospectively; (iv) evaluate the decision rule by regret in dollars and set its threshold on that basis; and (v) add push notifications, a managed database and a portfolio API for dealers and fleet operators.`),

  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Acknowledgment", font: FONT })] }),
  P(`This project uses COE bidding results published by the Land Transport Authority on data.gov.sg and statistics from the Singapore Department of Statistics, accessed under the Singapore Open Data Licence. It is an independent student project and is not endorsed by any government agency.`),
);

// ---- References, contributions and reflections -----------------------------------
const references = order.map((key, i) => new Paragraph({
  style: "IEEEReference", alignment: REFS[key].includes("Available:") ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
  children: [new TextRun({ text: `[${i + 1}]`, font: FONT }), new TextRun({ children: [new Tab()], font: FONT }), ...rich(REFS[key])],
}));
const unused = Object.keys(REFS).filter((k) => !order.includes(k));
if (unused.length) throw new Error(`uncited references: ${unused.join(", ")}`);

const TODO = "==[To be completed by this member: modules built, experiments run, report sections written and presentation part.]==";
const REFLECT = "==[To be written by this member: what was learned during the project, in about 60 to 100 words.]==";
two(
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "References", font: FONT })] }),
  references,
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Individual Workloads and Contributions", font: FONT })] }),
  P(`The project comprised six workstreams: (1) data ingestion and feature engineering; (2) Box-Tiao intervention analysis and the econometric baselines; (3) the TFT, training and backtesting; (4) the API, decision rules and COE Analyst; (5) the web front end and automated tests; and (6) containerisation, Kubernetes deployment and operations scripts. Table VIII lists the share of each member.`),
  table("Workload and Contributions of Each Member", [1500, 3521], "ll", ["Member", "Workload and contributions"],
    AUTHORS.map(([name]) => [name, TODO]), undefined, false),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Reflections on the Learning Journey", font: FONT })] }),
  AUTHORS.map(([name]) => PN(`**${name}.** ${REFLECT}`)),
);

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
const run = (size, extra = {}) => ({ font: FONT, size, color: "000000", ...extra });
const doc = new Document({
  creator: "DSA2111 Group 7", title: "Policy-Aware Probabilistic Forecasting of Singapore COE Premiums", description: "DSA2111 group project report",
  styles: {
    default: {
      document: { run: run(20), paragraph: { spacing: { line: 240 } } },
      heading1: { run: run(20, { smallCaps: true }), paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 200, after: 90 }, keepNext: true } },
      heading2: { run: run(20, { italics: true }), paragraph: { alignment: AlignmentType.LEFT, spacing: { before: 140, after: 70 }, keepNext: true } },
    },
    paragraphStyles: [
      { id: "IEEETitle", name: "IEEE Title", basedOn: "Normal", next: "Normal", quickFormat: true, run: run(48), paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 0, after: 200 } } },
      { id: "IEEEAuthor", name: "IEEE Author", basedOn: "Normal", quickFormat: true, run: run(20), paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 } } },
      { id: "IEEEAbstract", name: "IEEE Abstract", basedOn: "Normal", quickFormat: true, run: run(18, { bold: true }), paragraph: { alignment: AlignmentType.JUSTIFIED, indent: { firstLine: 272 }, spacing: { after: 120 } } },
      { id: "IEEEBody", name: "IEEE Body Text", basedOn: "Normal", quickFormat: true, run: run(20), paragraph: { alignment: AlignmentType.JUSTIFIED, indent: { firstLine: 288 }, spacing: { after: 100, line: 240 } } },
      { id: "IEEEEquation", name: "IEEE Equation", basedOn: "Normal", quickFormat: true, run: run(20), paragraph: { spacing: { before: 80, after: 120 } } },
      { id: "IEEEFigureCaption", name: "IEEE Figure Caption", basedOn: "Normal", quickFormat: true, run: run(16), paragraph: { spacing: { before: 0, after: 160 } } },
      { id: "IEEETableTitle", name: "IEEE Table Title", basedOn: "Normal", quickFormat: true, run: run(16), paragraph: { alignment: AlignmentType.CENTER } },
      { id: "IEEETableText", name: "IEEE Table Text", basedOn: "Normal", quickFormat: true, run: run(16), paragraph: { spacing: { before: 0, after: 0 } } },
      { id: "IEEETableNote", name: "IEEE Table Note", basedOn: "Normal", quickFormat: true, run: run(14), paragraph: { alignment: AlignmentType.LEFT, spacing: { before: 40, after: 160 } } },
      { id: "IEEEReference", name: "IEEE Reference", basedOn: "Normal", quickFormat: true, run: run(16), paragraph: { alignment: AlignmentType.JUSTIFIED, indent: { left: 360, hanging: 360 }, spacing: { after: 30 }, tabStops: [{ type: TabStopType.LEFT, position: 360 }] } },
    ],
  },
  numbering: { config: [{ reference: "ieee-bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 432, hanging: 216 } }, run: { font: FONT } } }] }] },
  sections: [...blocks, { cols: 2, children: [new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: "exact" }, children: [new TextRun({ text: "", size: 2 })] })] }].map((b, i) => ({
    properties: {
      type: i === 0 ? undefined : SectionType.CONTINUOUS,
      page: { size: PAGE, margin: MARGIN },
      column: b.cols === 2 ? { count: 2, space: GAP, equalWidth: true } : { count: 1 },
    },
    children: b.children,
  })),
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(OUT, buffer);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}  (${order.length} references, ${figNo} figures, ${tableNo} tables, ${eqNo} equations)`);
});
