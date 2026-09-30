"""The analyst's whitelist of app actions and read-only data tools.

UI actions are *proposals*: the server validates them and returns them to the
browser, which performs them. The model never touches the page directly, and
anything persistent (creating or removing a watchlist target) is returned with
``confirm=True`` so the app shows a Confirm button instead of acting.

Data tools run on the server against the database and return numbers the model
may quote (bid odds, other scenarios, history).
"""

from __future__ import annotations

from dataclasses import dataclass

from ...glossary import glossary
from ...labels import CATEGORIES, SCENARIOS
from .context import PAGES

CATS = list(CATEGORIES)
HIGHLIGHTS = {
    "category-cards": "the five category cards",
    "forecast-chart": "the premium & forecast chart",
    "recommendation": "the recommendation card",
    "scenario-picker": "the supply scenario picker",
    "forecast-table": "the next six exercises table",
    "bid-chart": "the chance-of-winning chart",
    "bid-suggestions": "the suggested reserve prices",
    "policy-chart": "the policy history chart",
    "policy-events": "the policy events timeline",
    "model-summary": "the model trust summary",
    "leaderboard": "the model leaderboard",
    "error-by-horizon": "the error-by-horizon chart",
    "watchlist-form": "the watchlist form",
}
MAX_TARGET = 999_999


class ActionError(ValueError):
    pass


@dataclass
class Action:
    type: str
    params: dict
    confirm: bool
    summary: str

    def as_dict(self) -> dict:
        return {"type": self.type, "params": self.params, "confirm": self.confirm, "summary": self.summary}


def _money(v: float) -> str:
    return f"${v:,.0f}"


