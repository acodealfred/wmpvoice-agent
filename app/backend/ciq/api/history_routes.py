"""User/admin history endpoints (thin wrappers over the db module)."""
import io
import json

from aiohttp import web
from openpyxl import Workbook
from openpyxl.utils import get_column_letter

from db import (
    get_all_users_with_session_info,
    get_manager_analytics,
    get_manager_overview,
    get_manager_score_trend,
    get_pilot_survey_export_rows,
    get_user_survey_records,
)
from demo_data import clear_demo_data, demo_data_status, seed_demo_data

_PILOT_EXPORT_HEADERS = [
    "Index",
    "Total BAT-4 Score",
    "Average BAT-4 Score",
    "Total CBI-WRB3 Score",
    "Average CBI-WRB3 Score",
    "Blink Rate Before",
    "Blink Rate After",
    "Pupil Dilation Before",
    "Pupil Dilation After",
    "Response Latency (ms)",
]


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


async def manager_score_trend(request: web.Request) -> web.Response:
    """GET /manager/score-trend — org-wide average burnout score per month.

    Query params (all optional): department, shift, jobTitle, and months (6 |
    12 | 24 | all) for the look-back window. Defaults to the last 12 months.
    """
    q = request.query
    raw_months = (q.get("months") or "12").lower()
    months = None if raw_months == "all" else int(raw_months) if raw_months.isdigit() else 12
    data = await get_manager_score_trend(
        department=q.get("department") or None,
        shift=q.get("shift") or None,
        job_title=q.get("jobTitle") or None,
        months=months,
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


async def admin_export_pilot_survey(request: web.Request) -> web.Response:
    """GET /admin/pilot-survey/export — download all PILOT survey data as .xlsx.

    One row per survey run: BAT-4 total/average, CBI-WRB3 total/average, and the
    pre/post behaviour capture (blink rate, pupil dilation) + response latency —
    pulled straight from pilot_bat4_scores / pilot_cbi3_scores /
    pilot_behaviour_snapshots (see db.get_pilot_survey_export_rows).
    """
    rows = await get_pilot_survey_export_rows()

    wb = Workbook()
    ws = wb.active
    ws.title = "Pilot Survey"
    ws.append(_PILOT_EXPORT_HEADERS)
    for i, row in enumerate(rows, start=1):
        ws.append([
            i,
            row["bat4_total"], row["bat4_average"],
            row["cbi3_total"], row["cbi3_average"],
            row["blink_rate_before"], row["blink_rate_after"],
            row["pupil_dilation_before"], row["pupil_dilation_after"],
            row["response_latency_ms"],
        ])
    for col_idx, header in enumerate(_PILOT_EXPORT_HEADERS, start=1):
        ws.column_dimensions[get_column_letter(col_idx)].width = max(12, len(header) + 2)

    buf = io.BytesIO()
    wb.save(buf)

    return web.Response(
        body=buf.getvalue(),
        headers={"Content-Disposition": 'attachment; filename="pilot_survey_export.xlsx"'},
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


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
