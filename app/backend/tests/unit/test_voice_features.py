"""ciq.voice — pitch / loudness / pause measurements and the per-session buffer."""
import numpy as np
import pytest

from ciq.voice.buffer import BYTES_PER_SECOND, VoiceBuffer
from ciq.voice.features import (
    ANSWER_FEATURE_KEYS,
    SAMPLE_RATE,
    answer_features,
    window_features,
)

SR = SAMPLE_RATE


def _tone(seconds: float, hz: float = 180.0, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    # a few harmonics so Praat sees a voice-like periodic signal
    return amp * sum((1 / k) * np.sin(2 * np.pi * k * hz * t) for k in range(1, 6)) / 2.3


def _silence(seconds: float) -> np.ndarray:
    return np.zeros(int(SR * seconds))


def _pcm(x: np.ndarray) -> bytes:
    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


# ── window_features (per second) ──────────────────────────────────────────

def test_window_measures_pitch_of_a_tone():
    w = window_features(_pcm(_tone(1.0, 180)))
    assert w["voiced"] is True
    assert w["pitch_hz"] == pytest.approx(180, abs=3)
    assert w["intensity_db"] is not None


def test_window_silence_is_unvoiced_with_no_pitch():
    w = window_features(_pcm(_silence(1.0)))
    assert w == {"pitch_hz": None, "intensity_db": None, "voiced": False}


def test_window_louder_reads_higher_intensity():
    quiet = window_features(_pcm(_tone(1.0, amp=0.05)))["intensity_db"]
    loud = window_features(_pcm(_tone(1.0, amp=0.5)))["intensity_db"]
    assert loud > quiet + 10


def test_window_too_short_or_garbage_returns_none():
    assert window_features(b"") is None
    assert window_features(_pcm(_tone(0.1))) is None
    assert window_features(b"\x01") is None  # odd byte count: no crash


# ── answer_features (per answer) ──────────────────────────────────────────

def test_answer_summary_pitch_and_no_pauses_for_continuous_speech():
    a = answer_features(_pcm(_tone(2.0, 200)))
    assert set(a) == set(ANSWER_FEATURE_KEYS)
    assert a["voice_pitch_mean_hz"] == pytest.approx(200, abs=3)
    assert a["voice_pitch_sd_hz"] < 5
    assert a["voice_pause_count"] == 0
    assert a["voice_pause_total_ms"] == 0
    assert a["voice_speech_ms"] == pytest.approx(2000, abs=120)


def test_answer_counts_a_pause_between_speech():
    audio = np.concatenate([_tone(1.0), _silence(0.6), _tone(1.0)])
    a = answer_features(_pcm(audio))
    assert a["voice_pause_count"] == 1
    assert a["voice_pause_total_ms"] == pytest.approx(600, abs=80)
    assert a["voice_pause_max_ms"] == a["voice_pause_total_ms"]
    assert a["voice_speech_ms"] == pytest.approx(2000, abs=150)


def test_short_gaps_and_edge_silence_are_not_pauses():
    # 100 ms gap (< 250 ms) inside, plus silence before and after the speech
    audio = np.concatenate([_silence(0.5), _tone(1.0), _silence(0.1), _tone(1.0), _silence(0.8)])
    a = answer_features(_pcm(audio))
    assert a["voice_pause_count"] == 0
    assert a["voice_voiced_fraction"] < 0.8  # the edge silence still lowers the voiced share


def test_answer_with_no_speech_returns_none():
    assert answer_features(_pcm(_silence(3.0))) is None
    assert answer_features(b"") is None


# ── VoiceBuffer ───────────────────────────────────────────────────────────

def test_buffer_keeps_only_the_last_second_in_the_window():
    buf = VoiceBuffer()
    buf.append(b"\x00\x00" * SR)            # 1 s
    buf.append(b"\x01\x00" * (SR // 2))     # 0.5 s more
    window = buf.last_window()
    assert len(window) == BYTES_PER_SECOND
    assert window.endswith(b"\x01\x00" * (SR // 2))
    assert len(buf.take_window()) == BYTES_PER_SECOND
    assert buf.last_window() == b""          # taken → next second starts empty


def test_buffer_caps_the_answer_and_drops_oldest_audio():
    buf = VoiceBuffer(max_answer_seconds=2)
    buf.append(b"\x00\x00" * SR * 2)
    buf.append(b"\x02\x00" * SR)              # 1 s over the cap
    audio = buf.answer_audio()
    assert len(audio) == 2 * BYTES_PER_SECOND
    assert audio.endswith(b"\x02\x00" * SR)   # newest kept
    assert len(audio) % 2 == 0


def test_buffer_clear_answer_and_clear():
    buf = VoiceBuffer()
    buf.append(b"\x00\x00" * 100)
    buf.clear_answer()
    assert len(buf) == 0 and buf.last_window()
    buf.clear()
    assert buf.last_window() == b""
