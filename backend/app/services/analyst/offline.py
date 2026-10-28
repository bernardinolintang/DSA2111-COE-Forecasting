"""Basic mode: a deterministic analyst that needs no language model.

Used when no language-model key is configured and as the fallback when the
model is unavailable. It recognises the common requests (navigation, scenarios,
bid odds, watchlist drafts, "why this outlook?", "what does X mean?") and answers
them from the same context and tools as the LLM path, so every number is real.
Anything else gets an honest "I can't answer that in basic mode" plus ideas.
"""

from __future__ import annotations

import re

from sqlalchemy.engine import Connection

from ...glossary import glossary
from .. import scenarios as sc
from . import tools
from .actions import Action, ActionError, validate
from .context import AnalystContext

# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------
_CAT = re.compile(r"\bcat(?:egory)?\s*[-.]?\s*([a-e])\b", re.I)
_MONEY = re.compile(r"(\$)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|thousand|m|mil|million)?\b(?!\s*%)", re.I)
_PCT = re.compile(r"(\d{1,2}(?:\.\d+)?)\s*(?:%|percent)", re.I)
_UP = r"\+|plus|more|increases?|higher|rises?|up|raised?"
_DOWN = r"-|minus|less|fewer|decreases?|cuts?|lower|drops?|falls?|down|reduced?"

PAGE_WORDS = [
    ("bid", r"\bbid(?:ding)?\s*planner\b|\bplanner\b|\bbid page\b"),
    ("scenario", r"\bscenario lab\b|\bscenarios?\b|\bsupply slider\b"),
    ("plan", r"\bmy plan\b|\bmy situation\b|\bplan page\b|\bcoe plan\b"),
    ("policy", r"\bpolicy\b|\bpolicies\b|\bpolicy lab\b|\binterventions?\b"),
    ("learn", r"\blearn\b|\bfaq\b|\bguide\b|\bdata sources?\b|\bmethodology\b|\bhelp page\b"),
    ("model", r"\bmodel page\b|\bmodel\b|\baccuracy\b|\bevaluation\b|\bperformance\b"),
    ("alerts", r"\bwatch ?list\b|\balerts?\b"),
    ("overview", r"\boverview\b|\bhome\b|\bdashboard\b"),
    ("forecast", r"\bforecasts?\b|\bpredictions?\b|\bchart\b"),
]
NAV_VERB = re.compile(r"\b(show|open|take me|go to|go back|navigate|switch|bring me|view|see|display|jump)\b", re.I)

GLOSSARY_KEYS = [
    ("range-80", r"80\s*%|80 percent|p10|p90"),
    ("range-50", r"50\s*%\s*range|50 percent range|p25|p75"),
    ("significance", r"\bn\.?s\.?\b|not significant|significan|p\s*<\s*0?\.05|p-?value|\bunclear\b"),
    ("confidence-interval", r"confidence interval|\bci\b|whisker"),
    ("box-tiao", r"box[- ]?tiao|intervention analysis"),
    ("smape", r"\bsmape\b"),
    ("mape", r"\bmape\b|average error"),
    ("pinball", r"pinball"),
    ("coverage", r"coverage"),
    ("direction", r"direction accuracy|up ?/ ?down calls"),
    ("diebold-mariano", r"diebold|\bdm\b"),
    ("random-walk", r"random walk"),
    ("attention", r"attention"),
    ("variable-importance", r"variable importance|importance|what the tft looks at"),
    ("tft", r"\btft\b|transformer"),
    ("hybrid", r"hybrid"),
    ("backtest", r"backtest|out[- ]of[- ]sample"),
    ("uncertainty", r"model uncertainty|uncertainty level|conviction|confidence"),
    ("prob-drop", r"drop of \d+\s*%|chance of a drop|meaningful drop"),
    ("pqp", r"\bpqp\b|prevailing quota|renew"),
    ("effect-types", r"permanent|temporary|one-off|shift|shock"),
    ("supply-scenario", r"scenario|supply"),
    ("win-probability", r"chance of winning|win(?:ning)? probability|probability of winning"),
    ("reserve-price", r"reserve price"),
    ("median", r"median"),
    ("horizon", r"horizon|quarters? ahead|further ahead"),
    ("bids-per-coe", r"bids per coe|demand pressure|bid ratio"),
    ("quota", r"quota"),
    ("categories", r"categor(?:y|ies)|difference between cat|cat a (?:and|vs\.?|versus) cat b"),
    ("watchlist", r"watch ?list|alerts?"),
    ("premium", r"premium"),
    ("outlook", r"outlook|pressure|no clear direction|buy now|\bwait\b|should i buy"),
    ("coe", r"\bcoe\b"),
]

