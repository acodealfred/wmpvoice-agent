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

from ciq.voice.buffer import VoiceBuffer

logger = logging.getLogger("voicerag")

_SESSION_TTL_SECONDS = 4 * 3600  # sessions expire after 4 hours of inactivity
_MAX_HISTORY_SIZE = 50
# A question's blink window needs at least this much face-visible time to yield its
# own rate; shorter windows fall back to the recent rolling average.
_MIN_QUESTION_BLINK_VALID_MS = 10_000

_VALID_STRESS_STATES = ("stressed", "relaxed", "normal")
_VALID_CONVERSATION_STATES = ("active", "report_delivered", "qa_mode")
_VALID_SURVEY_PHASES = ("baseline", "survey")


@dataclass
class SessionState:
    """All mutable state that belongs to a single user session."""
    session_id: str
    created_at: float = field(default_factory=time.time)
    last_active_at: float = field(default_factory=time.time)
    connection_count: int = 0  # incremented on every WS reconnect

    # ── Assessment run binding (see ciq/assessments/) ──────────────────────────
    # Set by POST /me/assessment/start|continue. While bound, each scored answer
    # and the timeline frames are persisted against this run as they happen, so a
    # paused (or dropped) run survives a reload / redeploy / session eviction.
    # None = legacy flow: nothing is persisted until the report, as before.
    survey_run_id: str | None = None
    user_id: str | None = None
    # Which Start/Continue stretch of the run is live, and where its frame_index
    # numbering starts (max persisted frame_index + 1 on Continue).
    timeline_segment_index: int = 0
    timeline_frame_offset: int = 0

    # ── The user's own words per answer (see ciq.realtime.transcripts) ──────────
    # User conversation items since the current question was asked; the item ->
    # question mapping made when it was scored; its items in speaking order; and
    # the Whisper transcript of each item ("" = transcription failed/empty).
    unassigned_user_items: list = field(default_factory=list)
    answer_items: dict = field(default_factory=dict)
    answer_item_order: dict = field(default_factory=dict)
    item_transcripts: dict = field(default_factory=dict)

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
    # ── Voice acoustics (see ciq.voice) ───────────────────────────────────────
    # The user's survey-phase mic audio (never during agent turns or the
    # baseline), held in memory only. current_pitch_hz/current_intensity_db/
    # current_voiced are refreshed once a second by the timeline sampler;
    # current_voice_features is the latest answer summary (computed on
    # speech_stopped) and is attached to the next recorded answer.
    voice_buffer: VoiceBuffer = field(default_factory=VoiceBuffer, repr=False, compare=False)
    current_pitch_hz: float | None = None
    current_intensity_db: float | None = None
    current_voiced: bool | None = None
    current_voice_features: dict | None = None
    _voice_task: Any = field(default=None, repr=False, compare=False)
    blink_rate_history: list = field(default_factory=list)
    face_emotion_history: list = field(default_factory=list)
    # Cumulative blink-detector totals from the browser (blinks, face-visible ms), the
    # calibrated baseline rate, and the totals at the start of the current question's
    # window — so each question gets the blink rate measured during THAT question
    # rather than a trailing value that mostly reflects the previous one.
    blink_total_count: int = 0
    blink_total_valid_ms: float = 0.0
    blink_baseline_bpm: float | None = None
    blink_question_mark: tuple[int, float] | None = None

    conversation_state: str = "active"  # "active" | "report_delivered" | "qa_mode"
    report_context: str | None = None
    last_agent_response_type: str | None = None
    # PILOT-only: the flattened text of the spoken report the agent was handed by
    # query_survey_results("burnout_score") (see ciq.realtime.spoken_report). Kept so the
    # agent still knows what it said after the post-report reconnect wipes Azure's memory.
    spoken_report_text: str | None = None

    # Pre-survey gate. "baseline" → the eyes-open (3 min) / eyes-closed (3 min, EEG
    # only) calibration is running: the agent stays silent except for the spoken cues
    # the frontend requests via `baseline.cue`, user audio is dropped before it reaches
    # Azure, and the survey questions are NOT available to it;
    # "survey" → the questions are unlocked. Resolved at WS connect from the bound
    # run's own baseline (see RTMiddleTier._resolve_survey_phase): a run that already
    # completed its baseline (resumed after a pause) starts in "survey"; a new run
    # always starts in "baseline".
    survey_phase: str = "baseline"
    is_returning_user: bool = False
    # Which baseline step is running, for the timeline's `stage` column: set from the
    # baseline.cue the frontend sends at each phase boundary (None = before the first
    # cue). Ignored once survey_phase is "survey" (see timeline_stage()).
    baseline_stage: str | None = None

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

    # ── Per-second timeline log (see ciq.realtime.timeline_capture) ─────────────
    # Buffered in memory for the whole survey — nothing hits the DB per-second —
    # and bulk-persisted once at report time, same as survey_results/behaviour
    # snapshots. agent_speaking/user_speaking are flipped live by the Azure
    # realtime turn-taking events (response.created/.done,
    # input_audio_buffer.speech_started/.stopped); current_turn_seq tags each
    # sampled frame with the agent turn it was captured during, so once that
    # turn's transcript is known (response.done) the frames can be retroactively
    # labeled agent_question (transcript matched the next survey question's
    # wording) or agent_other (anything else — greetings, acknowledgments...).
    timeline_frames: list = field(default_factory=list)
    timeline_active: bool = False
    # Bumped every time start_timeline_capture actually (re)starts the sampler —
    # lets a delayed post-survey stop (see timeline_capture.schedule_stop_timeline_capture)
    # detect "a retake already started a NEW sampler on this session_id" and bail
    # out instead of cutting off a survey it has nothing to do with.
    timeline_generation: int = 0
    _timeline_task: Any = field(default=None, repr=False, compare=False)
    _timeline_stop_task: Any = field(default=None, repr=False, compare=False)
    agent_speaking: bool = False
    user_speaking: bool = False
    current_turn_seq: int = 0
    # The question a transcript-matched agent turn just asked — subsequent
    # user_answer/idle frames are tagged with it until record_survey_response
    # scores that question (see handlers.survey_tool).
    pending_answer_question_id: str | None = None
    pending_answer_question_index: int | None = None
    pending_answer_started_at_frame_index: int | None = None

    # ── Recovery Window (see ciq/recovery/, docs/recovery-window.md) ────────────
    # A distinct post-survey flow, not folded into conversation_state/
    # _VALID_CONVERSATION_STATES — a session can be "report_delivered" AND
    # mid-recovery-flow at once (the natural real sequence: report delivered,
    # then the user starts a Recovery Window), so this is its own small state
    # machine, gated independently in ciq.prompts.builder.build_session_instructions.
    recovery_session_id: str | None = None
    recovery_user_id: str | None = None
    # recovery_flow_state: None (no active flow) | "intake" | "track_running" | "reflection".
    recovery_flow_state: str | None = None
    recovery_intake_answers: dict = field(default_factory=dict)
    recovery_selected_track: str | None = None
    recovery_track_step_index: int = 0

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
        """Open the baseline → survey gate. Fired when the baseline protocol completes."""
        self.survey_phase = "survey"
        logger.info("[RTMT] ★ Survey phase unlocked (session=%s)", self.session_id)

    def timeline_stage(self) -> str:
        """The `stage` a timeline frame sampled right now belongs to:
        survey | baseline_eyes_open | baseline_eyes_closed | baseline_setup."""
        if self.survey_phase == "survey":
            return "survey"
        return self.baseline_stage or "baseline_setup"

    def clear_conversation_state(self) -> None:
        self.conversation_state = "active"
        self.report_context = None
        self.spoken_report_text = None
        self.last_agent_response_type = None
        logger.info("[RTMT] ★ Conversation state cleared (reset to active)")

    # ── Recovery Window ────────────────────────────────────────────────────
    def start_recovery_flow(self, recovery_session_id: str, user_id: str) -> None:
        """Called from RTMiddleTier.start_recovery_flow_for_session (itself called
        right after POST /api/recovery-window/start) so the agent picks up the
        intake script on the next session.update."""
        self.recovery_session_id = recovery_session_id
        self.recovery_user_id = user_id
        self.recovery_flow_state = "intake"
        self.recovery_intake_answers = {}
        self.recovery_selected_track = None
        self.recovery_track_step_index = 0
        logger.info("[RTMT] ★ Recovery Window flow started (session=%s, recovery_session=%s)",
                    self.session_id, recovery_session_id)

    def reset_recovery_state(self) -> None:
        """Clear all Recovery Window state — called when a flow ends (safety
        interlock, reflection recorded) and from reset_for_new_survey() so
        retaking a survey never leaves a stale recovery flow active."""
        self.recovery_session_id = None
        self.recovery_user_id = None
        self.recovery_flow_state = None
        self.recovery_intake_answers = {}
        self.recovery_selected_track = None
        self.recovery_track_step_index = 0

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
        self.spoken_report_text = None
        self.last_agent_response_type = None
        self.survey_results.clear()
        self.blink_rate_history.clear()
        self.face_emotion_history.clear()
        self.current_blink_rate_change = 0.0
        self.current_blink_rate_bpm = 0.0
        self.blink_question_mark = None
        self.current_face_emotion = "NEUTRAL"
        self.current_left_gaze_position = "Center"
        self.current_right_gaze_position = "Center"
        self.stress_state = "normal"
        self.connection_count = 0
        # Back to the gated baseline phase; the next WS connect re-resolves it from the
        # bound run's baseline (a resumed run that completed one goes straight to "survey").
        self.survey_phase = "baseline"
        self.is_returning_user = False
        self.baseline_stage = None
        self.pre_behaviour_snapshot = None
        self.post_behaviour_snapshot = None
        self._behaviour_task = None
        self.timeline_frames = []
        self.timeline_active = False
        # NOT reset — must keep increasing across retakes on the same session_id
        # so a stale delayed-stop task from the PREVIOUS survey (see
        # timeline_capture.schedule_stop_timeline_capture) can never collide with
        # the generation number of a sampler started after this reset.
        self._timeline_task = None
        self._timeline_stop_task = None
        self.agent_speaking = False
        self.user_speaking = False
        self.current_turn_seq = 0
        self.pending_answer_question_id = None
        self.pending_answer_question_index = None
        self.pending_answer_started_at_frame_index = None
        self.reset_voice()
        self.reset_recovery_state()
        # Unbound until POST /me/assessment/start|continue binds the next run.
        self.survey_run_id = None
        self.user_id = None
        self.timeline_segment_index = 0
        self.timeline_frame_offset = 0
        self.unassigned_user_items = []
        self.answer_items = {}
        self.answer_item_order = {}
        self.item_transcripts = {}
        logger.info("[RTMT] ★ Session fully reset for new survey (session=%s)", self.session_id)

    # ── biometric history ────────────────────────────────────────────────────
    def update_biometric_history(self, blink_change: float | None, face_emotion: str) -> None:
        """Append new readings to the rolling history buffers.

        ``blink_change`` is None while the browser has too little face-visible time for
        a real rate — skipped rather than recorded as a fake 0%.
        """
        if blink_change is not None:
            self.blink_rate_history.append(blink_change)
        self.face_emotion_history.append(face_emotion)
        if len(self.blink_rate_history) > _MAX_HISTORY_SIZE:
            self.blink_rate_history.pop(0)
        if len(self.face_emotion_history) > _MAX_HISTORY_SIZE:
            self.face_emotion_history.pop(0)

    def reset_voice(self) -> None:
        """Drop all buffered audio and voice readings (new survey, disconnect)."""
        self.voice_buffer.clear()
        self.current_pitch_hz = None
        self.current_intensity_db = None
        self.current_voiced = None
        self.current_voice_features = None
        self._voice_task = None

    def clear_biometric_history(self) -> None:
        self.blink_rate_history.clear()
        self.face_emotion_history.clear()
        self.current_blink_rate_change = 0.0
        self.current_blink_rate_bpm = 0.0
        self.blink_question_mark = None
        self.current_face_emotion = "NEUTRAL"
        self.current_left_gaze_position = "Center"
        self.current_right_gaze_position = "Center"
        logger.info("[RTMT] ★ Biometric history cleared")

    def update_blink_totals(self, blink_count: int, valid_ms: float, baseline_bpm: float | None) -> None:
        """Record the browser's cumulative blink totals and open the first question window.

        The window opens on the first update once the survey phase is on, and re-opens
        if the totals go backwards (the browser restarted analysis and reset them).
        """
        self.blink_total_count = blink_count
        self.blink_total_valid_ms = valid_ms
        if baseline_bpm is not None and baseline_bpm > 0:
            self.blink_baseline_bpm = baseline_bpm
        mark = self.blink_question_mark
        if self.survey_phase == "survey" and (mark is None or blink_count < mark[0] or valid_ms < mark[1]):
            self.blink_question_mark = (blink_count, valid_ms)

    def take_question_blink_change(self) -> float | None:
        """Blink-rate % change vs baseline over the current question's window, then
        start the next question's window. None when the window is too short (or there's
        no baseline) to measure — the caller falls back to the rolling average."""
        mark = self.blink_question_mark
        self.blink_question_mark = (self.blink_total_count, self.blink_total_valid_ms)
        if mark is None or not self.blink_baseline_bpm:
            return None
        valid_ms = self.blink_total_valid_ms - mark[1]
        blinks = self.blink_total_count - mark[0]
        if valid_ms < _MIN_QUESTION_BLINK_VALID_MS or blinks < 0:
            return None
        rate = blinks / valid_ms * 60_000
        change = (rate - self.blink_baseline_bpm) / self.blink_baseline_bpm * 100
        logger.info(
            "[RTMT] ★ question blink window: %d blinks / %.1fs -> %.1f bpm (baseline %.1f) = %.1f%%",
            blinks, valid_ms / 1000, rate, self.blink_baseline_bpm, change,
        )
        return change

    def average_blink_rate_change(self) -> float | None:
        """Average blink rate change over the recent history (real 0% readings included).

        None when there is no reading at all (no baseline, too little face-visible
        time): that is "not enough data", never a genuine 0% — which blink_band would
        otherwise label "Normal".
        """
        valid_changes = list(self.blink_rate_history)
        if not valid_changes:
            logger.warning("[RTMT] ★ average_blink_rate_change: no valid changes, history: %s", self.blink_rate_history[-10:])
            return None
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


@dataclass
class ConnectionState:
    """State tied to ONE realtime WS connection (and its upstream Azure socket).

    Deliberately not on SessionState: a session_id can briefly have two live
    connections (second tab, reconnect overlapping the closing socket), and each
    has its own response cycle. Must never live on the shared RTMiddleTier either,
    or concurrent users clobber each other's pending tool calls.
    """
    tools_pending: dict = field(default_factory=dict)
    response_in_progress: bool = False


# Same propagation model as _active_session: set in _forward_messages before the
# relay tasks are gathered, so both tasks share this connection's object.
_active_connection: contextvars.ContextVar["ConnectionState | None"] = contextvars.ContextVar(
    "active_connection", default=None
)


def set_active_connection(conn: "ConnectionState"):
    return _active_connection.set(conn)


def reset_active_connection(token) -> None:
    _active_connection.reset(token)


def current_connection() -> "ConnectionState":
    conn = _active_connection.get()
    if conn is None:
        raise RuntimeError("No active realtime connection in context")
    return conn


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
