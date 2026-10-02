"""The Fatigue ↔ Burnout zone sentences for the PILOT voice report (report.cue STEP 2).

Read-only: the same calculation GET /api/zone-trend makes (ciq.zone.build_zone_trend over
the user's completed runs), turned into fixed spoken lines (ciq.zone.zone_spoken_lines).
The zone is spoken only when its newest scored run IS the run being explained, and any
failure just leaves STEP 2 out — it must never block the report explanation.
"""
import logging

from ciq.realtime.session import SessionState
from ciq.zone import build_zone_trend, zone_spoken_lines
from db import get_user_survey_records
from survey_loader import load_survey

logger = logging.getLogger("voicerag")


async def report_zone_lines(sess: SessionState) -> list[str]:
    """Spoken zone lines for the session's bound run, or [] when there are none."""
    if not sess.user_id or not sess.survey_run_id:
        return []
    try:
        records = await get_user_survey_records(sess.user_id)
        zone = build_zone_trend(records, load_survey("PILOT"))
    except Exception as e:
        logger.error("[Zone] Spoken zone unavailable for run %s: %s", sess.survey_run_id[:8], e)
        return []
    latest = zone.get("latest")
    if not latest or latest.get("surveyRunId") != sess.survey_run_id:
        logger.info("[Zone] Run %s has no zone (incomplete answers?) — STEP 2 skipped", sess.survey_run_id[:8])
        return []
    return zone_spoken_lines(latest, zone["trend"])