PAGE_INTRO = {
    "overview": "The Overview shows today's premium for each of the five COE categories, how it moved since the "
                "last exercise, the forecast for the next exercise and the market outlook for the next quota quarter.",
    "forecast": "The Forecast page shows the premium history as the solid line and the model's forecast for the next "
                "six exercises: the dashed line is the middle estimate (median) and the shaded bands are the 50% and "
                "80% ranges. The card on the right is the market outlook: which way the forecast leans, how "
                "uncertain it is, and why.",
    "scenario": "The Scenario Lab shows how the forecast responds if next quarter's COE quota is higher or lower "
                "than today's. Drag the slider between -20% and +20%; the grey dashed line is the forecast as "
                "announced, for comparison.",
    "plan": "My plan turns the forecast into a short personal summary: tell it whether you're buying or renewing, "
            "your category, timing and COE budget, and it shows the outlook, the forecast range, how your budget "
            "compares and a level worth watching.",
    "learn": "Learn explains how COE works, how COE Compass makes its forecasts, where the data comes from and "
             "how to use each tool.",
    "bid": "The Bid planner shows your chance of winning the next exercise at any bid. Every winner pays the same "
           "premium, so bidding higher only buys certainty – it doesn't change what you pay.",
    "policy": "Policy Lab measures how past policy changes (loan curbs, quota injections, EV rules) moved premiums, "
              "after allowing for the market's normal ups and downs. Bars are estimated effects; whiskers are the "
              "uncertainty.",
    "model": "Model performance shows how accurate the forecasts were on three years of auctions the model never "
             "saw, compared with simpler methods like 'next premium = today's premium'.",
    "alerts": "The Watchlist lets you save a target such as 'Cat A below $110,000'. It is re-scored after every "
              "bidding exercise and you see the status the next time you open the app – there are no emails.",
}


def _money(v) -> str:
    return f"${v:,.0f}"


def parse_amount(text: str) -> int | None:
    """First plausible dollar amount in free text: $110k, 110,000, 95000, 1.2m."""
    for m in _MONEY.finditer(text):
        dollar, num, suffix = m.group(1), m.group(2).replace(",", ""), (m.group(3) or "").lower()
        try:
            v = float(num)
        except ValueError:
            continue
        if suffix in ("k", "thousand"):
            v *= 1_000
        elif suffix in ("m", "mil", "million"):
            v *= 1_000_000
        elif not dollar and "," not in m.group(2) and (v < 1000 or 1990 <= v <= 2100):
            continue                   # bare small numbers and years are not amounts
        if 0 < v < 10_000_000:
            return int(round(v))
    return None


def detect_category(text: str) -> str | None:
    m = _CAT.search(text)
    return m.group(1).upper() if m else None


def detect_quota_pct(text: str) -> int | None:
    """The quota change a question asks about: 'supply rises 15%' -> 15, '20% fewer COEs' -> -20."""
    t = text.lower().replace("−", "-")
    if re.search(r"as announced|base (?:case|scenario)|current quota|no change", t):
        return 0
    m = (re.search(rf"(?<![a-z])({_UP}|{_DOWN})(?![a-z])(?:\s+(?:the\s+)?(?:quota|supply|coes?))?"
                   rf"\s*(?:by\s*)?(\d{{1,2}})\s*%?", t)
         or re.search(rf"(\d{{1,2}})\s*%\s*({_UP}|{_DOWN})(?![a-z])", t))
    if not m:
        return None
    word, size = (m.group(1), m.group(2)) if not m.group(1)[0].isdigit() else (m.group(2), m.group(1))
    size = int(size)
    if not 1 <= size <= sc.MAX_PCT:
        return None
    return size if re.fullmatch(_UP, word) else -size


