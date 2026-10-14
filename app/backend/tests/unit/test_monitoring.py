"""Admin Live Monitor: validation rules (ciq/monitoring/rules.py) and tick ingest (live.py)."""
from ciq.monitoring import live, rules
from ciq.realtime.session import SessionState

GOOD = {"n": 256, "nan": 0, "min": -40.0, "max": 40.0, "std": 12.0}


def _eeg(**over):
    eeg = {
        "status": "streaming",
        "expected": True,
        "battery": 80,
        "rate_hz": 256,
        "channels": {ch: dict(GOOD) for ch in rules.EEG_CHANNELS},
        "contact": {ch: "good" for ch in rules.EEG_CHANNELS},
        "dropped": 0,
        "recorder_packets": 1000,
        "truncated": False,
    }
    eeg.update(over)
    return eeg


def _tick(eeg=None, face=True):
    return {"type": "monitor.tick", "client_t": 0, "eeg": eeg or _eeg(), "camera": {"enabled": True, "face": face}}


# ── rules ───────────────────────────────────────────────────────────────────
def test_healthy_eeg_is_ok():
    level, channels, issues = rules.assess_eeg(_eeg())
    assert level == "ok" and set(channels.values()) == {"ok"} and issues == []


def test_eeg_not_in_use_is_off_not_a_problem():
    level, channels, issues = rules.assess_eeg(_eeg(status="idle", expected=False))
    assert level == "off" and issues == []


def test_disconnected_headband_is_bad():
    level, channels, issues = rules.assess_eeg(_eeg(status="disconnected"))
    assert level == "bad" and channels["AF7"] == "bad"
    assert issues == ["EEG headband disconnected"]


def test_channel_rules():
    assert rules.assess_channel("TP9", {"n": 0}, "good") == ("bad", ["TP9: no samples"])
    assert rules.assess_channel("TP9", {**GOOD, "n": 200}, "good")[0] == "warn"
    assert rules.assess_channel("TP9", {**GOOD, "n": 100}, "good")[0] == "bad"
    assert rules.assess_channel("AF7", {**GOOD, "nan": 3}, "good") == ("bad", ["AF7: 3 NaN values"])
    assert rules.assess_channel("AF7", {**GOOD, "std": 0.0}, "good") == ("bad", ["AF7: flat signal"])
    level, issues = rules.assess_channel("AF8", {**GOOD, "min": -300.0, "max": 300.0}, "good")
    assert level == "warn" and "very large swings" in issues[0]
    assert rules.assess_channel("TP10", GOOD, "floating") == ("bad", ["TP10: poor contact"])
    assert rules.assess_channel("TP10", GOOD, "marginal") == ("warn", ["TP10: weak contact"])


def test_recording_cap_lost_packets_and_battery():
    assert rules.assess_eeg(_eeg(truncated=True))[0] == "bad"
    assert rules.assess_eeg(_eeg(dropped=3))[0] == "warn"
    assert rules.assess_eeg(_eeg(dropped=50))[0] == "bad"
    level, _, issues = rules.assess_eeg(_eeg(battery=7))
    assert level == "warn" and issues == ["Headband battery low (7%)"]


def test_malformed_input_never_raises():
    assert rules.assess_eeg(None)[0] == "off"
    level, _, _ = rules.assess_eeg({"status": "streaming", "channels": "nope", "contact": None})
    assert level == "bad"  # every channel: no samples


def test_camera_mic_timeline_and_phase():
    assert rules.assess_camera({"enabled": False}, 99) == ("off", [])
    assert rules.assess_camera({"enabled": True}, 4)[0] == "ok"
    assert rules.assess_camera({"enabled": True}, 5)[0] == "warn"
    assert rules.assess_camera({"enabled": True}, 30)[0] == "bad"
    assert rules.assess_mic("survey", 60)[0] == "warn"
    assert rules.assess_mic("report", 600) == ("off", [])
    assert rules.assess_timeline("survey", False)[0] == "bad"
    assert rules.assess_timeline("baseline_eyes_open", True)[0] == "ok"
    assert rules.phase_of("survey", "active", 3, 22) == "survey"
    assert rules.phase_of("survey", "active", 22, 22) == "report"
    assert rules.phase_of("baseline_eyes_closed", "active", 0, 22) == "baseline_eyes_closed"


