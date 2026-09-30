"""User/admin history endpoints (thin wrappers over the db module)."""
import asyncio
import csv
import io
import json

from aiohttp import web
from openpyxl import Workbook
from openpyxl.utils import get_column_letter

from ciq.eeg.combine import EEG_COLUMNS, combine_segments
from db import (
    get_all_users_with_session_info,
    get_eeg_segments,
    get_manager_analytics,
    get_manager_overview,
    get_manager_score_trend,
    get_pilot_survey_export_rows,
    get_survey_record,
    get_survey_timeline_frames,
    get_user_survey_records,
    get_user_survey_run_summaries,
)
from demo_data import clear_demo_data, demo_data_status, seed_demo_data
from survey_loader import compute_survey_summary, effective_score, load_survey

_TIMELINE_EXPORT_HEADERS = [
    "frame_index", "elapsed_seconds", "timestamp", "turn_state",
    "is_question_frame", "is_answer_frame", "question_id", "question_index",
    "blink_rate_bpm", "blink_rate_change_percent", "pupil_mm_change",
    "left_gaze_position", "right_gaze_position", "face_emotion",
    "voice_sentiment", "stress_state",
]

_SURVEY_RESPONSES_HEADERS = [
    "question_index", "question_id", "domain", "question", "user_response",
    "raw_score", "effective_score",
]


def build_survey_summary_rows(record: dict | None) -> list[list]:
    """The SURVEY RESPONSES + SURVEY TOTAL blocks appended below the per-second
    rows of the timeline/combined CSV exports (blank row before each block).

    Built from the run's persisted survey_results (answer text + raw score per
    question) — not from the frames' question_id tags — so every question shows
    up regardless of how the timeline frames were labeled. Totals come from
    survey_loader.compute_survey_summary, the same figures the report uses.
    Returns [] when the run has no survey record yet.
    """
    if not record:
        return []
    try:
        results = json.loads(record.get("survey_results") or "{}")
    except (TypeError, ValueError):
        results = {}

    survey_type = (record.get("survey_type") or "TEST").upper()
    config = load_survey(survey_type)
    qualitative = bool(config.get("qualitative"))

    rows: list[list] = [[], ["SURVEY RESPONSES"], _SURVEY_RESPONSES_HEADERS]
    config_ids = [q.get("id") for q in config.get("questions", [])]
    # Survey order first (unanswered questions included, left blank), then any
    # answered question the current config no longer lists.
    ordered = [*config_ids, *(qid for qid in results if qid not in config_ids)]
    prompts = {q.get("id"): q for q in config.get("questions", [])}
    for idx, qid in enumerate(ordered, start=1):
        q = prompts.get(qid, {})
        r = results.get(qid, {})
        raw = None if qualitative else r.get("score")
        rows.append([
            idx, qid, r.get("domain") or q.get("domain", ""), q.get("prompt", ""),
            r.get("userResponse", ""),
            "" if raw is None else raw,
            "" if raw is None else effective_score(config, qid, raw),
        ])

    rows += [[], ["SURVEY TOTAL"]]
    snapshots = [{"questionId": qid, **r} for qid, r in results.items() if r.get("score") is not None]
    if qualitative:
        rows += [["survey_type", "total_score", "max_score", "risk_level"], [survey_type, "", "", ""]]
    elif config.get("scoringSections"):
        rows.append(["survey_type", "section", "score", "score_range", "risk_level"])
        for s in compute_survey_summary(config, snapshots)["sections"]:
            lo, hi = s["scoreRange"]
            rows.append([survey_type, s["label"], s["score"], f"{lo}-{hi}", s["riskLevel"]])
    else:
        summary = compute_survey_summary(config, snapshots)
        rows += [
            ["survey_type", "total_score", "max_score", "risk_level"],
            [survey_type, summary["totalScore"], summary["maxScore"], summary["riskLevel"]],
        ]
    return rows


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


async def admin_list_user_survey_runs(request: web.Request) -> web.Response:
    """GET /admin/users/{userId}/survey-runs — lightweight run-picker list for the
    survey-timeline export UI (one entry per completed survey run for this user)."""
    user_id = request.match_info.get("userId", "")
    if not user_id:
        return web.json_response({"error": "userId is required"}, status=400)
    runs = await get_user_survey_run_summaries(user_id)
    return web.json_response({"runs": runs})


