"""Grounding tools for the chat surfaces — the ONLY way the model reaches data.

Two toolkits share one RBAC-gated dispatcher:
  • Manager (org) tools return de-identified AGGREGATES; filter args are validated
    against the real distinct values, so no name/free-text can smuggle through.
  • Personal (guest) tools return only the CALLER'S OWN data — bound to
    auth.user_id, never a model-supplied id.

Every call goes through `dispatch_tool`, which enforces `rbac.TOOL_ACCESS`
against the trusted `ChatAuth` before touching data. See docs/manager-chat.md.
"""
import json
import logging

from db import (
    get_filter_options,
    get_manager_analytics,
    get_manager_overview,
    get_manager_score_trend,
    get_user_survey_records,
)

from ciq.chat.rbac import ChatAuth, is_authorized
from ciq.kb.mithra_client import call_mithra_kb_chat

logger = logging.getLogger("voicerag")

# ── Tool schemas ───────────────────────────────────────────────────────────

_SEARCH_RESEARCH = {
    "type": "function",
    "function": {
        "name": "search_research",
        "description": (
            "Search the organisation's burnout research knowledge base for evidence on "
            "causes, risk factors, coping strategies and interventions. Returns evidence "
            "snippets WITH citations. Use for any 'why' or 'what should I do' question — "
            "never answer those from general knowledge."
        ),
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Focused research question."}},
            "required": ["query"],
        },
    },
}

MANAGER_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_org_overview",
            "description": (
                "Organisation-wide burnout snapshot: total staff, participation, risk "
                "distribution and per-department aggregates. Also lists the valid "
                "department/shift/jobTitle filter values. Call first for the big picture."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_department_breakdown",
            "description": (
                "Grouped, filterable assessment counts and risk mix. Group by one dimension "
                "and optionally narrow by others (e.g. which shift is most at-risk in a dept)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "groupBy": {"type": "string", "enum": ["department", "shift", "jobTitle"]},
                    "department": {"type": "string"},
                    "shift": {"type": "string"},
                    "jobTitle": {"type": "string"},
                    "risk": {"type": "string", "enum": ["Low", "Moderate", "High"]},
                },
                "required": ["groupBy"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_score_trend",
            "description": (
                "Average burnout score per calendar month (one point per month), optionally "
                "filtered by department/shift/jobTitle. Use for org trend questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "department": {"type": "string"},
                    "shift": {"type": "string"},
                    "jobTitle": {"type": "string"},
                    "months": {"type": "string", "enum": ["6", "12", "24", "all"]},
                },
            },
        },
    },
    _SEARCH_RESEARCH,
]

