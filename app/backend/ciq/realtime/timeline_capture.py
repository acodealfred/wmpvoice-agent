"""Per-second survey timeline log: turn-state + biometrics, one row per elapsed second.

Runs as a 1Hz background task per session for the duration of the survey,
buffering frames in memory on ``SessionState.timeline_frames`` (nothing hits the
DB per-second — see ``db.save_survey_timeline_frames``, called once at report
time). Each frame records whether the agent was speaking, the user was
speaking, or neither, plus the live biometric snapshot at that moment.

Turn-state resolution is necessarily retroactive within one agent turn: Azure's
realtime API only reveals what the agent actually said (the transcript) when
that turn finishes (``response.done``), so frames sampled while a turn is still
in progress are stamped with a placeholder and tagged with the turn's sequence
number (``SessionState.current_turn_seq``). The moment the turn ends,
``resolve_agent_turn`` fuzzy-matches the transcript against the next unanswered
survey question's literal wording (``survey_config["questions"][i]["prompt"]``
— the exact text the agent's script instructs it to read, see
``ciq.prompts.builder.survey_instructions``) and patches those buffered frames
in place: a match means the turn really was the agent asking that question
(``agent_question``); no match means it was something else — a greeting,
acknowledgment, transition — and the frames are tagged ``agent_other``, which
is what keeps intro small talk out of the question/answer counts.
"""
import asyncio
import difflib
import logging
import re
from datetime import UTC, datetime

from ciq.realtime.session import SessionState

logger = logging.getLogger("voicerag")

_SAMPLE_INTERVAL_S = 1.0

# Match threshold for "this transcript is the agent reading this survey question".
# A plain whole-string ratio is too fragile: survey_instructions() has the agent
# bundle extra boilerplate into the SAME turn as Step 1 (the response-scale
# explanation) and as the first step of any new item style/section (the
# transition line, e.g. BAT-4 -> CBI-WRB3) — that preamble can be longer than
# the actual question, which dilutes a whole-string ratio far enough to miss a
# real match. _similarity() instead takes the max of that ratio and "content-word
# coverage" (what fraction of the QUESTION's own distinctive words appear
# anywhere in the transcript) — coverage isn't penalized by extra preamble text
# since its denominator is only the question's word count, so it stays ~1.0
# for a real match regardless of how much scale/transition text surrounds it.
_MATCH_THRESHOLD = 0.6

# Generic English stopwords only (not tied to this app's specific instruction
# wording, which can change) — filtered out of the QUESTION side before
# computing coverage so short function words don't inflate/deflate the ratio
# for very short prompts.
_STOPWORDS = {
    "a", "an", "the", "i", "you", "your", "my", "me", "do", "does", "did", "is",
    "are", "was", "were", "am", "at", "in", "on", "to", "of", "and", "or", "so",
    "that", "this", "it", "have", "has", "had", "about", "how", "can", "will",
    "would", "for", "with", "if", "be", "been", "being",
}


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9\s]", "", text.lower()).strip()


def _content_words(text: str) -> set[str]:
    return {w for w in _normalize(text).split() if w and w not in _STOPWORDS}


def _similarity(transcript: str, prompt: str) -> float:
    if not transcript or not prompt:
        return 0.0
    seq_ratio = difflib.SequenceMatcher(None, _normalize(transcript), _normalize(prompt)).ratio()
    prompt_words = _content_words(prompt)
    if not prompt_words:
        return seq_ratio
    transcript_words = _content_words(transcript)
    coverage = len(transcript_words & prompt_words) / len(prompt_words)
    return max(seq_ratio, coverage)


def extract_turn_transcript(message: dict) -> str:
    """Concatenate whatever transcript text is present on a `response.done` message."""
    response = message.get("response") or {}
    parts = []
    for output in response.get("output", []):
        if output.get("type") != "message":
            continue
        for content in output.get("content", []):
            transcript = content.get("transcript") or content.get("text")
            if transcript:
                parts.append(transcript)
    return " ".join(parts).strip()


def _next_expected_question(sess: SessionState) -> tuple[dict, int] | None:
    """The next unanswered question in the survey's fixed script order, 1-indexed.

    Filters out already-scored question_ids rather than assuming strict order,
    so an out-of-order scoring call can't desync this from what's actually left.
    """
    questions = sess.survey_config.get("questions", [])
    answered = set(sess.survey_results.keys())
    for idx, q in enumerate(questions, start=1):
        if q.get("id") not in answered:
            return q, idx
    return None


def _frame_snapshot(sess: SessionState, turn_state: str, question_id: str | None,
                     question_index: int | None) -> dict:
    return {
        "frame_index": len(sess.timeline_frames),
        "timestamp": datetime.now(UTC).isoformat(),
        "turn_state": turn_state,
        "question_id": question_id,
        "question_index": question_index,
        # Internal only — never persisted (db.save_survey_timeline_frames reads
        # named fields explicitly) — ties this frame to the agent turn it was
        # captured during, so resolve_agent_turn can find it again.
        "_turn_seq": sess.current_turn_seq if sess.agent_speaking else None,
        "blink_rate_bpm": sess.current_blink_rate_bpm,
        "blink_rate_change_percent": sess.current_blink_rate_change,
        "pupil_mm_change": sess.current_pupil_mm_change,
        "left_gaze_position": sess.current_left_gaze_position,
        "right_gaze_position": sess.current_right_gaze_position,
        "face_emotion": sess.current_face_emotion,
        "voice_sentiment": sess.current_sentiment,
        "stress_state": sess.stress_state,
    }