# ---------------------------------------------------------------------------
# Tool definitions (JSON schema) shown to the model
# ---------------------------------------------------------------------------
_cat = {"type": "string", "enum": CATS, "description": "COE category code."}
UI_TOOLS = [
    {
        "name": "navigate",
        "description": "Open a page of the app, optionally for a category. Use when the user asks to see or go "
                       "somewhere, or when showing a page clearly helps them. Pages: overview, forecast, bid "
                       "(bid planner), policy (Policy Lab), model (accuracy/methodology), alerts (watchlist).",
        "input_schema": {
            "type": "object",
            "properties": {
                "page": {"type": "string", "enum": list(PAGES)},
                "category": _cat,
                "scenario": {"type": "string", "enum": list(SCENARIOS),
                             "description": "Supply scenario, forecast page only."},
                "bid": {"type": "number", "description": "Bid amount in SGD, bid page only."},
                "event": {"type": "string", "description": "Policy event code to highlight, policy page only."},
            },
            "required": ["page"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_supply_scenario",
        "description": "Switch the forecast's next-quarter supply scenario (opens the forecast page if needed).",
        "input_schema": {
            "type": "object",
            "properties": {"scenario": {"type": "string", "enum": list(SCENARIOS)}, "category": _cat},
            "required": ["scenario"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_bid_amount",
        "description": "Set the Bid planner's bid (reserve price) so the user sees its chance of winning.",
        "input_schema": {
            "type": "object",
            "properties": {"amount": {"type": "number", "description": "SGD, e.g. 125000."}, "category": _cat},
            "required": ["amount"],
            "additionalProperties": False,
        },
    },
    {
        "name": "highlight",
        "description": "Briefly highlight a part of the current page that you are explaining.",
        "input_schema": {
            "type": "object",
            "properties": {"target": {"type": "string", "enum": list(HIGHLIGHTS)}},
            "required": ["target"],
            "additionalProperties": False,
        },
    },
    {
        "name": "open_tutorial",
        "description": "Start the guided tour of the app (steps 1-7: overview, forecast, supply scenarios, bid "
                       "planner, policy lab, model, watchlist).",
        "input_schema": {
            "type": "object",
            "properties": {"step": {"type": "integer", "minimum": 1, "maximum": 7}},
            "additionalProperties": False,
        },
    },
    {
        "name": "prepare_watch",
        "description": "Draft a watchlist target, e.g. Cat A below $110,000. The app shows the user a Confirm "
                       "button; nothing is saved until they press it. Never say it has been created.",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": _cat,
                "direction": {"type": "string", "enum": ["below", "above"]},
                "target": {"type": "number", "description": "Premium in SGD."},
                "note": {"type": "string", "description": "Optional short note, max 80 characters."},
            },
            "required": ["category", "direction", "target"],
            "additionalProperties": False,
        },
    },
    {
        "name": "prepare_remove_watch",
        "description": "Draft removing one of the user's watchlist targets (by id from current_view.watchlist). "
                       "The app asks the user to confirm.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
]

DATA_TOOLS = [
    {
        "name": "bid_win_probability",
        "description": "Chance that a bid wins the NEXT bidding exercise for a category (P(premium <= bid)).",
        "input_schema": {
            "type": "object",
            "properties": {"category": _cat, "bid": {"type": "number"}},
            "required": ["category", "bid"],
            "additionalProperties": False,
        },
    },
    {
        "name": "bid_for_probability",
        "description": "The bid needed for a given estimated chance of winning the next exercise.",
        "input_schema": {
            "type": "object",
            "properties": {"category": _cat,
                           "probability_pct": {"type": "number", "minimum": 1, "maximum": 99}},
            "required": ["category", "probability_pct"],
            "additionalProperties": False,
        },
    },
    {
        "name": "scenario_forecast",
        "description": "Forecast (next six exercises) and recommendation for a category under a supply scenario.",
        "input_schema": {
            "type": "object",
            "properties": {"category": _cat, "scenario": {"type": "string", "enum": list(SCENARIOS)}},
            "required": ["category", "scenario"],
            "additionalProperties": False,
        },
    },
    {
        "name": "target_outlook",
        "description": "Chance a premium target is reached within the next quota quarter (as the watchlist "
                       "scores it).",
        "input_schema": {
            "type": "object",
            "properties": {"category": _cat, "direction": {"type": "string", "enum": ["below", "above"]},
                           "target": {"type": "number"}},
            "required": ["category", "direction", "target"],
            "additionalProperties": False,
        },
    },
    {
        "name": "history_summary",
        "description": "Summary of recorded bidding results for a category over the last N years "
                       "(0 = all history since 2010): lowest, highest, average and latest premium.",
        "input_schema": {
            "type": "object",
            "properties": {"category": _cat, "years": {"type": "integer", "minimum": 0, "maximum": 20}},
            "required": ["category", "years"],
            "additionalProperties": False,
        },
    },
]

UI_TOOL_NAMES = {t["name"] for t in UI_TOOLS}
DATA_TOOL_NAMES = {t["name"] for t in DATA_TOOLS}

# For providers whose prompt is kept compact (Groq), the glossary is looked up on demand
# instead of being sent with every question.
EXPLAIN_TOOL = {
    "name": "explain_term",
    "description": "This app's plain-language and technical definition of a term shown in the UI.",
    "input_schema": {
        "type": "object",
        "properties": {"term": {"type": "string", "enum": list(glossary())}},
        "required": ["term"],
        "additionalProperties": False,
    },
}


# ---------------------------------------------------------------------------
# Validation: every UI action goes through here, whether it came from the
# model or from the offline intent parser.
# ---------------------------------------------------------------------------
def _category(value, required=True) -> str | None:
    if value is None and not required:
        return None
    code = str(value or "").strip().upper().removeprefix("CAT ").removeprefix("CAT")
    if code not in CATEGORIES:
        raise ActionError(f"Unknown category {value!r}; use A-E.")
    return code


def _amount(value, what="amount") -> int:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ActionError(f"{what} must be a number.") from None
    if not (0 < v <= MAX_TARGET):
        raise ActionError(f"{what} must be between $1 and {_money(MAX_TARGET)}.")
    return int(round(v))


def validate(name: str, params: dict, alerts: dict[int, dict] | None = None) -> Action:
    """``alerts``: the viewer's watchlist by id, used to check removal requests."""
    p = dict(params or {})
    if name == "navigate":
        page = p.get("page")
        if page not in PAGES:
            raise ActionError(f"Unknown page {page!r}.")
        out = {"page": page}
        cat = _category(p.get("category"), required=False)
        if cat and page in ("forecast", "bid", "policy"):
            out["category"] = cat
        if page == "forecast" and p.get("scenario"):
            if p["scenario"] not in SCENARIOS:
                raise ActionError("Unknown scenario.")
            out["scenario"] = p["scenario"]
        if page == "bid" and p.get("bid") is not None:
            out["bid"] = _amount(p["bid"], "bid")
        if page == "policy" and p.get("event"):
            out["event"] = str(p["event"])[:64]
        where = PAGES[page] + (f" for Cat {out['category']}" if "category" in out else "")
        return Action("navigate", out, False, f"Open {where}")

    if name == "set_supply_scenario":
        if p.get("scenario") not in SCENARIOS:
            raise ActionError("Unknown scenario.")
        out = {"scenario": p["scenario"]}
        cat = _category(p.get("category"), required=False)
        if cat:
            out["category"] = cat
        return Action(name, out, False, f"Supply scenario: {SCENARIOS[p['scenario']]['label']}")

    if name == "set_bid_amount":
        out = {"amount": _amount(p.get("amount"), "bid")}
        cat = _category(p.get("category"), required=False)
        if cat:
            out["category"] = cat
        return Action(name, out, False, f"Set bid to {_money(out['amount'])}")

    if name == "highlight":
        if p.get("target") not in HIGHLIGHTS:
            raise ActionError("Unknown highlight target.")
        return Action(name, {"target": p["target"]}, False, f"Highlight {HIGHLIGHTS[p['target']]}")

    if name == "open_tutorial":
        step = p.get("step", 1)
        if not isinstance(step, int) or not 1 <= step <= 7:
            step = 1
        return Action(name, {"step": step}, False, "Start the guided tour" + (f" at step {step}" if step > 1 else ""))

    if name == "prepare_watch":
        cat = _category(p.get("category"))
        direction = p.get("direction")
        if direction not in ("below", "above"):
            raise ActionError("direction must be 'below' or 'above'.")
        target = _amount(p.get("target"), "target")
        note = (str(p.get("note") or "").strip()[:80]) or None
        return Action(name, {"category": cat, "direction": direction, "target": target, "note": note}, True,
                      f"Watch Cat {cat} {direction} {_money(target)}")

    if name == "prepare_remove_watch":
        try:
            alert_id = int(p.get("id"))
        except (TypeError, ValueError):
            raise ActionError("id must be an integer.") from None
        a = (alerts or {}).get(alert_id)
        if a is None:
            raise ActionError("That id is not on this user's watchlist.")
        return Action(name, {"id": alert_id}, True,
                      f"Remove Cat {a['category']} {a['direction']} {_money(a['target'])} from the watchlist")

    raise ActionError(f"Unknown action {name!r}.")
