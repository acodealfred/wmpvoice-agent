"""Compare a completed assessment with the user's previous one of the SAME type.

Pure helpers (no I/O), used by the report card (GET /me/reports/{runId}/comparison,
ciq/reports/comparison_routes.py) and the PILOT voice report's "since your last
assessment" step (ciq/realtime/report_comparison.py).

Survey scores only — never biometrics (the biometric guardrail). Every scored
measure here is a burnout measure where a HIGHER score means MORE burnout, so a
lower score is "improved". A change smaller than SAME_FRACTION of the measure's
range counts as "about the same"; a change of risk level is always reported.
Nothing to compare (first assessment, a qualitative survey, no matching measures)
→ None, and callers show / say nothing.
"""
import json
from datetime import datetime

from survey_loader import get_score_bounds

SAME_FRACTION = 0.05

_RISK_WORDS = {"low": "low", "moderate": "moderate", "high": "high"}


def _loads(value) -> dict:
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _parse_date(iso: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(iso) if iso else None
    except ValueError:
        return None


def _scored(record: dict) -> bool:
    tr = _loads(record.get("technical_report"))
    return bool(tr.get("sections")) or tr.get("totalScore") is not None


def previous_same_type_run(records: list[dict], current: dict) -> dict | None:
    """The newest completed run of the same survey type created before `current`.

    `records` are get_user_survey_records() rows (one user's completed runs).
    """
    survey_type = (current.get("survey_type") or "").upper()
    created = current.get("created_at") or ""
    candidates = [
        r for r in records
        if r.get("survey_run_id") != current.get("survey_run_id")
        and (r.get("survey_type") or "").upper() == survey_type
        and (r.get("created_at") or "") < created
        and not r.get("is_demo")
        and _scored(r)
    ]
    return max(candidates, key=lambda r: r.get("created_at") or "", default=None)


def _direction(current: float, previous: float, lo: float, hi: float) -> str:
    if abs(current - previous) < SAME_FRACTION * max(hi - lo, 1e-9):
        return "same"
    return "improved" if current < previous else "worse"


def _measure(label, current, previous, lo, hi, cur_risk, prev_risk, measure_id) -> dict:
    return {
        "id": measure_id,
        "label": label,
        "previousScore": previous,
        "currentScore": current,
        "delta": round(current - previous, 1),
        "scoreRange": [lo, hi],
        "direction": _direction(current, previous, lo, hi),
        "previousRisk": prev_risk,
        "currentRisk": cur_risk,
    }


def compare_runs(current: dict, previous: dict | None, config: dict) -> dict | None:
    """{previousRunId, previousDate, daysBetween, measures: [...]} or None."""
    if not previous or config.get("qualitative"):
        return None
    cur_tr, prev_tr = _loads(current.get("technical_report")), _loads(previous.get("technical_report"))

    measures = []
    if isinstance(cur_tr.get("sections"), list):
        prev_by_id = {s.get("id"): s for s in prev_tr.get("sections") or [] if isinstance(s, dict)}
        for s in cur_tr["sections"]:
            p = prev_by_id.get(s.get("id"))
            if not p or not isinstance(s.get("score"), (int, float)) or not isinstance(p.get("score"), (int, float)):
                continue
            lo, hi = (s.get("scoreRange") or [0, 0])[:2]
            measures.append(_measure(s.get("label") or s.get("id"), s["score"], p["score"], lo, hi,
                                     s.get("riskLevel"), p.get("riskLevel"), s.get("id")))
    elif isinstance(cur_tr.get("totalScore"), (int, float)) and isinstance(prev_tr.get("totalScore"), (int, float)):
        answers = len(_loads(current.get("survey_results")))
        # A total is only comparable when both runs answered the same number of questions.
        if answers and answers == len(_loads(previous.get("survey_results"))):
            lo_opt, hi_opt = get_score_bounds(config)
            measures.append(_measure(config.get("name") or current.get("survey_type") or "Overall",
                                     cur_tr["totalScore"], prev_tr["totalScore"],
                                     answers * lo_opt, answers * hi_opt,
                                     cur_tr.get("riskLevel"), prev_tr.get("riskLevel"), "total"))
    if not measures:
        return None

    cur_date, prev_date = _parse_date(current.get("created_at")), _parse_date(previous.get("created_at"))
    days = (cur_date.date() - prev_date.date()).days if cur_date and prev_date else None
    return {
        "previousRunId": previous.get("survey_run_id"),
        "previousDate": previous.get("created_at"),
        "daysBetween": days,
        "measures": measures,
    }


def _when(days: int | None) -> str:
    """Spoken time since the last assessment, in words (the voice report says no numbers)."""
    if days is None:
        return ""
    if days <= 0:
        return " earlier today"
    if days == 1:
        return " yesterday"
    if days < 7:
        return " a few days ago"
    if days < 14:
        return " about a week ago"
    if days < 28:
        return " a few weeks ago"
    if days < 60:
        return " about a month ago"
    return " a few months ago"


def _risk(level: str | None) -> str | None:
    return _RISK_WORDS.get((level or "").lower())


def comparison_spoken_lines(comparison: dict | None) -> list[str]:
    """Fixed spoken sentences for the PILOT voice report — no numbers. [] when nothing to say."""
    if not comparison:
        return []
    lines = []
    for i, m in enumerate(comparison["measures"]):
        lead = f"Since your last assessment{_when(comparison.get('daysBetween'))}, " if i == 0 else ""
        subject = f"your {m['label']} result" if lead else f"Your {m['label']} result"
        prev_risk, cur_risk = _risk(m.get("previousRisk")), _risk(m.get("currentRisk"))
        risk_move = f", moving from {prev_risk} to {cur_risk}" if prev_risk and cur_risk and prev_risk != cur_risk else ""
        if m["direction"] == "improved":
            body = f"{subject} has improved{risk_move}."
        elif m["direction"] == "worse":
            body = f"{subject} has gone up{risk_move}."
        else:
            body = f"{subject} is about the same as last time{risk_move}."
        lines.append(lead + body if lead else body)
    return lines
