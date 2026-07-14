"""PILOT-only behavioural biometric capture: two 10s sampling windows per survey run.

One window fires right before the first question is asked ("pre"), one right after
the last question is answered ("post"). Both sample `SessionState`'s already-live
biometric fields (kept current by the frontend's continuous ``POST /biometrics``
pushes) rather than requiring any new frontend capture UI.
"""
import asyncio
import logging
from datetime import datetime

from ciq.realtime.session import SessionState

logger = logging.getLogger("voicerag")

_SAMPLE_INTERVAL_S = 0.5


async def capture_behaviour_window(sess: SessionState, phase: str, duration_s: float = 10.0) -> None:
    """Sample blink/pupil state for `duration_s` seconds and store the average on `sess`."""
    blink_samples: list[float] = []
    pupil_samples: list[float] = []
    elapsed = 0.0
    while elapsed < duration_s:
        blink_samples.append(sess.current_blink_rate_bpm)
        pupil_samples.append(sess.current_pupil_mm_change)
        await asyncio.sleep(_SAMPLE_INTERVAL_S)
        elapsed += _SAMPLE_INTERVAL_S

    response_latency_ms = None
    if phase == "post":
        latencies = [
            r["response_latency_ms"] for r in sess.survey_results.values()
            if r.get("response_latency_ms") is not None
        ]
        if latencies:
            response_latency_ms = sum(latencies) / len(latencies)

    snapshot = {
        "blink_rate": sum(blink_samples) / len(blink_samples) if blink_samples else None,
        "pupil_dilation": sum(pupil_samples) / len(pupil_samples) if pupil_samples else None,
        "response_latency_ms": response_latency_ms,
        "captured_at": datetime.utcnow().isoformat(),
    }
    if phase == "pre":
        sess.pre_behaviour_snapshot = snapshot
    else:
        sess.post_behaviour_snapshot = snapshot
    logger.info(
        "[RTMT] ★ Behaviour capture complete phase=%s session=%s snapshot=%s",
        phase, sess.session_id, snapshot,
    )


def start_behaviour_capture(sess: SessionState, phase: str, duration_s: float = 10.0) -> None:
    """Fire-and-forget a capture window, keeping a reference so it isn't GC'd early."""
    sess._behaviour_task = asyncio.create_task(capture_behaviour_window(sess, phase, duration_s))
