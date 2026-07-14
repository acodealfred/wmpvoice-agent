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


async def get_user_consent(user_id: str, consent_type: str = "pilot_study") -> dict | None:
    """Return the user's acceptance record for ``consent_type``, if they've ever agreed."""
    async with _open_db() as db:
        async with db.execute(
            "SELECT accepted_at FROM user_consents WHERE user_id = ? AND consent_type = ?",
            (user_id, consent_type),
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None


async def record_user_consent(user_id: str, consent_type: str = "pilot_study") -> None:
    """Record (or refresh) the user's acceptance — one row per (user, consent_type)."""
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO user_consents (user_id, consent_type, accepted_at)
               VALUES (?, ?, ?)
               ON CONFLICT(user_id, consent_type) DO UPDATE SET accepted_at = excluded.accepted_at""",
            (user_id, consent_type, now),
        )
        await db.commit()


async def save_bat4_scores(
    survey_run_id: str,
    user_id: str,
    session_id: str | None,
    responses: dict[str, int | None],
    total_score: int | None,
    average_score: float | None,
    risk_level: str | None,
) -> None:
    """Upsert the BAT-4 subscale row for one pilot-survey run (one row per run)."""
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO pilot_bat4_scores
               (survey_run_id, user_id, session_id,
                response_1, response_2, response_3, response_4,
                total_score, average_score, risk_level, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(survey_run_id) DO UPDATE SET
                   response_1 = excluded.response_1, response_2 = excluded.response_2,
                   response_3 = excluded.response_3, response_4 = excluded.response_4,
                   total_score = excluded.total_score, average_score = excluded.average_score,
                   risk_level = excluded.risk_level""",
            (
                survey_run_id, user_id, session_id,
                responses.get("bat_q1"), responses.get("bat_q2"),
                responses.get("bat_q3"), responses.get("bat_q4"),
                total_score, average_score, risk_level, now,
            ),
        )
        await db.commit()


async def save_cbi3_scores(
    survey_run_id: str,
    user_id: str,
    session_id: str | None,
    item_7: int | None,
    item_11: int | None,
    item_13: int | None,
    item_13_reversed: int | None,
    total_score: int | None,
    mean_score: float | None,
    risk_level: str | None,
) -> None:
    """Upsert the CBI-WRB3 subscale row for one pilot-survey run (one row per run).

    item_7/item_11/item_13/item_13_reversed are raw answers on CBI-WRB3's native
    0/25/50/75/100 scale (see surveys/pilot-survey.json's cbi_wrb3.options).
    total_score is their sum (range 0-300); mean_score is the reportable CBI-WRB3
    score (range 0-100, = total_score / 3), already correctly computed by
    survey_loader.compute_section_scores.
    """
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO pilot_cbi3_scores
               (survey_run_id, user_id, session_id,
                item_7, item_11, item_13, item_13_reversed,
                total_score, mean_score, risk_level, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(survey_run_id) DO UPDATE SET
                   item_7 = excluded.item_7, item_11 = excluded.item_11,
                   item_13 = excluded.item_13, item_13_reversed = excluded.item_13_reversed,
                   total_score = excluded.total_score, mean_score = excluded.mean_score,
                   risk_level = excluded.risk_level""",
            (
                survey_run_id, user_id, session_id,
                item_7, item_11, item_13, item_13_reversed,
                total_score, mean_score, risk_level, now,
            ),
        )
        await db.commit()


async def save_behaviour_snapshot_before(
    survey_run_id: str,
    user_id: str,
    session_id: str | None,
    blink_rate: float | None,
    pupil_dilation: float | None,
) -> None:
    """Upsert the pre-survey 10s biometric capture window for a pilot-survey run."""
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO pilot_behaviour_snapshots
               (survey_run_id, user_id, session_id, blink_rate_before, pupil_dilation_before,
                captured_before_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(survey_run_id) DO UPDATE SET
                   blink_rate_before = excluded.blink_rate_before,
                   pupil_dilation_before = excluded.pupil_dilation_before,
                   captured_before_at = excluded.captured_before_at,
                   updated_at = excluded.updated_at""",
            (
                survey_run_id, user_id, session_id, blink_rate, pupil_dilation,
                now, now, now,
            ),
        )
        await db.commit()