def detect_page(text: str) -> str | None:
    for page, pattern in PAGE_WORDS:
        if re.search(pattern, text, re.I):
            return page
    return None


# ---------------------------------------------------------------------------
# The intent handler
# ---------------------------------------------------------------------------
def answer(question: str, ctx: AnalystContext, conn: Connection) -> tuple[str, list[Action]]:
    q = question.strip()
    ql = q.lower()
    view = ctx.view
    cat = detect_category(q) or view.category
    alerts = {a["id"]: a for a in ctx.alerts}

    def act(name, **params) -> Action:
        return validate(name, params, alerts)

    if not ctx.available:
        return ("There are no forecasts yet – the model hasn't finished its first run, so I can't quote any "
                "numbers. Try again once the Overview shows data."), []

    try:
        # 1. Tour / help
        if re.search(r"\b(tour|tutorial|walk ?through|onboarding|how do i use)\b", ql):
            return "Starting the 2-minute tour – use Next and Back to move through it.", [act("open_tutorial", step=1)]

        # 2. Watchlist drafts ("alert me when Cat A falls below $110k")
        if re.search(r"\b(alert|notify|tell me|let me know|watch|remind)\b", ql) and \
                re.search(r"\b(below|under|less than|drops?|falls?|cheaper|above|over|more than|exceeds?|rises?|goes up)\b", ql):
            target = parse_amount(q)
            if not cat:
                return "Which category should I watch? For example: 'Watch Cat A below $110,000'.", []
            if not target:
                return (f"What premium should I watch for Cat {cat}? For example: "
                        f"'Watch Cat {cat} below $110,000'."), []
            direction = "above" if re.search(r"\b(above|over|more than|exceeds?|rises?|goes up)\b", ql) else "below"
            o = tools.run(conn, ctx, "target_outlook", {"category": cat, "direction": direction, "target": target})
            outlook = ("The latest premium has already crossed that target." if o["status"] == "triggered" else
                       f"The model gives it about a {o['chance_within_quarter_pct']:.0f}% chance within the next "
                       f"quota quarter ({o['status']}).")
            return (f"I can add Cat {cat} {direction} {_money(target)} to your watchlist. {outlook} "
                    f"Press Confirm to save it – you'll see its status each time you open the app "
                    f"(there are no emails or push messages)."), [act("prepare_watch", category=cat,
                                                                       direction=direction, target=target)]

        # 3. "How much should I bid for a 90% chance?"
        if re.search(r"\bbid\b", ql) and re.search(r"how much|what should|what bid|how high|need to bid", ql):
            if not cat:
                return "Which category are you bidding in (A–E)?", []
            pm = _PCT.search(q)
            if pm:
                p = float(pm.group(1))
                r = tools.run(conn, ctx, "bid_for_probability", {"category": cat, "probability_pct": p})
                return (f"For an estimated {p:.0f}% chance of winning Cat {cat} in the {r['exercise']} exercise, "
                        f"bid about {_money(r['bid'])}. That's a model estimate, not a guarantee. If you win you pay "
                        f"the premium, not your bid – the median forecast is {_money(r['expected_premium_median'])}."
                        ), [_bid_action(view, cat, r["bid"])]
            sug = next(c for c in ctx.app_data["categories"] if c["code"] == cat).get("bid_suggestions_next_exercise")
            if not sug:
                return f"There's no forecast for Cat {cat} yet.", []
            lines = ", ".join(f"{k.split('%')[0]}% chance: {_money(v)}" for k, v in sug.items())
            return (f"It depends how sure you want to be. Estimated bids for the next Cat {cat} exercise – {lines}. "
                    f"Everyone who wins pays the same premium, so a higher bid only buys certainty."
                    ), [_bid_action(view, cat, sug["90%_chance"])]

        # 4. "What's my chance if I bid $130k?"
        amount = parse_amount(q)
        if amount and re.search(r"\b(chance|odds|probability|win)\b", ql) and re.search(r"\bbid", ql):
            if not cat:
                return "Which category (A–E) is that bid for?", []
            r = tools.run(conn, ctx, "bid_win_probability", {"category": cat, "bid": amount})
            return (f"A {_money(amount)} bid has an estimated {r['win_probability_pct']:.0f}% chance of winning "
                    f"Cat {cat} in the {r['exercise']} exercise (model forecast)."), [_bid_action(view, cat, amount)]

        # 5. Supply scenario
        pct = detect_quota_pct(q)
        if pct is not None and (re.search(r"scenario|supply|quota", ql) or NAV_VERB.search(ql)):
            target_cat = cat or "A"
            r = tools.run(conn, ctx, "scenario_forecast", {"category": target_cat, "quota_pct": pct})
            end = r["steps"][-1]
            note = " (interpolated between the modelled scenarios)" if r["interpolated"] else ""
            return (f"Under '{r['scenario']}'{note}, the model's median for Cat {target_cat} in "
                    f"{end['exercise']} is {_money(end['median'])} (80% range {_money(end['p10'])}–"
                    f"{_money(end['p90'])}), and the outlook is '{r['outlook']['label']}'."
                    ), [act("set_supply_scenario", quota_pct=pct, category=target_cat)]

        # 6. Biggest policy impact
        if re.search(r"(biggest|largest|most|strongest).*(impact|effect|change|moved|affect)|"
                     r"(impact|effect).*(most|biggest|largest)|what changed", ql):
            return _biggest_policy(ctx, cat or "B")

        # 7. Navigation ("show me Cat E", "take me to the bid planner for Cat A")
        page = detect_page(q)
        if NAV_VERB.search(ql) and (page or detect_category(q)):
            if page is None:
                page = view.page if view.page in ("forecast", "scenario", "bid", "policy") else "forecast"
            params = {"page": page}
            if detect_category(q) or page in ("forecast", "scenario", "bid"):
                params["category"] = cat or "A"
            a = act("navigate", **params)
            return f"{a.summary}.", [a]

        # 8. Why this outlook? / Should I buy or wait?
        if re.search(r"should i (?:buy|wait)|buy (?:now )?or wait|good time to buy", ql):
            text, acts = _why(ctx, cat or "A")
            return ("COE Compass doesn't tell you to buy or to wait: it forecasts the COE premium, which is only "
                    "one part of that decision. Here is what the forecast says. " + text), acts
        if re.search(r"\bwhy\b", ql) and re.search(
                r"buy|wait|recommend|signal|say|show|lean|outlook|pressure|direction", ql):
            if re.search(r"\b(all|every|each|both)\b|categories", ql):
                return _why_all(ctx)
            return _why(ctx, cat or "A")

        # 9. How certain is this?
        if re.search(r"how (?:certain|sure|confident|reliable|accurate)|uncertain", ql):
            return _certainty(ctx, cat)

        # 10. Quota vs premium
        if re.search(r"quota|supply", ql) and re.search(r"reduce|lower|increase|raise|affect|effect|impact|drop", ql):
            return _quota_effect(conn, ctx, cat or "B")

        # 11. Explain this page
        if re.search(r"explain (?:this|the) page|what am i looking at|what is this page|first car|beginner", ql):
            intro = PAGE_INTRO.get(view.page, PAGE_INTRO["overview"])
            tip = ""
            if view.page in ("forecast", "overview") and cat:
                c = next((c for c in ctx.app_data["categories"] if c["code"] == cat), None)
                if c and c.get("outlook"):
                    tip = f" For Cat {cat} right now: {c['outlook']['summary']}"
            return intro + tip, []

        # 12. Glossary
        for term_id, pattern in GLOSSARY_KEYS:
            if re.search(pattern, ql):
                g = glossary()[term_id]
                return f"{g['term']}: {g['simple']}\n\nMore detail: {g['technical']}", []

        # 13. Cat A vs Cat B
        if re.search(r"difference|compare|versus|\bvs\b", ql) and len(set(_CAT.findall(q))) >= 2:
            return glossary()["categories"]["simple"], []
    except ActionError as exc:
        return f"I couldn't do that: {exc}", []

    return (
        "I can't answer that in basic mode – the AI model isn't available on this server right now. I can still: "
        "open pages ('show me Cat E'), try supply scenarios ('what if supply rises 10%?'), work out bids "
        "('how much should I bid for a 90% chance on Cat A?'), explain terms ('what does n.s. mean?'), explain "
        "an outlook ('why is Cat A showing no clear direction?') or draft a watchlist target "
        "('watch Cat B below $120k')."), []


