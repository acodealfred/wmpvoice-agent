"""Shared Recovery Window logic, callable from BOTH the REST handlers
(ciq/recovery/routes.py) and the realtime voice-tool handlers
(ciq/realtime/tools/recovery_handlers.py) — exactly one code path per concern,
so a user who triggers both a voice flow and a REST fallback can never see
divergent results.
"""
import json
import logging

from ciq.recovery.intake_questions import INTAKE_THEME_BY_ID
from ciq.recovery.router import (
    get_preliminary_recovery_recommendation,
    get_recovery_recommendation,
)
from db import (
    get_survey_item_responses,
    get_survey_record,
    save_recovery_intake_responses,
    update_recovery_session_preliminary,
    update_recovery_session_recommendation,
)
from survey_loader import blink_band, pupil_band

logger = logging.getLogger("voicerag")


def derive_risk_signal(survey_record: dict) -> dict:
    """{cbi_risk_level, overall_risk_level} from a persisted survey run's technical_report.

    PILOT-style sectioned surveys carry an independent CBI-WRB3 subscale
    (`sections[].id == "cbi_wrb3"`); flat surveys have no CBI subscale, so
    their combined `riskLevel` is used as the closest proxy.
    """
    technical_report = json.loads(survey_record["technical_report"] or "{}")
    sections = technical_report.get("sections")
    if sections:
        cbi_section = next((s for s in sections if s.get("id") == "cbi_wrb3"), None)
        return {
            "cbi_risk_level": cbi_section.get("riskLevel") if cbi_section else None,
            "overall_risk_level": None,
        }
    return {"cbi_risk_level": None, "overall_risk_level": technical_report.get("riskLevel")}


def _blink_severity(band: str) -> int:
    if band.startswith("High"):
        return 2
    if band.startswith("Elevated"):
        return 1
    return 0  # "Normal" or "Unknown"


def _pupil_severity(band: str) -> int:
    return {"High": 2, "Medium": 1}.get(band, 0)


async def derive_biometric_signal(survey_run_id: str | None) -> dict:
    """{blink_band, pupil_band} — the most severe band across the run's answered
    questions, reusing survey_loader's existing blink_band()/pupil_band()
    categorizers rather than re-deriving thresholds."""
    if not survey_run_id:
        return {"blink_band": "Unknown", "pupil_band": "Unknown"}
    rows = await get_survey_item_responses(survey_run_id)
    worst_blink, worst_blink_severity = "Unknown", -1
    worst_pupil, worst_pupil_severity = "Unknown", -1
    for row in rows:
        blink = blink_band(row.get("blink_rate_change_percent"))
        pupil = pupil_band(row.get("pupil_mm_change"))
        if _blink_severity(blink) > worst_blink_severity:
            worst_blink_severity, worst_blink = _blink_severity(blink), blink
        if _pupil_severity(pupil) > worst_pupil_severity:
            worst_pupil_severity, worst_pupil = _pupil_severity(pupil), pupil
    return {"blink_band": worst_blink, "pupil_band": worst_pupil}


_NUMERIC_INTAKE_FIELDS = (
    "sleep_hours", "sleep_quality", "mental_drain", "emotional_heaviness", "physical_tension",
)


def _coerce_numeric_intake_fields(intake: dict) -> dict:
    """Intake answers arrive as strings on the wire (voice-tool args and REST
    JSON bodies alike carry `answer_value`/each field as text), but
    ciq.recovery.router does numeric comparisons on the Likert-scale and
    sleep-hours fields — coerce here, once, so the router can stay pure
    number-crunching without needing to know about wire formats."""
    coerced = dict(intake)
    for field in _NUMERIC_INTAKE_FIELDS:
        if field in coerced and coerced[field] is not None:
            try:
                coerced[field] = float(coerced[field]) if field == "sleep_hours" else int(coerced[field])
            except (TypeError, ValueError):
                pass
    return coerced


class ReportNotReadyError(Exception):
    """The survey run behind a recovery session hasn't produced a technical_report yet."""


async def _load_survey_record_for_user(survey_run_id: str | None, user_id: str) -> dict:
    survey_record = await get_survey_record(survey_run_id) if survey_run_id else None
    # Defense in depth: even though the caller already ownership-checked the
    # recovery session, confirm the survey run it references belongs to the
    # same user too.
    if not survey_record or survey_record["user_id"] != user_id:
        raise ReportNotReadyError()
    return survey_record


async def compute_and_persist_preliminary_recommendation(
    recovery_session_id: str, survey_run_id: str | None, user_id: str,
) -> dict:
    """Score+biometrics-only recommendation, computed right after /start, before
    any intake question is asked. Raises ReportNotReadyError if the survey run's
    report hasn't persisted yet — caller decides how to handle that (e.g. skip
    the preliminary narration and go straight to intake)."""
    survey_record = await _load_survey_record_for_user(survey_run_id, user_id)
    risk_signal = derive_risk_signal(survey_record)
    biometric_signal = await derive_biometric_signal(survey_run_id)
    result = get_preliminary_recovery_recommendation(risk_signal, biometric_signal)
    await update_recovery_session_preliminary(recovery_session_id, result["track"], result["rationale"])
    return result


async def persist_intake_answers(recovery_session_id: str, user_id: str, answers: dict) -> None:
    """Persist one or more intake answers, theme-tagged from the canonical question list."""
    rows = [
        (question_id, INTAKE_THEME_BY_ID.get(question_id, "unknown"), str(value))
        for question_id, value in answers.items()
        if question_id in INTAKE_THEME_BY_ID
    ]
    if rows:
        await save_recovery_intake_responses(recovery_session_id, user_id, rows)


async def compute_and_persist_final_recommendation(
    recovery_session_id: str, user_id: str, survey_run_id: str | None, intake_answers: dict,
) -> dict:
    """The FINAL (post-intake) recommendation — safety interlock, then score+biometrics
    +intake. Used by both the voice tool and the REST /recommend fallback."""
    intake_answers = _coerce_numeric_intake_fields(intake_answers)
    result = get_recovery_recommendation(intake_answers, {}, {})
    if result["status"] in ("urgent_support", "grounding_only"):
        # Safety interlock trips before any report lookup is needed.
        return result

    survey_record = await _load_survey_record_for_user(survey_run_id, user_id)
    risk_signal = derive_risk_signal(survey_record)
    biometric_signal = await derive_biometric_signal(survey_run_id)
    # Recompute now that risk/biometric signals are known — the interlock-only
    # call above deliberately used empty signals since it may short-circuit
    # before any report lookup, avoiding an unnecessary DB round-trip.
    result = get_recovery_recommendation(intake_answers, risk_signal, biometric_signal)
    if result["status"] == "recommended":
        await update_recovery_session_recommendation(
            recovery_session_id, result["track"], result["rationale"],
            result["session_length_minutes"], risk_signal, biometric_signal,
        )
    return result
