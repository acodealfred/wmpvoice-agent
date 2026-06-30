"""User/admin history endpoints (thin wrappers over the db module)."""
import json

from aiohttp import web

from db import (
    get_all_users_with_session_info,
    get_manager_analytics,
    get_manager_overview,
    get_user_survey_records,
)
from demo_data import clear_demo_data, demo_data_status, seed_demo_data


async def admin_list_users(request: web.Request) -> web.Response:
    """GET /admin/users — list all users with session stats."""
    users = await get_all_users_with_session_info()
    return web.json_response({"users": users})


async def manager_overview(request: web.Request) -> web.Response:
    """GET /manager/overview — aggregate stats for the manager dashboard."""
    data = await get_manager_overview()
    return web.json_response(data)


async def manager_analytics(request: web.Request) -> web.Response:
    """GET /manager/analytics — filterable, grouped assessment analytics.

    Query params (all optional): department, shift, jobTitle, risk, from, to
    (ISO dates), and groupBy (department | shift | jobTitle).
    """
    q = request.query
    data = await get_manager_analytics(
        department=q.get("department") or None,
        shift=q.get("shift") or None,
        job_title=q.get("jobTitle") or None,
        risk=q.get("risk") or None,
        date_from=q.get("from") or None,
        date_to=q.get("to") or None,
        group_by=q.get("groupBy") or "department",
    )
    return web.json_response(data)


async def get_demo_data(request: web.Request) -> web.Response:
    """GET /admin/demo-data — whether demo data is currently seeded."""
    return web.json_response(await demo_data_status())


async def set_demo_data(request: web.Request) -> web.Response:
    """POST /admin/demo-data {enabled: bool} — seed or wipe demo data."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)
    enabled = bool(body.get("enabled"))
    status = await (seed_demo_data() if enabled else clear_demo_data())
    return web.json_response(status)


async def user_sessions_history(request: web.Request) -> web.Response:
    """GET /api/history — return the logged-in user's completed survey runs."""
    user_id = request["auth_session"]["user_id"]
    records = await get_user_survey_records(user_id)
    for r in records:
        for col in ("survey_results", "technical_report", "prompt_info"):
            if r.get(col):
                try:
                    r[col] = json.loads(r[col])
                except Exception:
                    pass
    return web.json_response({"records": records})