async def save_behaviour_snapshot_after(
    survey_run_id: str,
    user_id: str,
    session_id: str | None,
    blink_rate: float | None,
    pupil_dilation: float | None,
    response_latency_ms: float | None,
) -> None:
    """Upsert the post-survey 10s biometric capture window + overall response latency."""
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO pilot_behaviour_snapshots
               (survey_run_id, user_id, session_id, blink_rate_after, pupil_dilation_after,
                response_latency_ms, captured_after_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(survey_run_id) DO UPDATE SET
                   blink_rate_after = excluded.blink_rate_after,
                   pupil_dilation_after = excluded.pupil_dilation_after,
                   response_latency_ms = excluded.response_latency_ms,
                   captured_after_at = excluded.captured_after_at,
                   updated_at = excluded.updated_at""",
            (
                survey_run_id, user_id, session_id, blink_rate, pupil_dilation,
                response_latency_ms, now, now, now,
            ),
        )
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
        # Active employees are the assessed population (exclude admins/managers
        # and anyone deactivated).
        async with db.execute(
            "SELECT COUNT(*) AS n FROM users WHERE role = 'employee' AND active = 1"
        ) as cur:
            row = await cur.fetchone()
            total_staff = row["n"] if row else 0

        # Eligible active employees per department (participation denominators).
        async with db.execute(
            "SELECT department AS dept, COUNT(*) AS n FROM users "
            "WHERE role = 'employee' AND active = 1 "
            "AND department IS NOT NULL AND department != '' GROUP BY department"
        ) as cur:
            dept_eligible = {r["dept"]: r["n"] for r in await cur.fetchall()}

        # Every scored assessment by an active employee, newest first, joined to
        # the author's department. Drives latest-per-person risk + recent nodes.
        async with db.execute(
            "SELECT sr.user_id AS uid, u.department AS dept, "
            "       sr.technical_report AS tr, sr.updated_at AS updated_at "
            "FROM survey_records sr JOIN users u ON u.user_id = sr.user_id "
            "WHERE sr.technical_report IS NOT NULL AND u.role = 'employee' AND u.active = 1 "
            "ORDER BY sr.updated_at DESC"
        ) as cur:
            rows = await cur.fetchall()

    risk_counts: dict[str, int] = {"Low": 0, "Moderate": 0, "High": 0}
    nodes: list[dict] = []          # recent assessment events (per assessment)
    latest_by_user: dict[str, dict] = {}   # uid -> latest scored {risk, score, dept}

    def _norm_risk(raw: str) -> str | None:
        for key in risk_counts:
            if raw.lower() == key.lower():
                return key
        return None

    for r in rows:
        try:
            report = json.loads(r["tr"])
        except Exception:
            continue
        risk = _norm_risk(report.get("riskLevel") or report.get("risk_level") or "")
        if len(nodes) < 24:
            nodes.append({
                "updated_at": r["updated_at"],
                "riskLevel": risk or "—",
                "totalScore": report.get("totalScore"),
                "maxScore": report.get("maxScore"),
            })
        # First time we see a user (rows are newest-first) is their latest.
        if r["uid"] not in latest_by_user:
            latest_by_user[r["uid"]] = {"risk": risk, "score": report.get("totalScore"), "dept": r["dept"]}

    # Org risk distribution = one vote per person, from their LATEST assessment.
    for v in latest_by_user.values():
        if v["risk"]:
            risk_counts[v["risk"]] += 1

    participants = len(latest_by_user)   # distinct active employees who completed an assessment

    # ── Per-department aggregation (latest-per-person; each is a campus building) ──
    dept_acc: dict[str, dict] = {}
    for uid, v in latest_by_user.items():
        if not v["dept"]:
            continue
        d = dept_acc.setdefault(v["dept"], {
            "completed_users": set(), "Low": 0, "Moderate": 0, "High": 0,
            "score_sum": 0.0, "score_n": 0,
        })
        d["completed_users"].add(uid)
        if v["risk"]:
            d[v["risk"]] += 1
        if isinstance(v["score"], (int, float)):
            d["score_sum"] += v["score"]
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
        "totalGuests": total_staff,          # active employees (kept key for the frontend)
        "participants": participants,
        "surveysCompleted": len(rows),       # total scored assessment runs
        "riskCounts": risk_counts,           # people, by latest assessment
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


def _month_key(iso: str) -> str | None:
    """Return the YYYY-MM month bucket for an ISO timestamp, or None if unparseable."""
    try:
        return datetime.fromisoformat(iso).strftime("%Y-%m")
    except (ValueError, TypeError):
        return None


async def get_manager_score_trend(
    department: str | None = None,
    shift: str | None = None,
    job_title: str | None = None,
    months: int | None = 12,
) -> dict:
    """Organisation-wide average burnout score per calendar month.

    One point per month (the mean of every assessment's numeric `totalScore`),
    honouring the department / shift / job-title filters and a months-back
    window (`months` = None → all time). Aggregate and de-identified — counts
    and means only.
    """
    cutoff = None
    if months:
        first = datetime.now().replace(day=1)
        # Step back `months - 1` whole months so the window includes the current month.
        y, m = first.year, first.month - (months - 1)
        while m <= 0:
            m += 12
            y -= 1
        cutoff = f"{y:04d}-{m:02d}"

    async with _open_db() as db:
        async with db.execute(
            "SELECT u.department AS department, u.shift AS shift, u.job_title AS job_title, "
            "       sr.technical_report AS tr, sr.updated_at AS updated_at "
            "FROM survey_records sr JOIN users u ON u.user_id = sr.user_id "
            "WHERE sr.technical_report IS NOT NULL AND u.role = 'employee'"
        ) as cur:
            rows = await cur.fetchall()
        async with db.execute(
            "SELECT DISTINCT department, shift, job_title FROM users WHERE role = 'employee' AND active = 1"
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

    buckets: dict[str, dict] = {}
    for r in rows:
        if department and r["department"] != department:
            continue
        if shift and r["shift"] != shift:
            continue
        if job_title and r["job_title"] != job_title:
            continue
        month = _month_key(r["updated_at"] or "")
        if not month:
            continue
        if cutoff and month < cutoff:
            continue
        try:
            report = json.loads(r["tr"]) if r["tr"] else {}
        except Exception:
            report = {}
        score = report.get("totalScore")
        if not isinstance(score, (int, float)):
            continue
        b = buckets.setdefault(month, {"sum": 0.0, "n": 0})
        b["sum"] += score
        b["n"] += 1

    points = [
        {"month": month, "avgScore": round(b["sum"] / b["n"], 1), "assessed": b["n"]}
        for month, b in sorted(buckets.items())
    ]
    return {
        "points": points,
        "filterOptions": {k: sorted(v) for k, v in filter_options.items()},
    }


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
        # Every scored assessment by an active employee, joined to their
        # attributes (+ user_id, to reduce to one row per person for the groups).
        async with db.execute(
            "SELECT u.department AS department, u.shift AS shift, u.job_title AS job_title, "
            "       sr.user_id AS uid, sr.technical_report AS tr, sr.updated_at AS updated_at "
            "FROM survey_records sr JOIN users u ON u.user_id = sr.user_id "
            "WHERE sr.technical_report IS NOT NULL AND u.role = 'employee' AND u.active = 1"
        ) as cur:
            rows = await cur.fetchall()

        # Distinct values across active employees drive the filter dropdowns.
        async with db.execute(
            "SELECT DISTINCT department, shift, job_title FROM users "
            "WHERE role = 'employee' AND active = 1"
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

    # ── Apply filters. Groups count PEOPLE (each person's latest assessment);
    #    the weekly trend stays assessment-based (a time series). ────────────
    latest: dict[str, dict] = {}          # uid -> {key, band, updated_at}
    trend_acc: dict[str, dict] = {}

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

        # Weekly trend — every qualifying assessment (time series).
        week = _monday_of(r["updated_at"])
        if week:
            t = trend_acc.setdefault(week, {"atRisk": 0, "assessed": 0})
            t["assessed"] += 1
            if band in ("Moderate", "High"):
                t["atRisk"] += 1

        # Keep only each person's most recent qualifying assessment for the groups.
        uid = r["uid"]
        prev = latest.get(uid)
        upd = r["updated_at"] or ""
        if prev is None or upd > prev["updated_at"]:
            latest[uid] = {"key": r[group_col] or "Unassigned", "band": band, "updated_at": upd}

    # Groups + totals from latest-per-person (one vote each), honouring risk filter.
    groups: dict[str, dict] = {}
    total_assessed = 0
    risk_totals = {"Low": 0, "Moderate": 0, "High": 0}
    for v in latest.values():
        if risk and v["band"] != risk:
            continue
        g = groups.setdefault(v["key"], {"key": v["key"], "Low": 0, "Moderate": 0, "High": 0})
        g[v["band"]] += 1
        total_assessed += 1
        risk_totals[v["band"]] += 1

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


async def get_filter_options() -> dict:
    """Distinct department / shift / job-title values across guest staff.

    Drives the chat tools' enumerated parameters so the model can only filter on
    values that actually exist (and never smuggle a name or free text through)."""
    async with _open_db() as db:
        async with db.execute(
            "SELECT DISTINCT department, shift, job_title FROM users WHERE role = 'employee' AND active = 1"
        ) as cur:
            rows = await cur.fetchall()
    opts = {"department": set(), "shift": set(), "jobTitle": set()}
    for r in rows:
        if r["department"]:
            opts["department"].add(r["department"])
        if r["shift"]:
            opts["shift"].add(r["shift"])
        if r["job_title"]:
            opts["jobTitle"].add(r["job_title"])
    return {k: sorted(v) for k, v in opts.items()}


# ── Manager chat persistence (see docs/manager-chat.md) ────────────────────────

async def create_chat_session(chat_id: str, user_id: str, title: str, scope: str = "manager") -> None:
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO chat_sessions (chat_id, user_id, title, scope, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (chat_id, user_id, title, scope, now, now),
        )
        await db.commit()


async def get_chat_session(chat_id: str) -> dict | None:
    """Return a chat's metadata (incl. user_id + scope, for ownership/scope checks)."""
    async with _open_db() as db:
        async with db.execute(
            "SELECT chat_id, user_id, title, scope, created_at, updated_at FROM chat_sessions WHERE chat_id = ?",
            (chat_id,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def list_chat_sessions(user_id: str, scope: str = "manager") -> list[dict]:
    """A user's chats for one surface (scope), most recently active first."""
    async with _open_db() as db:
        async with db.execute(
            """SELECT chat_id, title, created_at, updated_at
               FROM chat_sessions WHERE user_id = ? AND scope = ? ORDER BY updated_at DESC""",
            (user_id, scope),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_chat_messages(chat_id: str) -> list[dict]:
    """Full message history for a chat, oldest first. Citations are parsed back to lists."""
    async with _open_db() as db:
        async with db.execute(
            """SELECT message_id, role, content, citations, created_at
               FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid""",
            (chat_id,),
        ) as cur:
            rows = await cur.fetchall()
    out = []
    for r in rows:
        m = dict(r)
        if m.get("citations"):
            try:
                m["citations"] = json.loads(m["citations"])
            except Exception:
                m["citations"] = []
        else:
            m["citations"] = []
        out.append(m)
    return out


async def add_chat_message(
    message_id: str,
    chat_id: str,
    role: str,
    content: str,
    citations: list | None = None,
    tool_trace: list | None = None,
) -> None:
    """Append a message and bump the chat's updated_at (single transaction)."""
    now = datetime.utcnow().isoformat()
    async with _open_db() as db:
        await db.execute(
            """INSERT INTO chat_messages
               (message_id, chat_id, role, content, citations, tool_trace, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                message_id, chat_id, role, content,
                json.dumps(citations) if citations else None,
                json.dumps(tool_trace) if tool_trace else None,
                now,
            ),
        )
        await db.execute(
            "UPDATE chat_sessions SET updated_at = ? WHERE chat_id = ?", (now, chat_id)
        )
        await db.commit()


async def delete_chat_session(chat_id: str) -> None:
    async with _open_db() as db:
        await db.execute("DELETE FROM chat_messages WHERE chat_id = ?", (chat_id,))
        await db.execute("DELETE FROM chat_sessions WHERE chat_id = ?", (chat_id,))
        await db.commit()
