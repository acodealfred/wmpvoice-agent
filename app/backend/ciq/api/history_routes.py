"""User/admin history endpoints (thin wrappers over the db module)."""
import asyncio
import csv
import io
import json
import logging

from aiohttp import web
from openpyxl import Workbook
from openpyxl.utils import get_column_letter

from ciq.common.export_names import export_filename
from ciq.eeg.combine import EEG_COLUMNS, combine_segments
from ciq.voice.keys import ANSWER_FEATURE_KEYS, WINDOW_FEATURE_KEYS
from ciq.zone import ZoneConfigError, build_zone_trend
from db import (
    get_all_users_with_session_info,
    get_eeg_segments,
    get_manager_analytics,
    get_manager_overview,
    get_manager_score_trend,
    get_pilot_survey_export_rows,
    get_survey_item_responses,
    get_survey_record,
    get_survey_timeline_frames,
    get_user_survey_records,
    get_user_survey_run_summaries,
)
from demo_data import clear_demo_data, demo_data_status, seed_demo_data
from survey_loader import compute_survey_summary, effective_score, load_survey

logger = logging.getLogger("voicerag")

# user_id / survey_run_id lead every row so CSVs pooled across users stay attributable.
_TIMELINE_EXPORT_HEADERS = [
    "user_id", "survey_run_id",
    "frame_index", "elapsed_seconds", "timestamp", "stage", "segment_index", "turn_state",
    "is_question_frame", "is_answer_frame", "question_id", "question_index",
    "blink_rate_bpm", "blink_rate_change_percent",
    "left_gaze_position", "right_gaze_position", "face_emotion",
    "voice_sentiment", "stress_state",
    # Voice acoustics (ciq.voice) — appended last so existing column positions hold.
    *WINDOW_FEATURE_KEYS,
]


def _timeline_row(f: dict) -> list:
    """One per-second row in _TIMELINE_EXPORT_HEADERS order — shared by the timeline
    and combined exports so their columns can never drift apart. Rows recorded
    before the timeline covered the baseline have no stage: they were survey rows."""
    return [
        f.get("user_id"), f.get("survey_run_id"),
        f["frame_index"], f["frame_index"], f["timestamp"], f.get("stage") or "survey",
        f.get("segment_index") or 0, f["turn_state"],
        f["turn_state"] == "agent_question", f["turn_state"] == "user_answer",
        f["question_id"], f["question_index"],
        f["blink_rate_bpm"], f["blink_rate_change_percent"],
        f["left_gaze_position"], f["right_gaze_position"], f["face_emotion"],
        f["voice_sentiment"], f["stress_state"],
        *(f.get(k) for k in WINDOW_FEATURE_KEYS),
    ]


_SURVEY_RESPONSES_HEADERS = [
    "question_index", "question_id", "domain", "question", "user_response",
    "raw_score", "effective_score",
    # Per-answer voice summary from survey_item_responses (blank = not measured).
    *ANSWER_FEATURE_KEYS,
]

_BASELINE_HEADERS = [
    "survey_run_id", "status", "baseline_blink_rate", "baseline_completed_at", "baseline_segment_index",
]


def _results_from_item_rows(item_rows: list[dict]) -> dict:
    """survey_results-shaped answers rebuilt from survey_item_responses — for a partial
    run (closed / paused before its report), whose survey_results was never written."""
    return {
        r["question_id"]: {"score": r.get("raw_score"), "domain": r.get("domain"),
                           "userResponse": r.get("user_response") or ""}
        for r in item_rows
    }


