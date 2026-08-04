"""Per-session state for the realtime middle tier.

``SessionState`` owns its own mutations (stress/conversation state, biometric
history) so state transitions live next to the data instead of being scattered as
``RTMiddleTier`` methods. ``SessionStore`` manages the lifetime of all sessions
(create / TTL eviction). The ``_active_session`` context var carries the current
session across the gather tasks spawned per WebSocket connection.
"""
import contextvars
import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("voicerag")

_SESSION_TTL_SECONDS = 4 * 3600  # sessions expire after 4 hours of inactivity
_MAX_HISTORY_SIZE = 50

_VALID_STRESS_STATES = ("stressed", "relaxed", "normal")
_VALID_CONVERSATION_STATES = ("active", "report_delivered", "qa_mode")
_VALID_SURVEY_PHASES = ("warmup", "survey")


@dataclass
class SessionState:
    """All mutable state that belongs to a single user session."""
    session_id: str
    created_at: float = field(default_factory=time.time)
    last_active_at: float = field(default_factory=time.time)
    connection_count: int = 0  # incremented on every WS reconnect

    survey_results: dict = field(default_factory=dict)
    # Per-session survey binding. Empty/None means "not yet resolved" — the
    # WS handler falls back to the server default (see RTMiddleTier.default_survey_type)
    # the first time it sees an unset session. Deliberately per-session (not a shared
    # attribute on RTMiddleTier) so concurrent sessions/tabs can each run a different
    # survey type without racing or bleeding into one another.
    survey_type: str | None = None
    survey_config: dict = field(default_factory=dict)
    stress_state: str = "normal"
    current_sentiment: str = "neutral"
    current_blink_rate_change: float = 0.0
    # Raw blinks-per-minute reading (as opposed to current_blink_rate_change, which is
    # a % change vs. the session's baseline) — used by the PILOT before/after capture
    # windows in ciq.realtime.behaviour_capture, which need an absolute rate.
    current_blink_rate_bpm: float = 0.0
    current_face_emotion: str = "NEUTRAL"
    # Binocular — each eye tracked independently (see useBiometrics.ts on the frontend).
    current_left_gaze_position: str = "Center"
    current_right_gaze_position: str = "Center"
    current_pupil_mm_change: float = 0.0
    blink_rate_history: list = field(default_factory=list)
    face_emotion_history: list = field(default_factory=list)

    conversation_state: str = "active"  # "active" | "report_delivered" | "qa_mode"
    report_context: str | None = None
    last_agent_response_type: str | None = None

    # Pre-survey gate. "warmup" → the agent makes neutral small talk while the 30s
    # biometric baseline records and the survey questions are NOT available to it;
    # "survey" → the questions are unlocked. Resolved at WS connect from the user's
    # stored baseline (see RTMiddleTier._resolve_survey_phase): a valid (non-expired)
    # baseline means a returning user who skips recording and starts in "survey".
    survey_phase: str = "warmup"
    is_returning_user: bool = False

    # Voice response latency: time between the agent finishing a turn (e.g. asking
    # a survey question) and the user starting to speak their answer.
    last_agent_turn_end_at: float | None = None
    current_response_latency_ms: float | None = None

    # PILOT-only: two 10s biometric capture windows, taken right before the first
    # question and right after the last one (see ciq.realtime.behaviour_capture).
    # `_behaviour_task` just keeps a reference alive so asyncio doesn't GC the
    # running capture task; it is not persisted or read elsewhere.
    pre_behaviour_snapshot: dict | None = None
    post_behaviour_snapshot: dict | None = None
    _behaviour_task: Any = field(default=None, repr=False, compare=False)

    # ── survey binding ────────────────────────────────────────────────────────
    def set_survey_type(self, survey_type: str, config: dict) -> None:
        """Bind this session to a specific survey type/config.

        Resets survey_results whenever the type actually changes so stale
        answered-question IDs from a previous survey type on this same session_id
        (e.g. switching TEST -> PILOT without a full /clear-conversation reset)
        can't leak into reconnect_instructions()'s "X/Y answered" framing or the
        completion count — those are only meaningful within a single survey type.
        """
        if self.survey_type is not None and self.survey_type != survey_type and self.survey_results:
            logger.info(
                "[RTMT] ★ Survey type changed %s -> %s (session=%s) — clearing stale survey_results",
                self.survey_type, survey_type, self.session_id,
            )
            self.survey_results.clear()
        self.survey_type = survey_type
        self.survey_config = config

    # ── stress / conversation state ──────────────────────────────────────────
    def set_stress_state(self, state: str) -> None:
        if state not in _VALID_STRESS_STATES:
            logger.warning(f"Invalid stress state: {state}, defaulting to normal")
            state = "normal"
        self.stress_state = state
        logger.info(f"[RTMT] ★ Stress state set to: {state} (session={self.session_id})")

    def set_conversation_state(self, state: str, report_context: str | None = None) -> None:
        if state not in _VALID_CONVERSATION_STATES:
            logger.warning(f"Invalid conversation state: {state}, defaulting to active")
            state = "active"
        self.conversation_state = state
        if report_context is not None:
            self.report_context = report_context
        logger.info(f"[RTMT] ★ Conversation state set to: {state} (session={self.session_id})")

    def unlock_survey(self) -> None:
        """Open the warm-up → survey gate. Fired when the 30s baseline completes."""
        self.survey_phase = "survey"
        logger.info("[RTMT] ★ Survey phase unlocked (session=%s)", self.session_id)

    def clear_conversation_state(self) -> None:
        self.conversation_state = "active"
        self.report_context = None
        self.last_agent_response_type = None
        logger.info("[RTMT] ★ Conversation state cleared (reset to active)")

    def reset_for_new_survey(self) -> None:
        """Fully reset so a brand-new survey can run on the same session_id.

        Clears conversation state, survey_results (otherwise the
        record_survey_response idempotency guard rejects re-scoring q1..q5) and the
        reconnect counter (otherwise the 'this is a reconnect' instructions keep
        firing). This is what makes retaking a survey deterministic without minting
        a new session_id.
        """
        self.conversation_state = "active"
        self.report_context = None
        self.last_agent_response_type = None
        self.survey_results.clear()
        self.blink_rate_history.clear()
        self.face_emotion_history.clear()
        self.current_blink_rate_change = 0.0
        self.current_blink_rate_bpm = 0.0
        self.current_face_emotion = "NEUTRAL"
        self.current_left_gaze_position = "Center"
        self.current_right_gaze_position = "Center"
        self.stress_state = "normal"
        self.connection_count = 0
        # Back to the gated warm-up phase; the next WS connect re-resolves whether
        # this is a returning user (valid baseline) and may move it straight to "survey".
        self.survey_phase = "warmup"
        self.is_returning_user = False
        self.pre_behaviour_snapshot = None
        self.post_behaviour_snapshot = None
        self._behaviour_task = None
        logger.info("[RTMT] ★ Session fully reset for new survey (session=%s)", self.session_id)

    # ── biometric history ────────────────────────────────────────────────────
    def update_biometric_history(self, blink_change: float, face_emotion: str) -> None:
        """Append new readings to the rolling history buffers."""
        self.blink_rate_history.append(blink_change)
        self.face_emotion_history.append(face_emotion)
        if len(self.blink_rate_history) > _MAX_HISTORY_SIZE:
            self.blink_rate_history.pop(0)
        if len(self.face_emotion_history) > _MAX_HISTORY_SIZE:
            self.face_emotion_history.pop(0)

    def clear_biometric_history(self) -> None:
        self.blink_rate_history.clear()
        self.face_emotion_history.clear()
        self.current_blink_rate_change = 0.0
        self.current_blink_rate_bpm = 0.0
        self.current_face_emotion = "NEUTRAL"
        self.current_left_gaze_position = "Center"
        self.current_right_gaze_position = "Center"
        logger.info("[RTMT] ★ Biometric history cleared")

    def average_blink_rate_change(self) -> float:
        """Average blink rate change from history, excluding zero values."""
        valid_changes = [c for c in self.blink_rate_history if c != 0]
        if not valid_changes:
            logger.warning("[RTMT] ★ average_blink_rate_change: no valid changes, history: %s", self.blink_rate_history[-10:])
            return 0.0
        avg = sum(valid_changes) / len(valid_changes)
        logger.info("[RTMT] ★ average_blink_rate_change: %s%% (from %d valid readings)", avg, len(valid_changes))
        return avg

    def dominant_emotion(self) -> str:
        """Most frequently detected emotion from history."""
        history = self.face_emotion_history
        if not history:
            logger.warning("[RTMT] ★ dominant_emotion: history is empty, returning NEUTRAL")
            return "NEUTRAL"
        valid_emotions = [
            e for e in history
            if e and e not in ("NEUTRAL", "No face detected", "No emotion detected", "UNKNOWN", "multiple_faces_detected")
        ]
        if not valid_emotions:
            logger.warning("[RTMT] ★ dominant_emotion: no valid emotions in history: %s", history[-10:])
            return history[-1] if history else "NEUTRAL"
        emotion_counts: dict = {}
        for emotion in valid_emotions:
            emotion_counts[emotion] = emotion_counts.get(emotion, 0) + 1
        dominant = max(emotion_counts, key=emotion_counts.get)
        logger.info("[RTMT] ★ dominant_emotion: %s (counts: %s)", dominant, emotion_counts)
        return dominant


# Per-coroutine context variable: set in the WS handler before any async work starts.
# asyncio.gather copies the current Context to each task it spawns, so both relay
# tasks inherit this value automatically.
_active_session: contextvars.ContextVar["SessionState | None"] = contextvars.ContextVar(
    "active_session", default=None
)


def set_active_session(sess: "SessionState"):
    return _active_session.set(sess)


def reset_active_session(token) -> None:
    _active_session.reset(token)


def current_session() -> "SessionState":
    sess = _active_session.get()
    if sess is None:
        raise RuntimeError("No active session in context — was session_id set?")
    return sess


class SessionStore:
    """Owns the lifetime of all live sessions."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}

    def get_or_create(self, session_id: str) -> SessionState:
        self._evict_expired()
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionState(session_id=session_id)
            logger.info("[RTMT] New session created: %s", session_id)
        sess = self._sessions[session_id]
        sess.last_active_at = time.time()
        return sess

    def _evict_expired(self) -> None:
        now = time.time()
        expired = [sid for sid, s in self._sessions.items()
                   if now - s.last_active_at > _SESSION_TTL_SECONDS]
        for sid in expired:
            del self._sessions[sid]
            logger.info("[RTMT] Session expired and evicted: %s", sid)
