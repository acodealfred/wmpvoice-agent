"""Pure validation rules for the admin Data Validation dashboard.

No I/O here — every function takes the plain values db.get_data_validation_runs
returns, so the rules are unit-testable and the frontend never re-derives them.
See docs/data-validation-dashboard.md §3–§5 for the rules in prose.
"""

import json

from ciq.common.export_names import export_filename

# survey_records.status values (see ciq/assessments/): only "completed" means the
# report was persisted; anything else is a run the user left before the report.
COMPLETED_LIFECYCLE = "completed"

STATUS_COMPLETED = "completed"
STATUS_PARTIAL = "partial"
STATUS_FAILED = "failed"

REPORT_SAVED = "saved"
REPORT_NOT_GENERATED = "not_generated"
REPORT_MISSING = "missing"


def parse_json_column(value):
    """A stored JSON TEXT column → dict, or None when NULL / unparseable / not an object.

    These columns are written by our own code with json.dumps (not raw LLM text), so
    plain json.loads is correct here; a malformed legacy row must not break the page.
    """
    if not value:
        return None
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def is_partial_run(lifecycle_status: str | None) -> bool:
    """Left before the report: closed mid-survey, paused, or still active."""
    return (lifecycle_status or COMPLETED_LIFECYCLE) != COMPLETED_LIFECYCLE


def report_state(lifecycle_status: str | None, technical_report: dict | None) -> str:
    """Saved / Not generated (expected for a partial run) / Missing (a completed run without one)."""
    if technical_report is not None:
        return REPORT_SAVED
    return REPORT_NOT_GENERATED if is_partial_run(lifecycle_status) else REPORT_MISSING


def ai_summary_generated(technical_report: dict | None, prompt_info: dict | None) -> bool:
    """Both on-demand AI texts persisted. Informational only — never affects status."""
    if not technical_report or not prompt_info:
        return False
    return bool(technical_report.get("analysis")) and bool(prompt_info.get("agentResponse"))


def validation_status(
    lifecycle_status: str | None,
    survey_type: str | None,
    technical_report: dict | None,
    has_timeline: bool,
    has_bat4_row: bool,
    has_cbi3_row: bool,
) -> str:
    """COMPLETED / PARTIAL / FAILED for one run (spec §3).

    A partial run is never FAILED — its missing report and scores are expected.
    """
    if is_partial_run(lifecycle_status):
        return STATUS_PARTIAL
    if technical_report is None or not has_timeline:
        return STATUS_FAILED
    if survey_type == "PILOT" and not (has_bat4_row and has_cbi3_row):
        return STATUS_FAILED
    return STATUS_COMPLETED


def risks_deviate(bat_level: str | None, cbi_level: str | None) -> bool:
    """True only when one scale says Low and the other High (Low↔Moderate etc. don't count)."""
    levels = {(bat_level or "").strip().lower(), (cbi_level or "").strip().lower()}
    return levels == {"low", "high"}


def file_manifest(
    survey_run_id: str,
    user_id: str | None,
    has_timeline: bool,
    eeg_segments: list[int],
) -> list[dict]:
    """The per-run files that can be downloaded, with their path inside the export ZIP
    (names from ciq.common.export_names, so they match the single-file downloads).

    kind: timeline | combined | eeg. EEG is one file per segment when the run was
    paused and continued (each segment keeps its own clock), else one session file.
    (The pilot-survey .xlsx is deliberately not offered here — it stays on the Admin
    panel's all-runs Pilot Survey Export.)
    """
    files: list[dict] = []
    if has_timeline:
        files.append({"kind": "timeline", "path": export_filename("timeline", survey_run_id, user_id, in_zip=True)})
    if has_timeline and eeg_segments:
        files.append({"kind": "combined", "path": export_filename("combined", survey_run_id, user_id, in_zip=True)})
    if len(eeg_segments) == 1:
        files.append({"kind": "eeg", "segment": eeg_segments[0], "path": export_filename("eeg", survey_run_id, user_id, in_zip=True)})
    elif len(eeg_segments) > 1:
        for seg in eeg_segments:
            files.append({"kind": "eeg", "segment": seg, "path": export_filename("eeg", survey_run_id, user_id, segment=seg, in_zip=True)})
    return files


def completed_at(row: dict) -> str | None:
    """Spec §4a: completed runs → updated_at; partial runs → closed_at, else paused_at, else updated_at."""
    if is_partial_run(row.get("status")):
        return row.get("closed_at") or row.get("paused_at") or row.get("updated_at")
    return row.get("updated_at")


def build_run_view(row: dict) -> dict:
    """One db.get_data_validation_runs row → the JSON the dashboard renders."""
    technical_report = parse_json_column(row.get("technical_report"))
    prompt_info = parse_json_column(row.get("prompt_info"))
    lifecycle = row.get("status") or COMPLETED_LIFECYCLE
    survey_type = row.get("survey_type")
    has_timeline = bool(row.get("has_timeline"))
    has_bat4 = bool(row.get("has_bat4_row"))
    has_cbi3 = bool(row.get("has_cbi3_row"))
    eeg_segments = list(row.get("eeg_segments") or [])

    status = validation_status(lifecycle, survey_type, technical_report, has_timeline, has_bat4, has_cbi3)
    files = file_manifest(row["survey_run_id"], row.get("user_id"), has_timeline, eeg_segments)

    if survey_type == "PILOT":
        primary = {"label": "BAT-4", "riskLevel": row.get("bat4_risk_level"), "score": row.get("bat4_average"), "scale": "avg / 5"}
        cbi = {"label": "CBI-WRB3", "riskLevel": row.get("cbi3_risk_level"), "score": row.get("cbi3_mean"), "scale": "mean / 100"} if has_cbi3 else None
    else:
        primary = {
            "label": survey_type or "Survey",
            "riskLevel": (technical_report or {}).get("riskLevel"),
            "score": (technical_report or {}).get("totalScore"),
            "scale": "total",
        }
        cbi = None
    scored = primary["riskLevel"] is not None or cbi is not None

    return {
        "surveyRunId": row["survey_run_id"],
        "userId": row.get("user_id"),
        "surveyType": survey_type,
        "lifecycleStatus": lifecycle,
        "createdAt": row.get("created_at"),
        "completedAt": completed_at(row),
        "status": status,
        "report": report_state(lifecycle, technical_report),
        "aiSummaryGenerated": ai_summary_generated(technical_report, prompt_info),
        "scores": {
            "scored": scored,
            "primary": primary,
            "cbi": cbi,
            "riskDeviation": survey_type == "PILOT" and cbi is not None and risks_deviate(primary["riskLevel"], cbi["riskLevel"]),
        },
        "eegSegments": [
            {"index": seg, "start": (row.get("segment_spans") or {}).get(seg, {}).get("start"), "end": (row.get("segment_spans") or {}).get(seg, {}).get("end")}
            for seg in eeg_segments
        ],
        "files": files,
        "fileCount": len(files),
    }