GUEST_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_my_assessments",
            "description": (
                "The person's own completed assessments: date, survey type, total score, "
                "max score, risk level, interpretation and per-domain totals. Most recent first."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_my_score_trend",
            "description": (
                "The person's own burnout score over time — one point per assessment "
                "(date, score, risk). Use for 'am I improving / getting worse' questions."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_my_latest_report",
            "description": (
                "The person's most recent assessment report: score, risk, interpretation, "
                "per-domain totals, and any behavioural analysis / consultative summary text."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    _SEARCH_RESEARCH,
]


# ── Helpers ────────────────────────────────────────────────────────────────

def _clean(v: str | None, valid: list[str]) -> str | None:
    """Keep a filter value only if it's a real, known value; else drop it."""
    return v if (v and v in valid) else None


def _loads(raw) -> dict:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw) or {}
    except Exception:
        return {}


def _assessment_row(r: dict) -> dict:
    tr = _loads(r.get("technical_report"))
    return {
        "date": (r.get("created_at") or "")[:10],
        "surveyType": r.get("survey_type"),
        "totalScore": tr.get("totalScore"),
        "maxScore": tr.get("maxScore"),
        "riskLevel": tr.get("riskLevel") or tr.get("risk_level"),
        "interpretation": tr.get("interpretation"),
        "domains": tr.get("domainTotals") or tr.get("domain_totals") or {},
        # Surveys with independent scoringSections (e.g. PILOT's BAT-4 / CBI-WRB3) have no
        # single totalScore/riskLevel above — their scores live here instead.
        "sections": tr.get("sections"),
    }


# ── Dispatch (RBAC-gated) ───────────────────────────────────────────────────

async def dispatch_tool(name: str, args: dict, auth: ChatAuth) -> tuple[dict, list]:
    """Run a tool by name. Returns (result_json, citations).

    RBAC is enforced FIRST against the trusted `auth` — a tool the caller's
    scope/role can't use is refused before any data is touched (injection-proof).
    """
    if not is_authorized(name, auth):
        logger.warning(
            "[Chat] RBAC denied tool=%s scope=%s role=%s uid=%s — possible prompt injection",
            name, auth.scope, auth.role, auth.user_id,
        )
        return {"error": "not authorized for this tool on this surface"}, []

    args = args or {}

    # ── Org / aggregate tools ────────────────────────────────────────────
    if name == "get_org_overview":
        overview = await get_manager_overview()
        opts = await get_filter_options()
        return {
            "totalStaff": overview.get("totalGuests", 0),
            "participants": overview.get("participants", 0),
            "surveysCompleted": overview.get("surveysCompleted", 0),
            "riskCounts": overview.get("riskCounts", {}),
            "departments": overview.get("departments", []),
            "filterOptions": opts,
        }, []

    if name == "get_department_breakdown":
        opts = await get_filter_options()
        group_by = args.get("groupBy") or "department"
        if group_by not in ("department", "shift", "jobTitle"):
            group_by = "department"
        risk = args.get("risk") if args.get("risk") in ("Low", "Moderate", "High") else None
        data = await get_manager_analytics(
            department=_clean(args.get("department"), opts["department"]),
            shift=_clean(args.get("shift"), opts["shift"]),
            job_title=_clean(args.get("jobTitle"), opts["jobTitle"]),
            risk=risk,
            group_by=group_by,
        )
        return {
            "groupBy": data["groupBy"], "groups": data["groups"],
            "totalAssessed": data["totalAssessed"], "atRiskPct": data["atRiskPct"],
        }, []

    if name == "get_score_trend":
        opts = await get_filter_options()
        raw_months = str(args.get("months") or "12").lower()
        months = None if raw_months == "all" else int(raw_months) if raw_months.isdigit() else 12
        data = await get_manager_score_trend(
            department=_clean(args.get("department"), opts["department"]),
            shift=_clean(args.get("shift"), opts["shift"]),
            job_title=_clean(args.get("jobTitle"), opts["jobTitle"]),
            months=months,
        )
        return {"points": data["points"]}, []

    # ── Personal tools — bound to auth.user_id, never a model-supplied id ──
    if name == "get_my_assessments":
        recs = await get_user_survey_records(auth.user_id)
        rows = [_assessment_row(r) for r in recs][:20]
        return {"assessments": rows, "count": len(recs)}, []

    if name == "get_my_score_trend":
        recs = await get_user_survey_records(auth.user_id)
        points = []
        for r in recs:
            row = _assessment_row(r)
            if isinstance(row["totalScore"], (int, float)):
                points.append({"date": row["date"], "score": row["totalScore"], "risk": row["riskLevel"]})
        points.sort(key=lambda p: p["date"])  # oldest → newest
        return {"points": points}, []

    if name == "get_my_latest_report":
        recs = await get_user_survey_records(auth.user_id)
        if not recs:
            return {"report": None, "note": "No assessments completed yet."}, []
        latest = recs[0]
        base = _assessment_row(latest)
        tr = _loads(latest.get("technical_report"))
        pi = _loads(latest.get("prompt_info"))
        base["behavioralAnalysis"] = tr.get("analysis") or None
        base["consultativeSummary"] = pi.get("agentResponse") or None
        return {"report": base}, []

    # ── Research (both surfaces) ─────────────────────────────────────────
    if name == "search_research":
        query = (args.get("query") or "").strip()
        if not query:
            return {"error": "empty query"}, []
        result = await call_mithra_kb_chat(query)
        if not result:
            return {"evidence": None, "note": "No knowledge-base result available."}, []
        citations = result.get("citations", []) or []
        return {"evidence": result.get("answer", ""), "citations": citations}, citations

    logger.warning("[Chat] unknown tool requested: %s", name)
    return {"error": f"unknown tool {name}"}, []
