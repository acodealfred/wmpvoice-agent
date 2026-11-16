"""Participant ID map CSV — GET /admin/users/participant-map.csv.

Lists every user whose username is a participant code (P004, P060, …) next to
their user id, so admins can hand the mapping to people who can't query the DB.
"""
import csv
import io
import re
from datetime import datetime

from aiohttp import web

from db import get_all_users_with_session_info

# "P004", "p060", " P043 ", "P-043", "P_043": a P, optional separator, digits only.
_PARTICIPANT = re.compile(r"^P[\s_-]*(\d+)$", re.IGNORECASE)


def participant_rows(users: list[dict]) -> list[dict]:
    """Users whose name is a participant code, sorted by the code's number."""
    rows = []
    for u in users:
        m = _PARTICIPANT.match((u.get("name") or "").strip())
        if m:
            rows.append({"user_id": u["user_id"], "name": u["name"], "_n": int(m.group(1))})
    rows.sort(key=lambda r: (r["_n"], r["name"]))
    return [{"user_id": r["user_id"], "name": r["name"]} for r in rows]


def participant_map_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["user_id", "username"])
    writer.writerows([r["user_id"], r["name"]] for r in rows)
    return buf.getvalue()


async def admin_participant_map_csv(request: web.Request) -> web.Response:
    """GET /admin/users/participant-map.csv — admin-only (auth_middleware)."""
    rows = participant_rows(await get_all_users_with_session_info())
    # UTF-8 BOM so Excel opens it with the right encoding.
    body = ("﻿" + participant_map_csv(rows)).encode("utf-8")
    return web.Response(
        body=body,
        content_type="text/csv",
        charset="utf-8",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="participant_id_map_{datetime.utcnow():%Y-%m-%d}.csv"',
        },
    )
