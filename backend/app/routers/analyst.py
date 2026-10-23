"""Ask Compass: a context-aware analyst beside every page, plus the glossary.

POST /api/analyst/chat takes the conversation and *where* the viewer is. The
server rebuilds the numbers from the database, asks the configured language
model (Groq or Claude) or answers in basic mode, and returns the reply with a
whitelist of validated app actions for the browser to perform (persistent ones
need a confirm click).

With ?stream=1 the answer is sent as Server-Sent Events so the browser can show
"Thinking…", tool progress and the text as it is generated:
    event: status  data: {"text": "Checking bid odds…"}
    event: delta   data: {"text": "part of the reply"}
    event: done    data: {"actions": [...], "mode": "llm", "provenance": "...", "notice": null}
Without it the same answer comes back as one JSON object.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict, deque
from typing import Iterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..config import settings
from ..db import engine
from ..glossary import glossary
from ..schemas import AnalystReply, AnalystRequest, AnalystStatus, GlossaryTerm
from ..services.analyst import context as analyst_context
from ..services.analyst import groq_llm, llm, offline
from ..services.analyst import tools as data_tools

router = APIRouter(tags=["analyst"])
log = logging.getLogger(__name__)

WINDOW_S = 600
_recent: dict[str, deque] = defaultdict(deque)


def _rate_limit(key: str) -> None:
    """Simple per-client sliding window (per API worker process) to protect the LLM budget."""
    now = time.monotonic()
    q = _recent[key]
    while q and now - q[0] > WINDOW_S:
        q.popleft()
    if len(q) >= settings.analyst_rate_limit:
        raise HTTPException(status_code=429, detail="You've asked a lot of questions in a short time. "
                                                    "Please wait a few minutes and try again.")
    q.append(now)


@router.get("/glossary", response_model=list[GlossaryTerm])
def glossary_terms():
    """Plain-language and technical definitions used by 'Explain this' and the analyst."""
    return list(glossary().values())


@router.get("/analyst/status", response_model=AnalystStatus)
def analyst_status():
    llm_on = settings.analyst_llm
    return {"mode": "llm" if llm_on else "offline", "provider": settings.analyst_provider,
            "model": settings.analyst_model if llm_on else None}


def _model_events(provider, history, question, ctx, conn, alerts) -> Iterator[tuple]:
    run_tool = lambda name, params: data_tools.run(conn, ctx, name, params)  # noqa: E731
    if provider == "groq":
        yield from groq_llm.stream(history, question, ctx.app_data, ctx.current_view, run_tool, alerts)
        return
    reply, actions, _ = llm.answer(history, question, ctx.app_data, ctx.current_view, run_tool, alerts)
    for a in actions:
        yield ("action", a)
    yield ("delta", reply)


def _events(body: AnalystRequest) -> Iterator[tuple[str, dict]]:
    """The answer as a sequence of (event, data) pairs; opens its own DB connection so it
    can run inside a streaming response."""
    question = body.messages[-1].content.strip()
    client_id = str(body.client_id) if body.client_id else None
    v = body.view
    view = analyst_context.View(page=v.page, category=v.category, scenario=v.scenario or "base", bid=v.bid,
                                event=v.event, quota_pct=v.quota_pct)
    history = [m.model_dump() for m in body.messages[:-1]][-12:]

    with engine.connect() as conn:
        yield ("status", {"text": "Thinking…"})
        ctx = analyst_context.build(conn, view, client_id)
        alerts = {a["id"]: a for a in ctx.alerts}
        provenance = analyst_context.provenance(ctx)
        notice = None

        if settings.analyst_llm and ctx.available:
            actions, wrote = {}, ""
            try:
                for kind, value in _model_events(settings.analyst_provider, history, question, ctx, conn, alerts):
                    if kind == "action":
                        actions.setdefault(json.dumps([value.type, value.params], sort_keys=True), value)
                    elif kind == "delta":
                        wrote += value
                        yield ("delta", {"text": value})
                    else:
                        yield (kind, {"text": value})
                if not wrote.strip():
                    text = " ".join(a.summary + "." for a in actions.values()) or "Sorry, I couldn't answer that."
                    yield ("delta", {"text": text})
                yield ("done", {"actions": [a.as_dict() for a in actions.values()], "mode": "llm",
                                "provenance": provenance, "notice": None})
                return
            except llm.AnalystUnavailable as exc:
                log.warning("Analyst falling back to basic mode: %s", exc)
                if wrote.strip():            # part of the answer is already on screen: finish it honestly
                    yield ("delta", {"text": f"\n\n({exc} The answer above may be incomplete.)"})
                    yield ("done", {"actions": [a.as_dict() for a in actions.values()], "mode": "llm",
                                    "provenance": provenance, "notice": None})
                    return
                notice = f"{exc} Showing a basic answer instead."

        reply, acts = offline.answer(question, ctx, conn)
        yield ("delta", {"text": reply})
        yield ("done", {"actions": [a.as_dict() for a in acts], "mode": "offline",
                        "provenance": provenance if ctx.available else None, "notice": notice})


def _sse(events: Iterator[tuple[str, dict]]) -> Iterator[str]:
    try:
        for event, data in events:
            yield f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
    except Exception:
        log.exception("Analyst stream failed")
        yield f"event: error\ndata: {json.dumps({'text': 'Something went wrong while answering.'})}\n\n"


@router.post("/analyst/chat", response_model=AnalystReply)
def analyst_chat(body: AnalystRequest, request: Request, stream: bool = False):
    client_id = str(body.client_id) if body.client_id else None
    _rate_limit(client_id or (request.client.host if request.client else "anon"))
    if stream:
        return StreamingResponse(_sse(_events(body)), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    reply, done = "", {}
    for event, data in _events(body):
        if event == "delta":
            reply += data["text"]
        elif event == "done":
            done = data
    return {"reply": reply.strip(), **done}
