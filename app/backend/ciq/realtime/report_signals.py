"""The "your signals since last time" sentences for the PILOT voice report (report.cue
STEP 4, right after "since your last assessment").

Read-only: the same signal comparison GET /me/reports/{runId}/signal-comparison makes
(ciq.reports.signal_comparison_routes.load_signal_comparison), so what is spoken always
matches the report card, turned into fixed spoken lines. A first check-in, nothing
notable, the feature switched off, or any failure gives [] and the step is skipped
silently — it must never block the report explanation.
"""
import logging

from ciq.realtime.session import SessionState
from ciq.reports.signal_comparison import signal_spoken_lines
from ciq.reports.signal_comparison_routes import load_signal_comparison

logger = logging.getLogger("voicerag")


async def report_signal_lines(sess: SessionState) -> list[str]:
    """Spoken signal lines for the session's bound PILOT run, or [] when there are none."""
    if not sess.user_id or not sess.survey_run_id:
        return []
    if (sess.survey_config.get("type") or "").upper() != "PILOT":
        return []
    try:
        result = await load_signal_comparison(sess.user_id, sess.survey_run_id)
        return signal_spoken_lines(result, sess.survey_config)
    except Exception as e:
        logger.error("[Signals] Spoken signal lines unavailable for run %s: %s", sess.survey_run_id[:8], e)
        return []