# ---------------------------------------------------------------------------
# Composed answers
# ---------------------------------------------------------------------------
def _bid_action(view, cat: str, bid: int) -> Action:
    if view.page == "bid" and view.category == cat:
        return validate("set_bid_amount", {"amount": bid, "category": cat})
    return validate("navigate", {"page": "bid", "category": cat, "bid": bid})


def _category_entry(ctx: AnalystContext, cat: str) -> dict:
    return next(c for c in ctx.app_data["categories"] if c["code"] == cat)


def _why(ctx: AnalystContext, cat: str):
    c = _category_entry(ctx, cat)
    rec = c.get("outlook")
    if not rec:
        return f"There's no forecast for Cat {cat} yet.", []
    rule = ctx.app_data["outlook_rule"]
    fc = c["forecast_as_announced"]["end_of_quarter"]
    latest = c["latest_result"]
    text = (f"Cat {cat} shows '{rec['label']}'. The latest premium was {_money(latest['premium'])} "
            f"({latest['exercise']}); the model's median for {fc['exercise']} is {_money(fc['median'])} "
            f"({rec['expected_change_pct']:+.1f}%), with a {rec['prob_lower_pct']:.0f}% chance the premium is lower "
            f"by then and a {rec['prob_higher_pct']:.0f}% chance it is higher. ")
    if rec["strength"] == "none":
        text += (f"Neither side reaches the {rule['slight_direction_from_pct']}% the app needs before it calls a "
                 f"direction, so this is close to a coin flip, not a prediction that prices will hold. ")
    else:
        text += (f"The app calls a slight direction from {rule['slight_direction_from_pct']}% and a clear one from "
                 f"{rule['clear_direction_from_pct']}%. ")
    text += (f"A drop of {rule['meaningful_drop_pct']}% or more has a {rec['prob_meaningful_drop_pct']:.0f}% chance. "
             f"Model uncertainty is {rec['model_uncertainty']}.")
    return text, [validate("highlight", {"target": "recommendation"})] if ctx.view.page == "forecast" else []


