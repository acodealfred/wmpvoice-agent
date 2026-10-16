"""Ingest the browser's once-a-second ``monitor.tick`` and build the admin's view.

``record_tick`` runs on the realtime relay path, so it is O(1), never awaits and
never raises. Each stored entry is already assessed (``rules``), so reading the
monitor costs nothing but copying ~120 small dicts per session.
"""
import logging
import time
from collections import deque

from ciq.monitoring import rules

logger = logging.getLogger("voicerag")

# Seconds of per-second history kept per session (the admin's strip width).
HISTORY_S = 120
# A tick bigger than this is not ours (ours is ~300-600 bytes) — ignored.
MAX_TICK_BYTES = 8192
# Sessions shown on the monitor: bound to a run and heard from within this window.
LIVE_WINDOW_S = 10 * 60


def new_history() -> deque:
    return deque(maxlen=HISTORY_S)


def _round(value, places=1):
    return round(value, places) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def record_tick(sess, tick: dict, raw_size: int, now: float | None = None) -> None:
    """Assess one tick and append it to the session's history. Never raises."""
    try:
        if raw_size > MAX_TICK_BYTES or not isinstance(tick, dict):
            return
        now = time.time() if now is None else now
        stage = sess.timeline_stage()
        answered = len(sess.survey_results)
        total = len((sess.survey_config or {}).get("questions", []))
        phase = rules.phase_of(stage, sess.conversation_state, answered, total)

        camera = tick.get("camera") if isinstance(tick.get("camera"), dict) else {}
        sess.monitor_no_face_s = sess.monitor_no_face_s + 1 if camera.get("enabled") and camera.get("face") is False else 0
        sess.monitor_no_mic_s = sess.monitor_no_mic_s + 1 if sess.monitor_audio_chunks == 0 else 0
        sess.monitor_audio_chunks = 0

        eeg = tick.get("eeg") if isinstance(tick.get("eeg"), dict) else {}
        # This tick's (samples, real seconds) per channel, averaged with the previous
        # few ticks' — a single tick's count swings 252/264 on packet boundaries.
        seconds = rules.window_seconds(eeg)
        channels = eeg.get("channels") if isinstance(eeg.get("channels"), dict) else {}
        rate_part = {
            ch: (stats["n"], seconds)
            for ch, stats in channels.items()
            if ch in rules.EEG_CHANNELS and isinstance(stats, dict) and isinstance(stats.get("n"), (int, float))
        }
        # Only recent, streaming ticks: zeros from around a drop (or before a pause)
        # must not drag down the rate of a freshly reconnected headband.
        recent = [
            t.get("rate_part", {})
            for t in list(sess.monitor_ticks)[-(rules.RATE_AVG_TICKS - 1):]
            if t["eeg"].get("status") == "streaming" and now - t["t"] <= rules.RATE_AVG_TICKS + 1
        ] if eeg.get("status") == "streaming" else []
        rates = rules.channel_rates([*recent, rate_part])
        eeg_level, ch_levels, eeg_issues = rules.assess_eeg(eeg, rates)
        cam_level, cam_issues = rules.assess_camera(camera, sess.monitor_no_face_s)
        mic_level, mic_issues = rules.assess_mic(phase, sess.monitor_no_mic_s)
        tl_level, tl_issues = rules.assess_timeline(stage, sess.timeline_active)

        if sess.monitor_phase is None or sess.monitor_phase[0] != phase:
            sess.monitor_phase = (phase, now)

        sess.monitor_ticks.append({
            "t": now,
            "phase": phase,
            "answered": answered,
            "total": total,
            "levels": {"eeg": eeg_level, "camera": cam_level, "mic": mic_level, "timeline": tl_level},
            "channels": ch_levels,
            "rate_part": rate_part,
            "issues": eeg_issues + cam_issues + mic_issues + tl_issues,
            "eeg": {
                "status": eeg.get("status"),
                "battery": _round(eeg.get("battery"), 0),
                "rate_hz": _round(eeg.get("rate_hz")),
                # Samples per second, averaged over the last RATE_AVG_TICKS ticks (≈256 when healthy).
                "rates": {ch: round(r) for ch, r in rates.items()},
                "contact": {ch: q for ch, q in (eeg.get("contact") or {}).items() if ch in rules.EEG_CHANNELS},
                "recorder_packets": eeg.get("recorder_packets"),
            },
        })
        sess.monitor_last_tick_at = now
    except Exception as e:  # monitoring must never disturb the assessment
        logger.warning("[Monitor] tick ignored: %s", e)


def is_live(sess, now: float) -> bool:
    """On the monitor: bound to an assessment run and recently heard from."""
    last = sess.monitor_last_tick_at or 0
    return bool(sess.survey_run_id) and (sess.open_ws_count > 0 or now - last < LIVE_WINDOW_S) and bool(sess.monitor_ticks)


def summarize(sess, now: float, user_name: str | None = None, detail: bool = False) -> dict:
    """The admin's view of one session: phase, progress, connection, current health."""
    ticks = list(sess.monitor_ticks)
    latest = ticks[-1] if ticks else None
    conn, conn_issues = rules.connection_state(now, sess.monitor_last_tick_at, sess.open_ws_count)
    levels = dict(latest["levels"]) if latest else {}
    issues = conn_issues + (latest["issues"] if latest and conn == "live" else [])
    if conn != "live":
        # Last known stream health is shown greyed; the connection itself is the problem.
        levels = {k: "off" for k in levels}
    phase, phase_since = sess.monitor_phase or (None, None)
    out = {
        "sessionId": sess.session_id,
        "surveyRunId": sess.survey_run_id,
        "userId": sess.user_id,
        "userName": user_name,
        "surveyType": (sess.survey_config or {}).get("type"),
        "connection": conn,
        "phase": phase,
        "phaseSeconds": round(now - phase_since) if phase_since else None,
        "startedAt": sess.created_at,
        "answered": latest["answered"] if latest else len(sess.survey_results),
        "total": latest["total"] if latest else len((sess.survey_config or {}).get("questions", [])),
        "segmentIndex": sess.timeline_segment_index,
        "lastTickAgoS": round(now - sess.monitor_last_tick_at, 1) if sess.monitor_last_tick_at else None,
        "levels": levels,
        "overall": "bad" if conn != "live" else rules.worst(levels.values()),
        "issues": issues,
        "eeg": latest["eeg"] if latest else None,
    }
    if detail:
        out["history"] = [
            {"t": t["t"], "phase": t["phase"], "levels": t["levels"], "channels": t["channels"], "issues": t["issues"]}
            for t in ticks
        ]
    return out
