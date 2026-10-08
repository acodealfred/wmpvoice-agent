"""Pitch / loudness / pause measurements with parselmouth (Praat). Pure and
synchronous — callers run these in the voice pool (ciq.voice.executor), never on
the event loop. Every function returns None (or None fields) instead of raising.

Input is the browser's mic stream: mono little-endian PCM16 (24 kHz by default,
see components/audio/recorder.ts).
"""
import logging
import math

import numpy as np
import parselmouth

from ciq.voice.keys import (  # noqa: F401  (re-exported)
    ANSWER_FEATURE_KEYS,
    SAMPLE_RATE,
    WINDOW_FEATURE_KEYS,
)

logger = logging.getLogger("voicerag")

PITCH_FLOOR_HZ = 75.0
PITCH_CEILING_HZ = 500.0
TIME_STEP_S = 0.01
# A silent gap inside an answer at least this long counts as a pause.
MIN_PAUSE_MS = 250
# Below this much audio there is nothing meaningful to measure.
MIN_WINDOW_S = 0.25
# An answer needs at least this much voiced speech to be summarised.
MIN_VOICED_FRAMES = 10


def _sound(pcm16: bytes, sample_rate: int) -> parselmouth.Sound | None:
    samples = np.frombuffer(pcm16[: len(pcm16) - len(pcm16) % 2], dtype="<i2")
    if samples.size < MIN_WINDOW_S * sample_rate:
        return None
    return parselmouth.Sound(samples.astype(np.float64) / 32768.0, sampling_frequency=sample_rate)


def _finite(values: np.ndarray) -> np.ndarray:
    return values[np.isfinite(values)]


def _round(value, digits: int = 1):
    if value is None or not math.isfinite(value):
        return None
    return round(float(value), digits)


def _tracks(sound: parselmouth.Sound) -> tuple[np.ndarray, np.ndarray]:
    """(f0 per 10 ms frame, 0 where unvoiced), (intensity dB values)."""
    pitch = sound.to_pitch(time_step=TIME_STEP_S, pitch_floor=PITCH_FLOOR_HZ, pitch_ceiling=PITCH_CEILING_HZ)
    f0 = pitch.selected_array["frequency"]
    intensity = sound.to_intensity(minimum_pitch=PITCH_FLOOR_HZ, time_step=TIME_STEP_S)
    db = _finite(intensity.values[0])
    return f0, db[db > 0]  # digital silence comes back as huge negatives; drop it


def window_features(pcm16: bytes, sample_rate: int = SAMPLE_RATE) -> dict | None:
    """One second of audio → {pitch_hz, intensity_db, voiced} for the timeline row.

    pitch_hz is the median of the voiced frames (None when nothing voiced);
    voiced is True when at least 20% of the window has a pitch.
    """
    try:
        sound = _sound(pcm16, sample_rate)
        if sound is None:
            return None
        f0, db = _tracks(sound)
        voiced = f0[f0 > 0]
        return {
            "pitch_hz": _round(np.median(voiced)) if voiced.size else None,
            "intensity_db": _round(np.mean(db)) if db.size else None,
            "voiced": bool(f0.size and voiced.size / f0.size >= 0.2),
        }
    except Exception as e:  # never let a Praat failure reach the voice relay
        logger.warning("[Voice] window analysis failed: %r", e)
        return None


def _pauses(voiced_mask: np.ndarray) -> list[float]:
    """Lengths (ms) of unvoiced runs ≥ MIN_PAUSE_MS that sit BETWEEN voiced speech —
    leading / trailing silence is not a pause. Short unvoiced runs (consonants
    like s/f, brief stops) are below the threshold and ignored."""
    idx = np.flatnonzero(voiced_mask)
    if idx.size < 2:
        return []
    inner = voiced_mask[idx[0]: idx[-1] + 1]
    pauses, run = [], 0
    for v in inner:
        if v:
            if run * TIME_STEP_S * 1000 >= MIN_PAUSE_MS:
                pauses.append(run * TIME_STEP_S * 1000)
            run = 0
        else:
            run += 1
    return pauses


def answer_features(pcm16: bytes, sample_rate: int = SAMPLE_RATE) -> dict | None:
    """One answer's audio → the per-answer voice summary stored on the item
    response (column names = keys), or None when there was too little speech."""
    try:
        sound = _sound(pcm16, sample_rate)
        if sound is None:
            return None
        f0, db = _tracks(sound)
        voiced_mask = f0 > 0
        voiced = f0[voiced_mask]
        if voiced.size < MIN_VOICED_FRAMES:
            return None
        pauses = _pauses(voiced_mask)
        idx = np.flatnonzero(voiced_mask)
        span_ms = (idx[-1] - idx[0] + 1) * TIME_STEP_S * 1000
        pause_total = float(sum(pauses))
        return {
            "voice_pitch_mean_hz": _round(np.mean(voiced)),
            "voice_pitch_sd_hz": _round(np.std(voiced)),
            "voice_pitch_min_hz": _round(np.min(voiced)),
            "voice_pitch_max_hz": _round(np.max(voiced)),
            "voice_intensity_mean_db": _round(np.mean(db)) if db.size else None,
            "voice_intensity_sd_db": _round(np.std(db)) if db.size else None,
            "voice_voiced_fraction": _round(voiced.size / f0.size, 3),
            "voice_pause_count": len(pauses),
            "voice_pause_total_ms": _round(pause_total, 0),
            "voice_pause_max_ms": _round(max(pauses), 0) if pauses else 0.0,
            "voice_speech_ms": _round(span_ms - pause_total, 0),
        }
    except Exception as e:
        logger.warning("[Voice] answer analysis failed: %r", e)
        return None