def test_connection_state():
    assert rules.connection_state(100.0, 99.0, 1)[0] == "live"
    assert rules.connection_state(100.0, 90.0, 1)[0] == "stale"
    assert rules.connection_state(100.0, None, 1)[0] == "stale"
    assert rules.connection_state(100.0, 99.5, 0)[0] == "offline"


# ── ingest + summary ─────────────────────────────────────────────────────────
def _session():
    sess = SessionState(session_id="s1")
    sess.survey_run_id = "run-1"
    sess.user_id = "u1"
    sess.survey_config = {"type": "PILOT", "questions": [{}] * 22}
    sess.open_ws_count = 1
    return sess


def test_record_tick_assesses_and_keeps_bounded_history():
    sess = _session()
    for i in range(live.HISTORY_S + 5):
        sess.monitor_audio_chunks = 50
        live.record_tick(sess, _tick(), 400, now=1000.0 + i)
    assert len(sess.monitor_ticks) == live.HISTORY_S
    assert sess.monitor_ticks[-1]["levels"] == {"eeg": "ok", "camera": "ok", "mic": "ok", "timeline": "off"}
    assert sess.monitor_last_tick_at == 1000.0 + live.HISTORY_S + 4


def test_no_face_and_no_mic_streaks_accumulate_and_reset():
    sess = _session()
    for i in range(6):
        live.record_tick(sess, _tick(face=False), 400, now=1000.0 + i)
    assert sess.monitor_no_face_s == 6
    assert sess.monitor_ticks[-1]["levels"]["camera"] == "warn"
    live.record_tick(sess, _tick(face=True), 400, now=1007.0)
    assert sess.monitor_no_face_s == 0
    assert sess.monitor_no_mic_s == 7  # no audio chunks were counted at all


def test_oversized_or_broken_ticks_are_ignored():
    sess = _session()
    live.record_tick(sess, _tick(), live.MAX_TICK_BYTES + 1, now=1.0)
    live.record_tick(sess, "not a dict", 10, now=2.0)
    assert len(sess.monitor_ticks) == 0


def test_summary_phase_progress_and_stale_connection():
    sess = _session()
    sess.baseline_stage = "baseline_eyes_open"
    live.record_tick(sess, _tick(), 400, now=1000.0)
    view = live.summarize(sess, 1001.0, "Ann")
    assert (view["userName"], view["phase"], view["connection"], view["total"]) == ("Ann", "baseline_eyes_open", "live", 22)
    assert view["overall"] in ("ok", "warn")

    stale = live.summarize(sess, 1010.0)
    assert stale["connection"] == "stale" and stale["overall"] == "bad"
    assert stale["issues"][0].startswith("Browser stopped reporting")

    detail = live.summarize(sess, 1001.0, detail=True)
    assert len(detail["history"]) == 1 and detail["history"][0]["channels"]["AF7"] == "ok"


def test_only_bound_recent_sessions_are_live():
    sess = _session()
    assert not live.is_live(sess, 1000.0)  # no ticks yet
    live.record_tick(sess, _tick(), 400, now=1000.0)
    assert live.is_live(sess, 1001.0)
    sess.open_ws_count = 0
    assert live.is_live(sess, 1000.0 + live.LIVE_WINDOW_S - 1)
    assert not live.is_live(sess, 1000.0 + live.LIVE_WINDOW_S + 1)
    sess.survey_run_id = None
    assert not live.is_live(sess, 1001.0)


def test_new_survey_clears_the_monitor_history():
    sess = _session()
    live.record_tick(sess, _tick(), 400, now=1000.0)
    sess.reset_for_new_survey()
    assert len(sess.monitor_ticks) == 0 and sess.monitor_phase is None