async def admin_export_survey_timeline(request: web.Request) -> web.Response:
    """GET /admin/survey-timeline/export?survey_run_id=... — per-second timeline as CSV.

    One row per elapsed second of the survey (see ciq.realtime.timeline_capture /
    db.get_survey_timeline_frames): whether the agent was asking a survey
    question, the user was answering it, or neither, plus the live biometric
    snapshot at that second. elapsed_seconds is always == frame_index since
    frames are captured exactly 1s apart by construction.
    """
    survey_run_id = request.query.get("survey_run_id", "")
    if not survey_run_id:
        return web.json_response({"error": "survey_run_id is required"}, status=400)

    frames = await get_survey_timeline_frames(survey_run_id)
    record = await get_survey_record(survey_run_id)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_TIMELINE_EXPORT_HEADERS)
    for f in frames:
        writer.writerow([
            f["frame_index"], f["frame_index"], f["timestamp"], f["turn_state"],
            f["turn_state"] == "agent_question", f["turn_state"] == "user_answer",
            f["question_id"], f["question_index"],
            f["blink_rate_bpm"], f["blink_rate_change_percent"], f["pupil_mm_change"],
            f["left_gaze_position"], f["right_gaze_position"], f["face_emotion"],
            f["voice_sentiment"], f["stress_state"],
        ])
    writer.writerows(build_survey_summary_rows(record))

    return web.Response(
        body=buf.getvalue(),
        headers={"Content-Disposition": f'attachment; filename="survey_timeline_{survey_run_id[:8]}.csv"'},
        content_type="text/csv",
    )


async def admin_export_survey_timeline_combined(request: web.Request) -> web.Response:
    """GET /admin/survey-timeline/export-combined?survey_run_id=... — the same
    per-second timeline as admin_export_survey_timeline above, with per-second
    EEG band power, signal quality, pulse and head-motion columns appended,
    computed on the fly from that run's stored Muse recording (nothing derived is
    persisted). Rows are joined on their own UTC timestamps — see ciq.eeg.combine.
    A paused-and-continued run is combined per segment (ciq.eeg.combine.combine_segments)."""
    survey_run_id = request.query.get("survey_run_id", "")
    if not survey_run_id:
        return web.json_response({"error": "survey_run_id is required"}, status=400)

    segments = await get_eeg_segments(survey_run_id)
    if not segments:
        return web.json_response({"error": "No EEG session recorded for this survey run"}, status=404)

    frames = await get_survey_timeline_frames(survey_run_id)
    segment_files = {s["segment_index"]: s["file_json"] for s in segments}

    # numpy/scipy work — off the event loop so live voice sessions don't stall.
    try:
        eeg_rows, warnings = await asyncio.to_thread(combine_segments, segment_files, frames)
    except (KeyError, TypeError, ValueError, IndexError) as e:
        return web.json_response({"error": f"The stored EEG recording is malformed: {e!r}"}, status=422)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([*_TIMELINE_EXPORT_HEADERS, *EEG_COLUMNS])
    for f, eeg in zip(frames, eeg_rows):
        writer.writerow([
            f["frame_index"], f["frame_index"], f["timestamp"], f["turn_state"],
            f["turn_state"] == "agent_question", f["turn_state"] == "user_answer",
            f["question_id"], f["question_index"],
            f["blink_rate_bpm"], f["blink_rate_change_percent"], f["pupil_mm_change"],
            f["left_gaze_position"], f["right_gaze_position"], f["face_emotion"],
            f["voice_sentiment"], f["stress_state"],
            *(eeg[c] for c in EEG_COLUMNS),
        ])
    writer.writerows(build_survey_summary_rows(await get_survey_record(survey_run_id)))

    headers = {"Content-Disposition": f'attachment; filename="survey_timeline_combined_{survey_run_id[:8]}.csv"'}
    if warnings:
        headers["X-Unified-Warning"] = " | ".join(warnings)
    return web.Response(body=buf.getvalue(), headers=headers, content_type="text/csv")


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
