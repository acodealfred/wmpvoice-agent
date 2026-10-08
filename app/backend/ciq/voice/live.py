"""Glue between the live /realtime session and the voice analysis.

Everything here runs on the event loop and is cheap: the relay only APPENDS
audio; analysis always goes to the voice pool (ciq.voice.executor). Every entry
point is a no-op when ENABLE_VOICE_FEATURES=false.
"""
import asyncio
import base64
import binascii
import logging

from ciq.config import voice_features_enabled
from ciq.voice.executor import run_voice

logger = logging.getLogger("voicerag")

# How long recording an answer waits for its in-flight analysis before saving
# the answer without voice features (keeps the agent's tool response snappy).
_FINALIZE_TIMEOUT_S = 2.0


def _capturing(sess) -> bool:
    """User speech during the survey only: never the baseline, never while the
    agent is talking (its voice can leak back into the mic)."""
    return (
        voice_features_enabled()
        and sess.survey_phase == "survey"
        and sess.timeline_active
        and not sess.agent_speaking
    )


def capture_mic_audio(sess, audio_b64: str | None) -> None:
    """input_audio_buffer.append → buffer the decoded PCM16. Never raises; the
    message itself is forwarded to Azure unchanged by the caller."""
    if not audio_b64 or not _capturing(sess):
        return
    try:
        sess.voice_buffer.append(base64.b64decode(audio_b64, validate=False))
    except (binascii.Error, ValueError):
        pass


async def refresh_window_features(sess) -> None:
    """Called by the 1 Hz timeline sampler before it snapshots a frame: measure the
    last second of buffered speech (or clear the reading if there was none)."""
    from ciq.voice.features import (
        window_features,  # lazy: keeps parselmouth off the import path
    )

    window = sess.voice_buffer.take_window() if voice_features_enabled() else b""
    result = await run_voice(window_features, window) if window else None
    sess.current_pitch_hz = result["pitch_hz"] if result else None
    sess.current_intensity_db = result["intensity_db"] if result else None
    sess.current_voiced = result["voiced"] if result else None


def schedule_answer_analysis(sess) -> None:
    """speech_stopped → summarise everything the user has said since the last
    recorded answer, in the background."""
    if not voice_features_enabled() or not len(sess.voice_buffer):
        return
    audio = sess.voice_buffer.answer_audio()

    async def _analyse():
        from ciq.voice.features import answer_features

        result = await run_voice(answer_features, audio)
        if result is not None:
            sess.current_voice_features = result

    sess._voice_task = asyncio.create_task(_analyse())


async def finalize_answer_features(sess) -> dict | None:
    """record_survey_response → this answer's voice summary (or None), then reset
    the answer buffer so the next answer starts clean. Waits briefly for an
    analysis still running from the last speech_stopped."""
    task = getattr(sess, "_voice_task", None)
    if task is not None and not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=_FINALIZE_TIMEOUT_S)
        except (TimeoutError, asyncio.CancelledError):
            logger.warning("[Voice] answer analysis still running; saving answer without it")
        except Exception as e:
            logger.warning("[Voice] answer analysis failed: %r", e)
    features = sess.current_voice_features
    sess.current_voice_features = None
    sess._voice_task = None
    sess.voice_buffer.clear_answer()
    return features