def _why_all(ctx: AnalystContext):
    cats = [c for c in ctx.app_data["categories"] if c.get("outlook")]
    if not cats:
        return "There are no forecasts yet.", []
    rule = ctx.app_data["outlook_rule"]
    labels = {c["outlook"]["label"] for c in cats}
    lines = [f"- {c['name']}: {c['outlook']['label']}, median {c['outlook']['expected_change_pct']:+.1f}% by the end "
             f"of the quarter, {c['outlook']['prob_lower_pct']:.0f}% chance lower, "
             f"{c['outlook']['prob_meaningful_drop_pct']:.0f}% chance it drops {rule['meaningful_drop_pct']}% or more"
             for c in cats]
    if len(labels) == 1:
        head = (f"All {len(cats)} categories show '{labels.pop()}' because in each one the odds of a higher and of a "
                f"lower premium are both under {rule['slight_direction_from_pct']}%, which is what the app needs "
                f"before it calls a direction.")
    else:
        head = (f"The categories differ; the app calls a direction only when the odds of a higher or lower premium "
                f"reach {rule['slight_direction_from_pct']}%.")
    tail = ("COE premiums move close to a random walk, so the model rarely forecasts a big move. 'No clear "
            "direction' means the direction is close to a coin flip, not that prices are sure to stay put.")
    return head + "\n\n" + "\n".join(lines) + "\n\n" + tail, []


