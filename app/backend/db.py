import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

import aiosqlite

DB_PATH = Path(__file__).parent / "data" / "ciq.db"

# A stored baseline is considered valid for this long after it was recorded.
# Enforced at the DB level (see get_user_baseline) so an expired baseline is
# indistinguishable from a missing one and forces a fresh 30s recording.
BASELINE_TTL_HOURS = 12


@asynccontextmanager
async def _open_db():
    """Open a connection with WAL mode and busy-timeout on every call.

    WAL mode is a DB-file property, but applying the PRAGMA on each
    connection guarantees it is active even if a prior process wrote the
    file without WAL.  busy_timeout lets readers wait briefly instead of
    raising 'database is locked'.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA busy_timeout=3000")
        yield db


async def get_user_by_name(name: str) -> dict | None:
    async with _open_db() as db:
        async with db.execute(
            "SELECT user_id, name, password_hash, role FROM users WHERE name = ?", (name,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def get_session_by_token(token: str) -> dict | None:
    """Return the session joined with its owner's role.

    The role is needed by auth_middleware on every request to gate /admin/*
    routes, so it is joined in here rather than fetched separately.
    """
    async with _open_db() as db:
        async with db.execute(
            """SELECT s.*, u.role AS role
               FROM user_sessions s
               JOIN users u ON u.user_id = s.user_id
               WHERE s.session_token = ?""",
            (token,),
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def create_user_session(session_token: str, user_id: str, session_id: str) -> None:
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO user_sessions
               (session_token, user_id, session_id, created_at, last_active_at)
               VALUES (?, ?, ?, ?, ?)""",
            (session_token, user_id, session_id, now, now),
        )
        await db.commit()


async def update_session_activity(session_token: str) -> None:
    async with _open_db() as db:
        await db.execute(
            "UPDATE user_sessions SET last_active_at = ? WHERE session_token = ?",
            (datetime.utcnow().isoformat(), session_token),
        )
        await db.commit()


async def ensure_survey_record(
    survey_run_id: str,
    user_id: str,
    session_token: str | None,
    session_id: str | None,
    survey_type: str | None,
) -> None:
    """Create the survey_records row if it does not exist yet.

    Any of the three persistence writes (results / snapshot / SSoT) may be the
    first to fire for a given run, so each calls this first. INSERT OR IGNORE
    keeps it idempotent — a second caller never clobbers existing data, and a
    non-null survey_type on a later call backfills an earlier null.
    """
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT OR IGNORE INTO survey_records
               (survey_run_id, user_id, session_token, session_id, survey_type,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (survey_run_id, user_id, session_token, session_id, survey_type, now, now),
        )
        if survey_type:
            await db.execute(
                "UPDATE survey_records SET survey_type = COALESCE(survey_type, ?) "
                "WHERE survey_run_id = ?",
                (survey_type, survey_run_id),
            )
        await db.commit()


async def save_survey_record_results(
    survey_run_id: str,
    survey_results: dict,
    technical_report: dict,
    prompt_info: dict,
) -> None:
    """Full write of one survey run's data (from /analyze-report)."""
    async with _open_db() as db:
        await db.execute(
            """UPDATE survey_records
               SET survey_results = ?, technical_report = ?, prompt_info = ?,
                   updated_at = ?
               WHERE survey_run_id = ?""",
            (
                json.dumps(survey_results),
                json.dumps(technical_report),
                json.dumps(prompt_info),
                datetime.utcnow().isoformat(),
                survey_run_id,
            ),
        )
        await db.commit()


async def save_survey_record_snapshot(
    survey_run_id: str,
    survey_results: dict,
    technical_report: dict,
) -> None:
    """Save survey results and a basic technical report only if not already set.

    Called from /ssot-report so a run is recorded in history even when
    /analyze-report is never called. COALESCE means it never overwrites data
    saved by save_survey_record_results, and it leaves prompt_info untouched so
    a later update_survey_record_ssot can safely merge into it.
    """
    async with _open_db() as db:
        await db.execute(
            """UPDATE survey_records
               SET survey_results  = COALESCE(survey_results, ?),
                   technical_report = COALESCE(technical_report, ?),
                   updated_at       = ?
               WHERE survey_run_id = ?""",
            (
                json.dumps(survey_results),
                json.dumps(technical_report),
                datetime.utcnow().isoformat(),
                survey_run_id,
            ),
        )
        await db.commit()


async def merge_survey_record_json(
    survey_run_id: str,
    *,
    technical_report_patch: dict | None = None,
    prompt_info_patch: dict | None = None,
) -> None:
    """Read-modify-write merge of keys into the technical_report / prompt_info JSON columns.

    Used by the on-demand AI endpoints (/report/behavioral-analysis, /report/consultative-summary)
    so each can enrich one part of an existing row (analysis / agentResponse) without
    clobbering the deterministic figures or the other endpoint's output.
    """
    async with _open_db() as db:
        async with db.execute(
            "SELECT technical_report, prompt_info FROM survey_records WHERE survey_run_id = ?",
            (survey_run_id,),
        ) as cursor:
            row = await cursor.fetchone()
        if not row:
            return
        technical = json.loads(row["technical_report"] or "{}")
        prompt = json.loads(row["prompt_info"] or "{}")
        if technical_report_patch:
            technical.update(technical_report_patch)
        if prompt_info_patch:
            prompt.update(prompt_info_patch)
        await db.execute(
            "UPDATE survey_records SET technical_report = ?, prompt_info = ?, updated_at = ? "
            "WHERE survey_run_id = ?",
            (json.dumps(technical), json.dumps(prompt), datetime.utcnow().isoformat(), survey_run_id),
        )
        await db.commit()


async def update_survey_record_ssot(survey_run_id: str, ssot_result: dict) -> None:
    """Merge SSoT outcome (success or failure) into the prompt_info JSON column."""
    async with _open_db() as db:
        async with db.execute(
            "SELECT prompt_info FROM survey_records WHERE survey_run_id = ?", (survey_run_id,)
        ) as cursor:
            row = await cursor.fetchone()
        if not row:
            return
        existing = json.loads(row["prompt_info"] or "{}")
        existing["ssotReport"] = ssot_result
        await db.execute(
            "UPDATE survey_records SET prompt_info = ?, updated_at = ? WHERE survey_run_id = ?",
            (json.dumps(existing), datetime.utcnow().isoformat(), survey_run_id),
        )
        await db.commit()


async def get_user_survey_records(user_id: str) -> list[dict]:
    """Return a user's survey runs that have recorded data, most recent first."""
    async with _open_db() as db:
        async with db.execute("""
            SELECT survey_run_id, session_id, survey_type, created_at, updated_at,
                   survey_results, technical_report, prompt_info
            FROM survey_records
            WHERE user_id = ?
              AND (survey_results IS NOT NULL OR prompt_info IS NOT NULL)
            ORDER BY created_at DESC
        """, (user_id,)) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]


async def get_user_baseline(user_id: str) -> dict | None:
    """Return the user's calibrated baseline if it is still within the TTL, else None.

    The 12-hour TTL is enforced here (DB level) by filtering on updated_at — the
    moment the row was last (re)recorded — so an expired baseline is returned as
    None, indistinguishable from a missing one, forcing a fresh recording. ISO-8601
    timestamps compare correctly as strings since they all share datetime.isoformat().
    """
    cutoff = (datetime.utcnow() - timedelta(hours=BASELINE_TTL_HOURS)).isoformat()
    async with _open_db() as db:
        async with db.execute(
            "SELECT pupil_size, blink_rate, updated_at FROM user_baselines "
            "WHERE user_id = ? AND updated_at > ?",
            (user_id, cutoff),
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def upsert_user_baseline(user_id: str, pupil_size: float, blink_rate: float) -> None:
    """Insert or overwrite the user's baseline (one row per user)."""
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO user_baselines (user_id, pupil_size, blink_rate, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET
                   pupil_size = excluded.pupil_size,
                   blink_rate = excluded.blink_rate,
                   updated_at = excluded.updated_at""",
            (user_id, pupil_size, blink_rate, now, now),
        )
        await db.commit()


async def delete_user_baseline(user_id: str) -> None:
    async with _open_db() as db:
        await db.execute("DELETE FROM user_baselines WHERE user_id = ?", (user_id,))
        await db.commit()


async def delete_session(session_token: str) -> None:
    async with _open_db() as db:
        await db.execute(
            "DELETE FROM user_sessions WHERE session_token = ?", (session_token,)
        )
        await db.commit()


async def get_all_users_with_session_info() -> list[dict]:
    """Return all users with assessment count and most recent survey details.

    session_count is now the number of recorded survey runs (assessments taken),
    and last_active_at / last_session_id reflect the most recent survey run.
    """
    async with _open_db() as db:
        async with db.execute("""
            SELECT
                u.user_id,
                u.name,
                u.created_at,
                COUNT(sr.survey_run_id) AS session_count,
                MAX(sr.updated_at)      AS last_active_at,
                (SELECT session_id FROM survey_records
                 WHERE user_id = u.user_id
                 ORDER BY updated_at DESC LIMIT 1) AS last_session_id
            FROM users u
            LEFT JOIN survey_records sr ON u.user_id = sr.user_id
            GROUP BY u.user_id
            ORDER BY u.name
        """) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]


async def get_manager_overview() -> dict:
    """Aggregate stats for the manager dashboard.

    Returns participant counts, survey completion counts, and risk-level
    distribution derived from the stored technical_report JSON blobs.
    """
    async with _open_db() as db:
        # Guest users are the assessed population; exclude admins/managers.
        async with db.execute(
            "SELECT COUNT(*) AS n FROM users WHERE role = 'guest'"
        ) as cur:
            row = await cur.fetchone()
            total_guests = row["n"] if row else 0

        async with db.execute(
            "SELECT COUNT(DISTINCT user_id) AS n FROM survey_records"
        ) as cur:
            row = await cur.fetchone()
            participants = row["n"] if row else 0

        # Pull all technical_report blobs to tally risk levels.
        async with db.execute(
            "SELECT technical_report, updated_at FROM survey_records "
            "WHERE technical_report IS NOT NULL ORDER BY updated_at DESC"
        ) as cur:
            rows = await cur.fetchall()

        # Eligible staff per department (drives participation denominators).
        async with db.execute(
            "SELECT department AS dept, COUNT(*) AS n FROM users "
            "WHERE department IS NOT NULL AND department != '' GROUP BY department"
        ) as cur:
            dept_eligible = {r["dept"]: r["n"] for r in await cur.fetchall()}

        # Per-department assessments (joined so the dept comes from the user).
        async with db.execute(
            "SELECT u.department AS dept, sr.user_id AS uid, sr.technical_report AS tr "
            "FROM survey_records sr JOIN users u ON u.user_id = sr.user_id "
            "WHERE u.department IS NOT NULL AND u.department != ''"
        ) as cur:
            dept_rows = await cur.fetchall()

    risk_counts: dict[str, int] = {"Low": 0, "Moderate": 0, "High": 0}
    # Every parsed assessment, anonymised (no user_id / name / transcript). Drives
    # both the "Recent Assessments" card and the 3D campus (one building per node).
    nodes: list[dict] = []

    def _norm_risk(raw: str) -> str | None:
        for key in risk_counts:
            if raw.lower() == key.lower():
                return key
        return None

    for r in rows:
        try:
            report = json.loads(r["technical_report"])
        except Exception:
            continue
        raw_risk = report.get("riskLevel") or report.get("risk_level") or ""
        risk = _norm_risk(raw_risk)
        if risk:
            risk_counts[risk] += 1
        nodes.append({
            "updated_at": r["updated_at"],
            "riskLevel": risk or "—",
            "totalScore": report.get("totalScore"),
            "maxScore": report.get("maxScore"),
        })

    # ── Per-department aggregation (each becomes a building in the campus) ──
    dept_acc: dict[str, dict] = {}
    for r in dept_rows:
        d = dept_acc.setdefault(r["dept"], {
            "completed_users": set(), "Low": 0, "Moderate": 0, "High": 0,
            "score_sum": 0.0, "score_n": 0,
        })
        d["completed_users"].add(r["uid"])
        try:
            rep = json.loads(r["tr"]) if r["tr"] else {}
        except Exception:
            rep = {}
        risk = _norm_risk(rep.get("riskLevel") or rep.get("risk_level") or "")
        if risk:
            d[risk] += 1
        score = rep.get("totalScore")
        if isinstance(score, (int, float)):
            d["score_sum"] += score
            d["score_n"] += 1

    departments: list[dict] = []
    for name in sorted(set(list(dept_eligible) + list(dept_acc))):
        a = dept_acc.get(name, {"completed_users": set(), "Low": 0, "Moderate": 0, "High": 0, "score_sum": 0.0, "score_n": 0})
        eligible = dept_eligible.get(name, len(a["completed_users"]))
        completed = len(a["completed_users"])
        rc = {"Low": a["Low"], "Moderate": a["Moderate"], "High": a["High"]}
        assessed = rc["Low"] + rc["Moderate"] + rc["High"]
        # Dominant risk = the largest band; ties break toward the more severe band
        # (iterate ascending severity with >= so a later, more severe band wins).
        dominant, best = "Low", -1
        for band in ("Low", "Moderate", "High"):
            if rc[band] >= best:
                best, dominant = rc[band], band
        departments.append({
            "name": name,
            "eligible": eligible,
            "completed": completed,
            "participationPct": round(completed / eligible * 100) if eligible else 0,
            "riskCounts": rc,
            "atRiskPct": round((rc["Moderate"] + rc["High"]) / assessed * 100) if assessed else 0,
            "dominantRisk": dominant if assessed else "—",
            "avgScore": round(a["score_sum"] / a["score_n"], 1) if a["score_n"] else None,
        })

    return {
        "totalGuests": total_guests,
        "participants": participants,
        "surveysCompleted": len(rows),
        "riskCounts": risk_counts,
        # Most-recent first; card slices the first 10, campus uses up to 24.
        "recentAssessments": nodes[:10],
        "nodes": nodes[:24],
        "departments": departments,
    }


# Dimensions the analytics view can group by / filter on. Maps the public key
# used by the frontend to the users-table column it reads from.
_ANALYTICS_DIMS = {"department": "department", "shift": "shift", "jobTitle": "job_title"}
_RISK_BANDS = ("Low", "Moderate", "High")


def _monday_of(iso: str) -> str | None:
    """Return the ISO date (YYYY-MM-DD) of the Monday starting the week of `iso`."""
    try:
        d = datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None
    monday = d.date() - timedelta(days=d.weekday())
    return monday.isoformat()


async def get_manager_analytics(
    department: str | None = None,
    shift: str | None = None,
    job_title: str | None = None,
    risk: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    group_by: str = "department",
) -> dict:
    """Filterable assessment analytics for the manager dashboard.

    Returns one bar-chart series (counts + risk mix per group of the chosen
    dimension) plus an at-risk%-over-time trend, both honouring every filter.
    All output is aggregate and de-identified — no user_id, name or transcript.
    """
    group_col = _ANALYTICS_DIMS.get(group_by, "department")

    def _norm_risk(raw: str) -> str | None:
        for key in _RISK_BANDS:
            if raw.lower() == key.lower():
                return key
        return None

    async with _open_db() as db:
        # Every assessment joined to its author's attributes. Anonymous beyond
        # the three grouping dimensions; the report blob is parsed in Python.
        async with db.execute(
            "SELECT u.department AS department, u.shift AS shift, u.job_title AS job_title, "
            "       sr.technical_report AS tr, sr.updated_at AS updated_at "
            "FROM survey_records sr JOIN users u ON u.user_id = sr.user_id "
            "WHERE sr.technical_report IS NOT NULL"
        ) as cur:
            rows = await cur.fetchall()

        # Distinct values across all guest staff drive the filter dropdowns, so
        # the options stay stable regardless of the currently applied filters.
        async with db.execute(
            "SELECT DISTINCT department, shift, job_title FROM users WHERE role = 'guest'"
        ) as cur:
            opt_rows = await cur.fetchall()

    filter_options = {"department": set(), "shift": set(), "jobTitle": set()}
    for r in opt_rows:
        if r["department"]:
            filter_options["department"].add(r["department"])
        if r["shift"]:
            filter_options["shift"].add(r["shift"])
        if r["job_title"]:
            filter_options["jobTitle"].add(r["job_title"])

    # ── Apply filters, then accumulate groups + weekly trend ───────────────
    groups: dict[str, dict] = {}
    trend_acc: dict[str, dict] = {}
    total_assessed = 0
    risk_totals = {"Low": 0, "Moderate": 0, "High": 0}

    for r in rows:
        if department and r["department"] != department:
            continue
        if shift and r["shift"] != shift:
            continue
        if job_title and r["job_title"] != job_title:
            continue
        day = (r["updated_at"] or "")[:10]
        if date_from and day and day < date_from:
            continue
        if date_to and day and day > date_to:
            continue
        try:
            report = json.loads(r["tr"]) if r["tr"] else {}
        except Exception:
            report = {}
        band = _norm_risk(report.get("riskLevel") or report.get("risk_level") or "")
        if not band:
            continue
        if risk and band != risk:
            continue

        key = r[group_col] or "Unassigned"
        g = groups.setdefault(key, {"key": key, "Low": 0, "Moderate": 0, "High": 0})
        g[band] += 1
        total_assessed += 1
        risk_totals[band] += 1

        week = _monday_of(r["updated_at"])
        if week:
            t = trend_acc.setdefault(week, {"atRisk": 0, "assessed": 0})
            t["assessed"] += 1
            if band in ("Moderate", "High"):
                t["atRisk"] += 1

    group_list = []
    for g in groups.values():
        total = g["Low"] + g["Moderate"] + g["High"]
        at_risk = g["Moderate"] + g["High"]
        group_list.append({
            "key": g["key"],
            "total": total,
            "riskCounts": {"Low": g["Low"], "Moderate": g["Moderate"], "High": g["High"]},
            "atRiskPct": round(at_risk / total * 100) if total else 0,
        })
    # Most at-risk groups first — the dashboard reads top-down as a priority list.
    group_list.sort(key=lambda x: (-x["atRiskPct"], -x["total"], x["key"]))

    trend = [
        {
            "date": week,
            "assessed": t["assessed"],
            "atRiskPct": round(t["atRisk"] / t["assessed"] * 100) if t["assessed"] else 0,
        }
        for week, t in sorted(trend_acc.items())
    ]

    at_risk_total = risk_totals["Moderate"] + risk_totals["High"]
    return {
        "groupBy": group_by,
        "groups": group_list,
        "trend": trend,
        "riskTotals": risk_totals,
        "totalAssessed": total_assessed,
        "atRiskPct": round(at_risk_total / total_assessed * 100) if total_assessed else 0,
        "filterOptions": {k: sorted(v) for k, v in filter_options.items()},
    }
