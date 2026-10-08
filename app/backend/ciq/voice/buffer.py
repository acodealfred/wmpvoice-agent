"""Per-session audio buffers for voice analysis. Only touched on the event loop
(appends from the /realtime relay, copies taken before handing work to the voice
pool), so no locking is needed. Raw audio lives only here, in memory, and is
never persisted.
"""
from ciq.voice.keys import SAMPLE_RATE

BYTES_PER_SECOND = SAMPLE_RATE * 2  # mono PCM16
# One answer's audio is capped (oldest dropped) so a long or abandoned answer
# can't grow memory without bound: 120 s ≈ 5.8 MB per session.
MAX_ANSWER_SECONDS = 120


class VoiceBuffer:
    def __init__(self, max_answer_seconds: int = MAX_ANSWER_SECONDS):
        self._window = bytearray()   # rolling last second — the timeline's per-second reading
        self._answer = bytearray()   # everything since the last recorded answer
        self._max_answer = max_answer_seconds * BYTES_PER_SECOND

    def append(self, pcm16: bytes) -> None:
        self._window += pcm16
        if len(self._window) > BYTES_PER_SECOND:
            del self._window[: len(self._window) - BYTES_PER_SECOND]
        self._answer += pcm16
        if len(self._answer) > self._max_answer:
            overflow = len(self._answer) - self._max_answer
            del self._answer[: overflow + overflow % 2]  # keep sample alignment

    def last_window(self) -> bytes:
        """A copy of the last second of audio (b"" when nothing has been heard)."""
        return bytes(self._window)

    def answer_audio(self) -> bytes:
        """A copy of the current answer's audio."""
        return bytes(self._answer)

    def take_window(self) -> bytes:
        """Copy and reset the rolling window, so a silent next second reads as no audio."""
        data = bytes(self._window)
        self._window.clear()
        return data

    def clear_answer(self) -> None:
        self._answer.clear()

    def clear(self) -> None:
        self._window.clear()
        self._answer.clear()

    def __len__(self) -> int:
        return len(self._answer)
