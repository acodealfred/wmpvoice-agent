"""Grounding tools for the manager chat — the ONLY way the model reaches data.

Every tool returns aggregates. There is no free-form query path: operational
tools wrap the existing de-identified dashboard functions, and filter arguments
are validated against the real distinct values before they touch the DB, so the
model can never smuggle a name or arbitrary text through a filter. Research goes
through Mithra, which returns evidence snippets + citations.

See docs/manager-chat.md § "The grounding tools".
"""
import logging

from db import (
    get_filter_options,
    get_manager_analytics,
    get_manager_overview,
    get_manager_score_trend,
)

from ciq.kb.mithra_client import call_mithra_kb_chat

logger = logging.getLogger("voicerag")

# OpenAI-style function schemas advertised to the model. Kept deliberately small
# and enumerated — adding data access means adding a PII-safe wrapper here.
TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_org_overview",
            "description": (
                "Organisation-wide burnout snapshot: total staff, participation, "
                "risk distribution (Low/Moderate/High), and per-department aggregates "
                "(participation %, at-risk %, dominant risk, average score). Also lists "
                "the valid department/shift/jobTitle filter values. Call this first when "
                "you need the big picture or to learn which filter values exist."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_department_breakdown",
            "description": (
                "Grouped, filterable assessment counts and risk mix. Group by one "
                "dimension and optionally narrow by others. Use to compare groups "
                "(e.g. which shift is most at-risk within a department)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "groupBy": {"type": "string", "enum": ["department", "shift", "jobTitle"]},
                    "department": {"type": "string", "description": "Optional exact department filter."},
                    "shift": {"type": "string", "description": "Optional exact shift filter."},
                    "jobTitle": {"type": "string", "description": "Optional exact job-title filter."},
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
                "Average burnout score per calendar month (one point per month), "
                "optionally filtered by department/shift/jobTitle. Use for trend or "
                "'is it getting worse/better' questions."
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
    {
        "type": "function",
        "function": {
            "name": "search_research",
            "description": (
                "Search the organisation's burnout research knowledge base for "
                "evidence on causes, risk factors and interventions. Returns evidence "
                "snippets WITH citations. Use this for any 'why' or 'what should I do' "
                "question — never answer those from general knowledge."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Focused research question."},
                },
                "required": ["query"],
            },
        },
    },
]


def _clean(v: str | None, valid: list[str]) -> str | None:
    """Keep a filter value only if it's a real, known value; else drop it."""
    if v and v in valid:
        return v
    return None


async def dispatch_tool(name: str, args: dict) -> tuple[dict, list]:
    """Run a tool by name. Returns (result_json, citations).

    result_json is fed back to the model as the tool result; citations (only
    from search_research) are accumulated for the final answer and its guardrail.
    """
    args = args or {}
    if name == "get_org_overview":
        overview = await get_manager_overview()
        opts = await get_filter_options()
        # Strip the per-node lists — they exist for the campus map, are not needed
        # for reasoning, and keep the tool payload aggregate + compact.
        slim = {
            "totalStaff": overview.get("totalGuests", 0),
            "participants": overview.get("participants", 0),
            "surveysCompleted": overview.get("surveysCompleted", 0),
            "riskCounts": overview.get("riskCounts", {}),
            "departments": overview.get("departments", []),
            "filterOptions": opts,
        }
        return slim, []

    if name == "get_department_breakdown":
        opts = await get_filter_options()
        group_by = args.get("groupBy") or "department"
        if group_by not in ("department", "shift", "jobTitle"):
            group_by = "department"
        risk = args.get("risk")
        if risk not in ("Low", "Moderate", "High"):
            risk = None
        data = await get_manager_analytics(
            department=_clean(args.get("department"), opts["department"]),
            shift=_clean(args.get("shift"), opts["shift"]),
            job_title=_clean(args.get("jobTitle"), opts["jobTitle"]),
            risk=risk,
            group_by=group_by,
        )
        return {
            "groupBy": data["groupBy"],
            "groups": data["groups"],
            "totalAssessed": data["totalAssessed"],
            "atRiskPct": data["atRiskPct"],
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

    if name == "search_research":
        query = (args.get("query") or "").strip()
        if not query:
            return {"error": "empty query"}, []
        result = await call_mithra_kb_chat(query)
        if not result:
            return {"evidence": None, "note": "No knowledge-base result available."}, []
        citations = result.get("citations", []) or []
        # The orchestrator synthesises; hand it the evidence text + citations.
        return {"evidence": result.get("answer", ""), "citations": citations}, citations

    logger.warning("[Chat] unknown tool requested: %s", name)
    return {"error": f"unknown tool {name}"}, []
