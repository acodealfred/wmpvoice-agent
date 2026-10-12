"""Admin "Participant reports" export (GET /admin/reports/export) — pure helpers.

One PDF per completed report, PARTICIPANT version: name, date, survey type, each
measure's score / risk level / interpretation, and the AI summary. Internal fields
(user id, run id, per-question answers, biometrics) are deliberately left out —
these files are sent to the participants themselves. The run id only appears in
the filename, for the admin's records. No I/O here; see export_routes.py.
"""
import json
import re
from datetime import datetime, timedelta

PERIODS = ("today", "7", "30", "all")

# Browsers report offsets within UTC-12..UTC+14.
_MAX_OFFSET_MIN = 14 * 60

_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def valid_offset(tz_offset_min: int) -> bool:
    return -_MAX_OFFSET_MIN <= tz_offset_min <= _MAX_OFFSET_MIN


def period_since(period: str, now_utc: datetime, tz_offset_min: int) -> str | None:
    """Naive-UTC ISO lower bound for `period` (the format every updated_at is stored in).

    `tz_offset_min` is the admin's offset EAST of UTC (Sri Lanka: +330), so "today"
    starts at the admin's own local midnight, not UTC midnight. None = no bound ("all").
    """
    if period not in PERIODS:
        raise ValueError(f"period must be one of {', '.join(PERIODS)}")
    if period == "all":
        return None
    if period == "today":
        offset = timedelta(minutes=tz_offset_min)
        local_midnight = (now_utc + offset).replace(hour=0, minute=0, second=0, microsecond=0)
        return (local_midnight - offset).isoformat()
    return (now_utc - timedelta(days=int(period))).isoformat()


def _safe(part: str | None, fallback: str) -> str:
    cleaned = _UNSAFE_NAME.sub("_", part or "").strip("._")
    return cleaned or fallback


def report_filename(user_name: str | None, survey_run_id: str) -> str:
    """`<user_name>_<survey_run_id>.pdf`, filesystem-safe."""
    return f"{_safe(user_name, 'unknown')}_{_safe(survey_run_id, 'run')}.pdf"


def zip_filename(period: str, now_utc: datetime, tz_offset_min: int) -> str:
    local_date = (now_utc + timedelta(minutes=tz_offset_min)).date().isoformat()
    label = "all" if period == "all" else ("today" if period == "today" else f"last{period}days")
    return f"ciq_reports_{label}_{local_date}.zip"


def _json(value) -> dict:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _local_text(iso: str | None, tz_offset_min: int) -> str:
    if not iso:
        return "—"
    try:
        utc = datetime.fromisoformat(iso).replace(tzinfo=None)
    except ValueError:
        return iso
    local = utc + timedelta(minutes=tz_offset_min)
    sign = "+" if tz_offset_min >= 0 else "-"
    hours, minutes = divmod(abs(tz_offset_min), 60)
    return f"{local:%d %b %Y, %H:%M} (UTC{sign}{hours:02d}:{minutes:02d})"


def report_content(record: dict, tz_offset_min: int) -> dict:
    """The participant-facing fields of one get_completed_reports() row."""
    technical = _json(record.get("technical_report"))
    prompt_info = _json(record.get("prompt_info"))
    survey_type = record.get("survey_type") or "Survey"

    results = []
    if isinstance(technical.get("sections"), list):
        for s in technical["sections"]:
            score_range = s.get("scoreRange") or [None, None]
            results.append({
                "label": s.get("label") or s.get("id") or "Score",
                "score": s.get("score"),
                "max": score_range[1] if len(score_range) > 1 else None,
                "riskLevel": s.get("riskLevel"),
                "interpretation": s.get("interpretation") or "",
            })
    elif technical.get("riskLevel") is not None or technical.get("totalScore") is not None:
        results.append({
            "label": survey_type,
            "score": technical.get("totalScore"),
            "max": None,  # a raw total has no stored maximum
            "riskLevel": technical.get("riskLevel"),
            "interpretation": technical.get("interpretation") or "",
        })

    kb = prompt_info.get("ssotReport")
    kb_report = None
    if isinstance(kb, dict) and kb.get("answer"):
        kb_report = {
            "answer": kb["answer"],
            "citations": [c for c in kb.get("citations") or [] if isinstance(c, dict)],
        }

    return {
        "name": record.get("user_name") or "Participant",
        "completed": _local_text(record.get("updated_at"), tz_offset_min),
        "surveyType": survey_type,
        "results": results,
        "summary": (prompt_info.get("agentResponse") or "").strip() or None,
        "kbReport": kb_report,
    }