def _certainty(ctx: AnalystContext, cat: str | None):
    acc = ctx.app_data.get("model_accuracy") or {}
    hybrid = next((r for r in acc.get("leaderboard_by_pinball_loss", []) if r["model"].startswith("Hybrid")), None)
    if not cat:
        if not hybrid:
            return "Pick a category (A–E) and I'll show how wide its forecast range is.", []
        return (f"In the out-of-sample test the median forecast was off by {hybrid['mape_pct']}% on average, and "
                f"{hybrid['coverage80_pct']:.0f}% of real results fell inside the 80% range. Pick a category and "
                f"I'll show its current range."), []
    c = _category_entry(ctx, cat)
    if "forecast_as_announced" not in c:
        return f"There's no forecast for Cat {cat} yet.", []
    nxt, end = c["forecast_as_announced"]["next_exercise"], c["forecast_as_announced"]["end_of_quarter"]
    text = (f"For the next exercise ({nxt['exercise']}) the model's 80% range for Cat {cat} is "
            f"{_money(nxt['range_80'][0])}–{_money(nxt['range_80'][1])}; by {end['exercise']} it widens to "
            f"{_money(end['range_80'][0])}–{_money(end['range_80'][1])}, because uncertainty grows the further "
            f"ahead it looks.")
    if hybrid:
        text += (f" In the out-of-sample test the median was off by {hybrid['mape_pct']}% on average, and "
                 f"{hybrid['coverage80_pct']:.0f}% of real results fell inside the 80% range.")
    return text, []


def _biggest_policy(ctx: AnalystContext, cat: str):
    best = None
    for ev in ctx.app_data["policy_events"]:
        for e in ev["estimated_effects"]:
            if e["category"] == cat and (best is None or abs(e["effect_pct"]) > abs(best[1]["effect_pct"])):
                best = (ev, e)
    if not best:
        return f"There are no estimated policy effects for Cat {cat} yet.", []
    ev, e = best
    sig = ("statistically significant (p<0.05)" if e["significant"]
           else "unclear (not statistically significant), so treat it as a rough indication")
    ci = f" (95% interval {e['ci95_pct'][0]:+.1f}% to {e['ci95_pct'][1]:+.1f}%)" if e.get("ci95_pct") else ""
    word = "higher" if e["effect_pct"] > 0 else "lower"
    return (f"The largest estimated effect on Cat {cat} is the {ev['name']} ({ev['effective']}): premiums about "
            f"{abs(e['effect_pct']):.1f}% {word}{ci}. It is {sig}."), \
        [validate("navigate", {"page": "policy", "category": cat, "event": ev["code"]})]


def _quota_effect(conn: Connection, ctx: AnalystContext, cat: str):
    lo = tools.run(conn, ctx, "scenario_forecast", {"category": cat, "quota_pct": -20})
    hi = tools.run(conn, ctx, "scenario_forecast", {"category": cat, "quota_pct": 20})
    a, b = lo["steps"][-1], hi["steps"][-1]
    return (f"In general, more COEs for the same demand means lower premiums. In this model, for Cat {cat} by "
            f"{a['exercise']}: with 20% less supply the median is {_money(a['median'])}; with 20% more supply it is "
            f"{_money(b['median'])}. That's the model's estimate of the quota effect, alongside everything else it "
            f"looks at."), [validate("set_supply_scenario", {"quota_pct": 20, "category": cat})]