def build_survey_summary_rows(record: dict | None, item_rows: list[dict] | None = None) -> list[list]:
    """The SURVEY RESPONSES + SURVEY TOTAL + BASELINE blocks appended below the
    per-second rows of the timeline/combined CSV exports (blank row before each block).

    Built from the run's persisted survey_results (answer text + raw score per
    question) — not from the frames' question_id tags — so every question shows
    up regardless of how the timeline frames were labeled. A partial run has no
    survey_results yet, so its answers come from `item_rows` (survey_item_responses)
    instead. Totals come from survey_loader.compute_survey_summary, the same figures
    the report uses. BASELINE ties the run to its own baseline: the segment named
    there is the one whose stage = baseline_* rows / EEG hold it.
    Returns [] when the run has no survey record yet.
    """
    if not record:
        return []
    try:
        results = json.loads(record.get("survey_results") or "{}")
    except (TypeError, ValueError):
        results = {}
    if not results and item_rows:
        results = _results_from_item_rows(item_rows)

    survey_type = (record.get("survey_type") or "TEST").upper()
    config = load_survey(survey_type)
    qualitative = bool(config.get("qualitative"))

    rows: list[list] = [[], ["SURVEY RESPONSES"], _SURVEY_RESPONSES_HEADERS]
    config_ids = [q.get("id") for q in config.get("questions", [])]
    # Survey order first (unanswered questions included, left blank), then any
    # answered question the current config no longer lists.
    ordered = [*config_ids, *(qid for qid in results if qid not in config_ids)]
    prompts = {q.get("id"): q for q in config.get("questions", [])}
    voice_by_qid = {r["question_id"]: r for r in item_rows or []}
    for idx, qid in enumerate(ordered, start=1):
        q = prompts.get(qid, {})
        r = results.get(qid, {})
        raw = None if qualitative else r.get("score")
        voice = voice_by_qid.get(qid, {})
        rows.append([
            idx, qid, r.get("domain") or q.get("domain", ""), q.get("prompt", ""),
            r.get("userResponse", ""),
            "" if raw is None else raw,
            "" if raw is None else effective_score(config, qid, raw),
            *("" if voice.get(k) is None else voice[k] for k in ANSWER_FEATURE_KEYS),
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

    rows += [[], ["BASELINE"], _BASELINE_HEADERS]
    if record.get("baseline_completed_at"):
        rows.append([
            record.get("survey_run_id"), record.get("status"), record.get("baseline_blink_rate"),
            record.get("baseline_completed_at"), record.get("baseline_segment_index"),
        ])
    else:
        rows.append([record.get("survey_run_id"), record.get("status"), "no baseline recorded", "", ""])
    return rows


_PILOT_EXPORT_HEADERS = [
    "Index",
    "Survey Run ID",
    "Status",
    "Baseline Blink Rate",
    "Baseline Completed At",
    "Total BAT-4 Score",
    "Average BAT-4 Score",
    "Total CBI-WRB3 Score",
    "Average CBI-WRB3 Score",
    "Blink Rate Before",
    "Blink Rate After",
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

    One row per survey run (partial runs included, labelled by Status): its id and
    own baseline, BAT-4 total/average, CBI-WRB3 total/average, and the pre/post
    behaviour capture (blink rate) + response latency — pulled straight from
    survey_records / pilot_bat4_scores / pilot_cbi3_scores / pilot_behaviour_snapshots
    (see db.get_pilot_survey_export_rows).
    """
    rows = await get_pilot_survey_export_rows()

    wb = Workbook()
    ws = wb.active
    ws.title = "Pilot Survey"
    ws.append(_PILOT_EXPORT_HEADERS)
    for i, row in enumerate(rows, start=1):
        ws.append([
            i,
            row["survey_run_id"], row["status"],
            row["baseline_blink_rate"], row["baseline_completed_at"],
            row["bat4_total"], row["bat4_average"],
            row["cbi3_total"], row["cbi3_average"],
            row["blink_rate_before"], row["blink_rate_after"],
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
    survey-timeline export UI: every run of this user that recorded data, partial
    (closed / paused / abandoned) ones included, each with its `status`."""
    user_id = request.match_info.get("userId", "")
    if not user_id:
        return web.json_response({"error": "userId is required"}, status=400)
    runs = await get_user_survey_run_summaries(user_id)
    return web.json_response({"runs": runs})


async def run_owner(survey_run_id: str) -> str | None:
    """The run's user_id (for export filenames), or None when the run has no record."""
    record = await get_survey_record(survey_run_id)
    return record.get("user_id") if record else None


async def _summary_rows(survey_run_id: str) -> list[list]:
    """The summary blocks for one run, with the answers fallback for partial runs."""
    return build_survey_summary_rows(
        await get_survey_record(survey_run_id), await get_survey_item_responses(survey_run_id),
    )


async def admin_export_survey_timeline(request: web.Request) -> web.Response:
    """GET /admin/survey-timeline/export?survey_run_id=... — per-second timeline as CSV.

    One row per elapsed second of the whole assessment, Start to end — the
    baseline included, each row tagged with its `stage` (baseline_setup /
    baseline_eyes_open / baseline_eyes_closed / survey) and `segment_index`
    (see ciq.realtime.timeline_capture / db.get_survey_timeline_frames): whether
    the agent was asking a survey question, the user was answering it, or neither,
    plus the live biometric snapshot at that second. elapsed_seconds is always ==
    frame_index since frames are captured exactly 1s apart by construction.
    """
    survey_run_id = request.query.get("survey_run_id", "")
    if not survey_run_id:
        return web.json_response({"error": "survey_run_id is required"}, status=400)

    return web.Response(
        body=await build_timeline_csv(survey_run_id),
        headers={"Content-Disposition": f'attachment; filename="{export_filename("timeline", survey_run_id, await run_owner(survey_run_id))}"'},
        content_type="text/csv",
    )


async def build_timeline_csv(survey_run_id: str) -> str:
    """The per-second timeline CSV body for one run — shared by the timeline export
    and the Data Validation ZIP."""
    frames = await get_survey_timeline_frames(survey_run_id)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_TIMELINE_EXPORT_HEADERS)
    writer.writerows(_timeline_row(f) for f in frames)
    writer.writerows(await _summary_rows(survey_run_id))
    return buf.getvalue()


class MalformedEegError(ValueError):
    """The run's stored EEG recording could not be combined with its timeline."""


async def build_combined_csv(survey_run_id: str) -> tuple[str, list[str]] | None:
    """The combined timeline + EEG CSV body and its alignment warnings for one run,
    or None when the run has no EEG. Raises MalformedEegError for a bad recording.
    Shared by the combined export and the Data Validation ZIP."""
    segments = await get_eeg_segments(survey_run_id)
    if not segments:
        return None

    frames = await get_survey_timeline_frames(survey_run_id)
    segment_files = {s["segment_index"]: s["file_json"] for s in segments}

    # numpy/scipy work — off the event loop so live voice sessions don't stall.
    try:
        eeg_rows, warnings = await asyncio.to_thread(combine_segments, segment_files, frames)
    except (KeyError, TypeError, ValueError, IndexError) as e:
        raise MalformedEegError(f"The stored EEG recording is malformed: {e!r}") from e

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([*_TIMELINE_EXPORT_HEADERS, *EEG_COLUMNS])
    for f, eeg in zip(frames, eeg_rows):
        writer.writerow([*_timeline_row(f), *(eeg[c] for c in EEG_COLUMNS)])
    writer.writerows(await _summary_rows(survey_run_id))
    return buf.getvalue(), warnings


async def admin_export_survey_timeline_combined(request: web.Request) -> web.Response:
    """GET /admin/survey-timeline/export-combined?survey_run_id=... — the same
    per-second timeline as admin_export_survey_timeline above, with per-second
    EEG band power, signal quality, pulse and head-motion columns appended,
    computed on the fly from that run's stored Muse recording (nothing derived is
    persisted). Rows are joined on their own UTC timestamps — see ciq.eeg.combine.
    A paused-and-continued run is combined per segment (ciq.eeg.combine.combine_segments);
    each segment's EEG file runs from that segment's Start, so the baseline rows
    (stage = baseline_*) line up with the baseline part of the same recording."""
    survey_run_id = request.query.get("survey_run_id", "")
    if not survey_run_id:
        return web.json_response({"error": "survey_run_id is required"}, status=400)

    try:
        combined = await build_combined_csv(survey_run_id)
    except MalformedEegError as e:
        return web.json_response({"error": str(e)}, status=422)
    if combined is None:
        return web.json_response({"error": "No EEG session recorded for this survey run"}, status=404)
    body, warnings = combined

    filename = export_filename("combined", survey_run_id, await run_owner(survey_run_id))
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if warnings:
        headers["X-Unified-Warning"] = " | ".join(warnings)
    return web.Response(body=body, headers=headers, content_type="text/csv")


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


async def user_zone_trend(request: web.Request) -> web.Response:
    """GET /api/zone-trend — the logged-in user's Fatigue ↔ Burnout zone + trend.

    Calculated on demand from their completed PILOT runs; nothing is persisted.
    Always the session's own user — never a user id from the request.
    """
    user_id = request["auth_session"]["user_id"]
    records = await get_user_survey_records(user_id)
    try:
        return web.json_response(build_zone_trend(records, load_survey("PILOT")))
    except ZoneConfigError as e:
        logger.error("[Zone] PILOT config unusable: %s", e)
        return web.json_response({"error": "zone unavailable"}, status=500)
