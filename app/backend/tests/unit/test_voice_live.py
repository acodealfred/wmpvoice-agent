"""ciq.voice.live — what audio is captured, and how per-second / per-answer
readings reach the session (the relay only buffers; analysis is off-loop)."""
import base64

import numpy as np
import pytest

from ciq.realtime.session import SessionState
from ciq.voice.keys import SAMPLE_RATE
from ciq.voice.live import (
    capture_mic_audio,
    finalize_answer_features,
    refresh_window_features,
    schedule_answer_analysis,
)


def _tone_b64(seconds: float, hz: float = 180.0) -> str:
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    x = 0.3 * sum((1 / k) * np.sin(2 * np.pi * k * hz * t) for k in range(1, 6)) / 2.3
    return base64.b64encode((x * 32767).astype("<i2").tobytes()).decode()


@pytest.fixture
def sess(monkeypatch):
    monkeypatch.delenv("ENABLE_VOICE_FEATURES", raising=False)  # default: on
    s = SessionState(session_id="voice-test")
    s.survey_phase = "survey"
    s.timeline_active = True
    return s


def test_captures_user_speech_during_the_survey(sess):
    capture_mic_audio(sess, _tone_b64(0.5))
    assert len(sess.voice_buffer) == SAMPLE_RATE  # 0.5 s of PCM16 = 24000 bytes


@pytest.mark.parametrize("setup", [
    lambda s: setattr(s, "survey_phase", "baseline"),
    lambda s: setattr(s, "agent_speaking", True),
    lambda s: setattr(s, "timeline_active", False),
])
def test_never_captures_baseline_agent_turns_or_idle_sessions(sess, setup):
    setup(sess)
    capture_mic_audio(sess, _tone_b64(0.5))
    assert len(sess.voice_buffer) == 0


def test_flag_off_disables_everything(sess, monkeypatch):
    monkeypatch.setenv("ENABLE_VOICE_FEATURES", "false")
    capture_mic_audio(sess, _tone_b64(0.5))
    assert len(sess.voice_buffer) == 0


def test_bad_audio_payload_never_raises(sess):
    capture_mic_audio(sess, "%%% not base64 %%%")
    capture_mic_audio(sess, None)


async def test_window_reading_then_cleared_when_silent(sess):
    capture_mic_audio(sess, _tone_b64(1.0, 180))
    await refresh_window_features(sess)
    assert sess.current_pitch_hz == pytest.approx(180, abs=3)
    assert sess.current_voiced is True
    await refresh_window_features(sess)  # nothing new buffered this second
    assert (sess.current_pitch_hz, sess.current_intensity_db, sess.current_voiced) == (None, None, None)


async def test_answer_summary_is_attached_once_then_reset(sess):
    capture_mic_audio(sess, _tone_b64(2.0, 200))
    schedule_answer_analysis(sess)
    features = await finalize_answer_features(sess)  # waits for the in-flight analysis
    assert features["voice_pitch_mean_hz"] == pytest.approx(200, abs=3)
    assert len(sess.voice_buffer) == 0               # next answer starts clean
    assert await finalize_answer_features(sess) is None


async def test_reset_voice_on_new_survey_drops_audio(sess):
    capture_mic_audio(sess, _tone_b64(0.5))
    sess.reset_for_new_survey()
    assert len(sess.voice_buffer) == 0 and sess.current_voice_features is None
