"""The "since your last assessment" sentences for the PILOT voice report (report.cue
STEP 3, right after the Fatigue ↔ Burnout zone).

Read-only: the same comparison GET /me/reports/{runId}/comparison makes
(ciq.reports.comparison) between the session's bound run and the user's previous
PILOT run, turned into fixed spoken lines. A first assessment, or any failure, gives
[] and the step is skipped silently — it must never block the report explanation.
"""
import logging

from ciq.realtime.session import SessionState
from ciq.reports.comparison import (
    compare_runs,
    comparison_spoken_lines,
    previous_same_type_run,
)
from db import get_user_survey_records

logger = logging.getLogger("voicerag")


async def report_comparison_lines(sess: SessionState) -> list[str]:
    """Spoken comparison lines for the session's bound PILOT run, or [] when there are none."""
    if not sess.user_id or not sess.survey_run_id:
        return []
    if (sess.survey_config.get("type") or "").upper() != "PILOT":
        return []
    try:
        records = await get_user_survey_records(sess.user_id)
        current = next((r for r in records if r.get("survey_run_id") == sess.survey_run_id), None)
        if current is None:
            return []
        comparison = compare_runs(current, previous_same_type_run(records, current), sess.survey_config)
    except Exception as e:
        logger.error("[Compare] Spoken comparison unavailable for run %s: %s", sess.survey_run_id[:8], e)
        return []
    return comparison_spoken_lines(comparison)
