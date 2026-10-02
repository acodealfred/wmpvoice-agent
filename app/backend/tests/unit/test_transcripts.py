"""The user's own words per answer (ciq.realtime.transcripts) — Whisper timing cases."""
from ciq.realtime.session import SessionState
from ciq.realtime.transcripts import (
    assign_items_to_question,
    clear_unassigned,
    note_user_item,
    pending_transcripts,
    record_transcript,
    transcript_for,
    user_response_for,
)


def _sess():
    return SessionState(session_id="s")


def test_transcript_after_the_tool_call_is_attached_to_the_question():
    sess = _sess()
    clear_unassigned(sess)                      # agent asked q1
    note_user_item(sess, "item-1")              # user spoke
    assign_items_to_question(sess, "q1")        # record_survey_response(q1)
    assert user_response_for(sess, "q1", "Sometimes.") == "Sometimes."  # not back yet
    assert pending_transcripts(sess) == ["item-1"]
    assert record_transcript(sess, "item-1", " most days, honestly ") == "q1"
    assert transcript_for(sess, "q1") == "most days, honestly"
    assert pending_transcripts(sess) == []


def test_transcript_before_the_tool_call_is_used_immediately():
    sess = _sess()
    note_user_item(sess, "item-1")
    assert record_transcript(sess, "item-1", "all the time") is None  # not assigned yet
    assign_items_to_question(sess, "q1")
    assert user_response_for(sess, "q1", "Always.") == "all the time"


def test_clarification_replies_are_joined_in_speaking_order():
    sess = _sess()
    note_user_item(sess, "a")
    note_user_item(sess, "b")                   # reply to the agent's clarifying follow-up
    assign_items_to_question(sess, "q2")
    record_transcript(sess, "b", "I'd say often")
    record_transcript(sess, "a", "hmm, it depends")
    assert transcript_for(sess, "q2") == "hmm, it depends I'd say often"


def test_reply_before_the_question_was_asked_is_not_its_answer():
    sess = _sess()
    note_user_item(sess, "yes-lets-start")
    clear_unassigned(sess)                      # agent asks q1
    note_user_item(sess, "answer")
    assign_items_to_question(sess, "q1")
    assert record_transcript(sess, "yes-lets-start", "yes, let's start") is None
    record_transcript(sess, "answer", "always")
    assert transcript_for(sess, "q1") == "always"


def test_failed_or_empty_transcription_falls_back_to_the_model_text():
    sess = _sess()
    note_user_item(sess, "item-1")
    assign_items_to_question(sess, "q1")
    record_transcript(sess, "item-1", "")       # .failed
    assert pending_transcripts(sess) == []      # no longer waited on
    assert user_response_for(sess, "q1", "Sometimes.") == "Sometimes."


def test_scored_answer_uses_its_option_label_not_whisper():
    sess = _sess()
    note_user_item(sess, "item-1")
    assign_items_to_question(sess, "q1")
    record_transcript(sess, "item-1", "Some don't.")   # Whisper mishearing "Sometimes"
    assert user_response_for(sess, "q1", "Sometimes.", "Sometimes") == "Sometimes"


def test_option_label_maps_each_scale():
    from survey_loader import load_survey, option_label

    pilot = load_survey("PILOT")
    assert option_label(pilot, "bat_q3", 3) == "Sometimes"
    assert option_label(pilot, "cbi_q3", 50) == "Sometimes"
    assert option_label(pilot, "cbi_q1", 3) is None        # BAT value on a CBI item
    assert option_label(pilot, "bat_q1", None) is None     # open-ended / unscored
    assert option_label(pilot, "bat_q1", True) is None


def test_unknown_items_are_ignored():
    sess = _sess()
    assert record_transcript(sess, "post-report-question", "what does that mean?") is None
    assert sess.item_transcripts == {}


def test_each_question_gets_only_its_own_replies():
    sess = _sess()
    note_user_item(sess, "a1")
    assign_items_to_question(sess, "q1")
    note_user_item(sess, "a2")
    assign_items_to_question(sess, "q2")
    record_transcript(sess, "a1", "first")
    record_transcript(sess, "a2", "second")
    assert (transcript_for(sess, "q1"), transcript_for(sess, "q2")) == ("first", "second")


def test_reset_for_new_survey_forgets_everything():
    sess = _sess()
    note_user_item(sess, "a1")
    assign_items_to_question(sess, "q1")
    record_transcript(sess, "a1", "first")
    sess.reset_for_new_survey()
    assert (sess.unassigned_user_items, sess.answer_items, sess.answer_item_order, sess.item_transcripts) == ([], {}, {}, {})
