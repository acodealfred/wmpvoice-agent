"""record_survey_response guards (ciq/realtime/tools/handlers.py survey_tool) and the
reconnect resume prompt — an answer is only recorded against the question actually
being asked, so a Pause/Continue can no longer skip or lose a question."""
import asyncio
import json

import pytest
from conftest import seed_user_id

from ciq.assessments.service import pause_run, start_run
from ciq.prompts.builder import reconnect_instructions
from ciq.realtime.session import SessionState
from ciq.realtime.tools.base import ToolResultDirection
from ciq.realtime.tools.handlers import survey_tool

CONFIG = {"type": "TEST", "questions": [{"id": f"q{i}", "prompt": f"Question {i}?", "text": f"Q{i}"} for i in range(1, 5)]}


def _sess():
    sess = SessionState(session_id="s")
    sess.survey_config = CONFIG
    return sess


def _record(sess, qid, config=CONFIG, score=3):
    result = asyncio.run(survey_tool(sess, config, {"question_id": qid, "score": score}))
    return result, json.loads(result.to_text())


def test_next_question_is_recorded():
    sess = _sess()
    result, body = _record(sess, "q1")
    assert body["recorded"] is True and "q1" in sess.survey_results
    assert result.destination == ToolResultDirection.TO_CLIENT  # unchanged success path
    assert body["client_message"]["completed"] == 1


def test_skipping_ahead_is_refused_and_tells_the_model_the_current_question():
    sess = _sess()
    _record(sess, "q1")
    result, body = _record(sess, "q3")
    assert body["recorded"] is False and body["reason"] == "out_of_order"
    assert body["expected_question_id"] == "q2"
    assert "Question 2?" in body["message"]
    assert result.destination == ToolResultDirection.TO_SERVER  # the model reads it
    assert set(sess.survey_results) == {"q1"}


def test_duplicate_is_refused_out_loud():
    sess = _sess()
    _record(sess, "q1")
    result, body = _record(sess, "q1", score=5)
    assert body["recorded"] is False and body["reason"] == "duplicate" and body["duplicate"] is True
    assert result.destination == ToolResultDirection.TO_SERVER  # was TO_CLIENT, i.e. silent
    assert "(id q2)" in body["message"]
    assert sess.survey_results["q1"]["score"] == 3


def test_unknown_question_is_refused():
    sess = _sess()
    _, body = _record(sess, "nope")
    assert body["reason"] == "unknown_question" and sess.survey_results == {}


def test_a_refused_call_leaves_the_answer_for_the_correct_one():
    sess = _sess()
    _record(sess, "q2")  # refused: q1 not answered yet
    _, body = _record(sess, "q1")
    assert body["recorded"] is True and body["client_message"]["completed"] == 1


def test_qualitative_surveys_may_cover_topics_in_any_order():
    config = {**CONFIG, "type": "READINESS", "qualitative": True}
    sess = _sess()
    sess.survey_config = config
    _, body = _record(sess, "q3", config=config, score=None)
    assert body["recorded"] is True


@pytest.fixture
async def user(initialized_db):
    return await seed_user_id("guest1")


async def test_answers_are_refused_while_the_run_is_paused(live_rtmt, user):
    await start_run(live_rtmt, "s1", user, None, "TEST")
    sess = live_rtmt.get_or_create_session("s1")
    await pause_run(live_rtmt, "s1", user)
    result = await survey_tool(sess, sess.survey_config, {"question_id": "q1", "score": 3})
    body = json.loads(result.to_text())
    assert body["recorded"] is False and body["reason"] == "assessment_paused"
    assert sess.survey_results == {}


# ── reconnect resume prompt ──────────────────────────────────────────────────
def test_reconnect_resumes_straight_into_the_next_question_with_the_full_remaining_list():
    sess = _sess()
    sess.connection_count = 2
    sess.survey_results = {"q1": {"score": 2}, "q2": {"score": 4}}
    text = reconnect_instructions(sess, CONFIG)
    assert "shall we continue" not in text.lower()
    assert "ask the next unanswered question: 'Question 3?'" in text
    assert text.index("(id: q3)") < text.index("(id: q4)")
    assert "is NOT an answer" in text


# ── a scored answer needs its score (else the report never opens) ────────────
@pytest.mark.parametrize("bad", [None, "3", True])
def test_scored_answer_without_a_valid_score_is_refused(bad):
    sess = _sess()
    result, body = _record(sess, "q1", score=bad)
    assert body["recorded"] is False and body["reason"] == "missing_score"
    assert "ask the question again" in body["message"]
    assert result.destination == ToolResultDirection.TO_SERVER  # the model reads it
    assert sess.survey_results == {}
    _, body = _record(sess, "q1", score=3)  # the re-asked answer is then recorded
    assert body["recorded"] is True


async def test_continue_re_asks_an_answer_saved_without_a_score(live_rtmt, user):
    from ciq.assessments.service import continue_run, get_resumable
    from db import save_survey_item_responses

    await start_run(live_rtmt, "s1", user, None, "TEST")
    sess = live_rtmt.get_or_create_session("s1")
    run_id = sess.survey_run_id
    await survey_tool(sess, sess.survey_config, {"question_id": "q1", "score": 3})
    # An answer stored without a score, as older code allowed.
    await save_survey_item_responses(run_id, user, "s1", sess.survey_config, [{"questionId": "q2", "score": None}])
    await pause_run(live_rtmt, "s1", user)

    assert (await get_resumable(user))["answered"] == 1
    run = await continue_run(live_rtmt, "s1", user, run_id)
    assert run["answered"] == 1
    assert [s["questionId"] for s in run["snapshots"]] == ["q1"]
    assert set(sess.survey_results) == {"q1"}
    result = await survey_tool(sess, sess.survey_config, {"question_id": "q2", "score": 4})  # q2 is next again
    assert json.loads(result.to_text())["recorded"] is True