async def run_timeline_sampler(sess: SessionState) -> None:
    """1Hz loop: append one frame per elapsed second while the survey is live."""
    logger.info("[Timeline] ★ Sampler started (session=%s)", sess.session_id)
    while sess.timeline_active:
        if sess.agent_speaking:
            # Real turn_state/question_id resolved retroactively in resolve_agent_turn
            # once this turn's transcript is known (response.done).
            frame = _frame_snapshot(sess, "agent_pending", None, None)
        elif sess.user_speaking:
            frame = _frame_snapshot(
                sess, "user_answer",
                sess.pending_answer_question_id, sess.pending_answer_question_index,
            )
        else:
            frame = _frame_snapshot(
                sess, "idle",
                sess.pending_answer_question_id, sess.pending_answer_question_index,
            )
        sess.timeline_frames.append(frame)
        await asyncio.sleep(_SAMPLE_INTERVAL_S)
    logger.info("[Timeline] ★ Sampler stopped (session=%s, %d frames)",
                sess.session_id, len(sess.timeline_frames))


def resolve_agent_turn(sess: SessionState, transcript: str) -> None:
    """Called on `response.done`: label the just-finished turn's buffered frames.

    Matches `transcript` against the next unanswered question's literal wording;
    on a match, tags every frame captured during this turn as `agent_question`
    and opens the "pending answer" window (subsequent user_answer/idle frames
    inherit this question_id until it's scored). No match -> `agent_other`.
    """
    turn_seq = sess.current_turn_seq
    pending_frames = [f for f in sess.timeline_frames if f.get("_turn_seq") == turn_seq]
    if not pending_frames:
        return

    next_q = _next_expected_question(sess)
    if next_q and transcript:
        question, index = next_q
        prompt_text = question.get("prompt", "")
        if prompt_text and _similarity(transcript, prompt_text) >= _MATCH_THRESHOLD:
            for f in pending_frames:
                f["turn_state"] = "agent_question"
                f["question_id"] = question["id"]
                f["question_index"] = index
            sess.pending_answer_question_id = question["id"]
            sess.pending_answer_question_index = index
            sess.pending_answer_started_at_frame_index = pending_frames[0]["frame_index"]
            logger.info(
                "[Timeline] ★ Turn matched question %s (session=%s): %r ~ %r",
                question["id"], sess.session_id, transcript[:80], prompt_text[:80],
            )
            return

    for f in pending_frames:
        f["turn_state"] = "agent_other"


def retag_pending_frames(sess: SessionState, correct_question_id: str,
                          correct_question_index: int | None) -> None:
    """Safety net for the rare case record_survey_response scores a DIFFERENT
    question than the one transcript-matching predicted (e.g. out-of-order
    scoring) — repoints frames already tagged with the stale predicted id.
    """
    start_index = sess.pending_answer_started_at_frame_index
    stale_id = sess.pending_answer_question_id
    if start_index is None or stale_id is None or stale_id == correct_question_id:
        return
    for f in sess.timeline_frames:
        if f["frame_index"] >= start_index and f.get("question_id") == stale_id:
            f["question_id"] = correct_question_id
            f["question_index"] = correct_question_index
    logger.warning(
        "[Timeline] ★ Retagged frames from stale predicted question %s to actual %s (session=%s)",
        stale_id, correct_question_id, sess.session_id,
    )


# How much longer to keep sampling after the last survey question is scored,
# instead of cutting off the instant it's scored — covers the agent's closing
# remarks / the start of report delivery rather than stopping mid-sentence.
_POST_SURVEY_GRACE_S = 10.0


def start_timeline_capture(sess: SessionState) -> None:
    """Fire-and-forget the 1Hz sampler, keeping a reference so it isn't GC'd early."""
    if sess.timeline_active:
        return
    sess.timeline_active = True
    sess.timeline_generation += 1
    sess._timeline_task = asyncio.create_task(run_timeline_sampler(sess))


def stop_timeline_capture(sess: SessionState) -> None:
    """Stop sampling immediately. Defensively resolves any still-open
    'agent_pending' frames (e.g. the survey ended before the final turn's
    response.done was processed) so nothing is left in a non-terminal
    turn_state before persistence."""
    sess.timeline_active = False
    for f in sess.timeline_frames:
        if f.get("turn_state") == "agent_pending":
            f["turn_state"] = "agent_other"


async def _delayed_stop(sess: SessionState, generation: int, grace_s: float) -> None:
    await asyncio.sleep(grace_s)
    # Only stop if no NEW survey (retake) has started sampling on this same
    # session_id in the meantime — otherwise this stale grace-period task would
    # cut off a sampler that has nothing to do with the survey that finished.
    if sess.timeline_generation == generation:
        stop_timeline_capture(sess)


def schedule_stop_timeline_capture(sess: SessionState, grace_s: float = _POST_SURVEY_GRACE_S) -> None:
    """Keep sampling for `grace_s` more seconds after the survey's last question
    is scored, instead of stopping instantly (see stop_timeline_capture for the
    immediate variant, still used as a disconnect safety net)."""
    sess._timeline_stop_task = asyncio.create_task(
        _delayed_stop(sess, sess.timeline_generation, grace_s)
    )
