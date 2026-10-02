"""The user's own words per survey answer, from Whisper input-audio transcription.

``record_survey_response``'s ``user_verbal_response`` is the MODEL's paraphrase —
often just the scale option it mapped the answer to ("Sometimes.") and sometimes
omitted. What the user actually said comes from Azure's
``conversation.item.input_audio_transcription.completed`` events instead, tied to
the question by conversation item id, never by arrival order:

    agent asks Qn (timeline_capture.resolve_agent_turn match) -> clear_unassigned
    user speaks (conversation.item.created, role=user)       -> note_user_item(item_id)
    [clarifying follow-up + second reply]                    -> note_user_item(item_id)
    record_survey_response(Qn)                               -> assign_items_to_question
    Whisper done (item_id, transcript)                       -> record_transcript

Whisper usually finishes AFTER the tool call, so the answer is first stored with
the model's text as a fallback and patched when the transcript lands (see
RTMiddleTier's transcription handler and ciq.assessments.service.persist_transcript).

Scored answers are the exception: they store the option label for their score and
are never patched with Whisper text (see user_response_for).
"""
from ciq.realtime.session import SessionState


def clear_unassigned(sess: SessionState) -> None:
    """The agent just asked a question: earlier replies ("yes, let's start") aren't its answer."""
    sess.unassigned_user_items = []


def note_user_item(sess: SessionState, item_id: str | None) -> None:
    """A user speech turn was committed to the conversation."""
    if item_id and item_id not in sess.answer_items and item_id not in sess.unassigned_user_items:
        sess.unassigned_user_items.append(item_id)


def assign_items_to_question(sess: SessionState, question_id: str) -> None:
    """record_survey_response scored `question_id`: every reply since it was asked is its answer."""
    order = sess.answer_item_order.setdefault(question_id, [])
    for item_id in sess.unassigned_user_items:
        sess.answer_items[item_id] = question_id
        order.append(item_id)
    sess.unassigned_user_items = []


def record_transcript(sess: SessionState, item_id: str | None, text: str | None) -> str | None:
    """Store a finished (or failed: text "") transcription. Returns the question it answers, if any.

    Transcripts of items that are neither pending nor an answer (post-report Q&A,
    small talk after a question was asked and abandoned by a reset) are dropped.
    """
    if not item_id or (item_id not in sess.answer_items and item_id not in sess.unassigned_user_items):
        return None
    sess.item_transcripts[item_id] = (text or "").strip()
    return sess.answer_items.get(item_id)


def transcript_for(sess: SessionState, question_id: str) -> str:
    """The user's words for one answer, in speaking order ("" until Whisper has returned)."""
    parts = [sess.item_transcripts.get(i, "") for i in sess.answer_item_order.get(question_id, [])]
    return " ".join(p for p in parts if p)


def pending_transcripts(sess: SessionState) -> list[str]:
    """Answer items still waiting for their transcription."""
    return [i for i in sess.answer_items if i not in sess.item_transcripts]


def user_response_for(sess: SessionState, question_id: str, model_text: str | None,
                      score_label: str | None = None) -> str:
    """What to store as the answer's user_response.

    A scored answer stores its option label ("Sometimes"): Whisper often mishears
    short one-word answers ("Some don't.", "and I'm"), while the score the model
    gave is reliable. Only open-ended (unscored) answers use the real words, else
    the model's text.
    """
    if score_label:
        return score_label
    return transcript_for(sess, question_id) or (model_text or "")
