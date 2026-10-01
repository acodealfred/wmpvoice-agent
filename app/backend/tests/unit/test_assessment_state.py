"""Assessment lifecycle state machine (ciq/assessments/service.py) against a temp DB."""
import pytest
from conftest import seed_user_id

from ciq.assessments.service import (
    AssessmentError,
    close_run,
    complete_baseline,
    continue_run,
    get_resumable,
    pause_run,
    persist_answer,
    start_run,
)
from ciq.prompts.builder import reconnect_instructions
from ciq.realtime.middle_tier import RTMiddleTier
from db import (
    get_open_survey_run,
    get_run_baseline,
    get_survey_item_responses,
    get_survey_run_status,
    get_survey_timeline_frames,
    get_user_survey_records,
    get_user_survey_run_summaries,
    mark_survey_run_completed,
    save_survey_record_results,
)

SESSION = "sess-guest1"


def _snapshot(qid, score, text="an answer"):
    return {"questionId": qid, "domain": "D", "score": score, "userResponse": text,
            "voiceSentiment": "neutral", "blinkRateChange": 1.5, "pupilMmChange": 0.1,
            "leftGazePosition": "Center", "rightGazePosition": "Left", "responseLatencyMs": 800}


async def _answer(rtmt, qid, score):
    """What handlers.survey_tool does on a scored answer: memory + persist."""
    sess = rtmt.get_or_create_session(SESSION)
    sess.survey_results[qid] = {"score": score}
    await persist_answer(sess, sess.survey_config, _snapshot(qid, score))


@pytest.fixture
async def user(initialized_db):
    return await seed_user_id("guest1")


async def test_start_binds_session_and_creates_active_run(live_rtmt, user):
    result = await start_run(live_rtmt, SESSION, user, None, "TEST")
    sess = live_rtmt.get_or_create_session(SESSION)
    assert sess.survey_run_id == result["surveyRunId"]
    assert sess.user_id == user
    assert await get_survey_run_status(result["surveyRunId"]) == "active"


async def test_start_new_closes_the_open_run(live_rtmt, user):
    first = await start_run(live_rtmt, SESSION, user, None, "TEST")
    await pause_run(live_rtmt, SESSION, user)
    second = await start_run(live_rtmt, SESSION, user, None, "TEST")
    assert second["closedRunIds"] == [first["surveyRunId"]]
    assert await get_survey_run_status(first["surveyRunId"]) == "closed"
    assert (await get_open_survey_run(user))["survey_run_id"] == second["surveyRunId"]


async def test_answers_persist_only_while_active(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    await _answer(live_rtmt, "q1", 4)
    await pause_run(live_rtmt, SESSION, user)
    await _answer(live_rtmt, "q2", 3)  # late tool call after Pause — must not land
    rows = await get_survey_item_responses(run)
    assert [r["question_id"] for r in rows] == ["q1"]
    assert rows[0]["user_response"] == "an answer"


async def test_pause_flushes_frames_and_resumable_reports_progress(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    sess = live_rtmt.get_or_create_session(SESSION)
    sess.timeline_frames = [
        {"frame_index": i, "segment_index": 0, "timestamp": f"2026-01-01T00:00:0{i}+00:00",
         "turn_state": "idle"} for i in range(3)
    ]
    await _answer(live_rtmt, "q1", 4)
    await pause_run(live_rtmt, SESSION, user)

    assert len(await get_survey_timeline_frames(run)) == 3
    resumable = await get_resumable(user)
    assert resumable["surveyRunId"] == run
    assert resumable["status"] == "paused"
    assert (resumable["answered"], resumable["total"]) == (1, 5)
    assert resumable["snapshots"][0]["questionId"] == "q1"
    assert resumable["snapshots"][0]["score"] == 4


async def test_pause_without_active_run_is_rejected(live_rtmt, user):
    with pytest.raises(AssessmentError):
        await pause_run(live_rtmt, SESSION, user)


async def test_continue_rehydrates_session_on_next_segment(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    sess = live_rtmt.get_or_create_session(SESSION)
    sess.timeline_frames = [
        {"frame_index": i, "segment_index": 0, "timestamp": f"2026-01-01T00:00:0{i}+00:00",
         "turn_state": "idle"} for i in range(4)
    ]
    await _answer(live_rtmt, "q1", 4)
    await _answer(live_rtmt, "q2", 2)
    await pause_run(live_rtmt, SESSION, user)

    result = await continue_run(live_rtmt, SESSION, user, run)
    sess = live_rtmt.get_or_create_session(SESSION)
    assert result["segmentIndex"] == 1
    assert [s["questionId"] for s in result["snapshots"]] == ["q1", "q2"]
    assert set(sess.survey_results) == {"q1", "q2"}
    assert sess.survey_results["q1"]["score"] == 4
    assert sess.timeline_segment_index == 1
    assert sess.timeline_frame_offset == 4
    assert sess.timeline_frames == []
    assert await get_survey_run_status(run) == "active"
    # This run never completed a baseline -> the protocol must run before the survey resumes.
    assert (result["baselineRequired"], result["baseline"], sess.survey_phase) == (True, None, "baseline")

    # The next WS connect counts as a reconnect -> the agent is told where it left off.
    sess.connection_count += 1
    assert "2/5 questions answered" in reconnect_instructions(sess, sess.survey_config)


async def test_continue_reuses_the_runs_own_baseline(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    await complete_baseline(live_rtmt, SESSION, user, 15.0, 4.2)
    await _answer(live_rtmt, "q1", 4)
    await pause_run(live_rtmt, SESSION, user)
    result = await continue_run(live_rtmt, SESSION, user, run)
    sess = live_rtmt.get_or_create_session(SESSION)
    assert (result["baselineRequired"], sess.survey_phase, sess.is_returning_user) == (False, "survey", True)
    assert result["baseline"] == {"blinkRate": 15.0, "pupilSize": 4.2}


# ── Per-assessment baseline ──────────────────────────────────────────────────
async def test_every_new_run_requires_its_own_baseline(live_rtmt, user):
    first = await start_run(live_rtmt, SESSION, user, None, "TEST")
    assert first["baselineRequired"] is True
    await complete_baseline(live_rtmt, SESSION, user, 15.0, None)

    second = await start_run(live_rtmt, SESSION, user, None, "TEST")
    assert second["baselineRequired"] is True
    assert await get_run_baseline(second["surveyRunId"]) is None
    # ...while the first run keeps the baseline it used.
    assert (await get_run_baseline(first["surveyRunId"]))["blink_rate"] == 15.0


async def test_baseline_is_set_once_and_tied_to_its_segment(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    assert (await complete_baseline(live_rtmt, SESSION, user, 15.0, 4.2))["stored"] is True
    assert (await complete_baseline(live_rtmt, SESSION, user, 99.0, 1.0))["stored"] is False
    baseline = await get_run_baseline(run)
    assert (baseline["blink_rate"], baseline["pupil_size"], baseline["segment_index"]) == (15.0, 4.2, 0)
    assert baseline["completed_at"]


async def test_pause_mid_baseline_recaptures_it_in_the_next_segment(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    sess = live_rtmt.get_or_create_session(SESSION)
    sess.timeline_frames = [
        {"frame_index": i, "segment_index": 0, "timestamp": f"2026-01-01T00:00:0{i}+00:00",
         "turn_state": "idle", "stage": "baseline_eyes_open"} for i in range(3)
    ]
    await pause_run(live_rtmt, SESSION, user)  # before the protocol finished

    result = await continue_run(live_rtmt, SESSION, user, run)
    assert result["baselineRequired"] is True
    # The abandoned attempt's seconds are kept, tagged, in segment 0.
    assert [(f["segment_index"], f["stage"]) for f in await get_survey_timeline_frames(run)] == [
        (0, "baseline_eyes_open")] * 3

    await complete_baseline(live_rtmt, SESSION, user, 16.0, None)
    assert (await get_run_baseline(run))["segment_index"] == 1  # the segment that holds it


async def test_baseline_needs_an_active_bound_run(live_rtmt, user):
    with pytest.raises(AssessmentError):
        await complete_baseline(live_rtmt, SESSION, user, 15.0, None)
    await start_run(live_rtmt, SESSION, user, None, "TEST")
    await pause_run(live_rtmt, SESSION, user)
    with pytest.raises(AssessmentError):
        await complete_baseline(live_rtmt, SESSION, user, 15.0, None)


async def test_phase_resolution_reads_the_bound_runs_baseline(live_rtmt, user):
    await start_run(live_rtmt, SESSION, user, None, "TEST")
    sess = live_rtmt.get_or_create_session(SESSION)
    await RTMiddleTier._resolve_survey_phase(live_rtmt, sess, None)
    assert (sess.survey_phase, sess.is_returning_user) == ("baseline", False)

    await complete_baseline(live_rtmt, SESSION, user, 15.0, None)
    await RTMiddleTier._resolve_survey_phase(live_rtmt, sess, None)
    assert (sess.survey_phase, sess.is_returning_user) == ("survey", True)


async def test_admin_run_list_includes_partial_runs_with_status(live_rtmt, user):
    empty = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    partial = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    await _answer(live_rtmt, "q1", 4)
    await pause_run(live_rtmt, SESSION, user)
    await close_run(live_rtmt, SESSION, user, partial)

    runs = {r["survey_run_id"]: r for r in await get_user_survey_run_summaries(user)}
    assert runs[partial]["status"] == "closed"
    assert empty not in runs  # recorded nothing at all


async def test_close_discards_the_paused_run(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    await pause_run(live_rtmt, SESSION, user)
    await close_run(live_rtmt, SESSION, user, run)
    assert await get_survey_run_status(run) == "closed"
    assert await get_resumable(user) is None
    with pytest.raises(AssessmentError):
        await continue_run(live_rtmt, SESSION, user, run)


async def test_cannot_close_another_users_run(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    other = await seed_user_id("guest2")
    with pytest.raises(AssessmentError):
        await close_run(live_rtmt, "sess-guest2", other, run)
    assert await get_survey_run_status(run) == "active"


async def test_history_lists_only_completed_runs(live_rtmt, user):
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    await save_survey_record_results(run, {"q1": {}}, {"totalScore": 1}, {})
    assert await get_user_survey_records(user) == []
    await mark_survey_run_completed(run)
    assert [r["survey_run_id"] for r in await get_user_survey_records(user)] == [run]
    assert await get_resumable(user) is None


async def test_continue_with_no_answers_is_a_fresh_start(live_rtmt, user):
    """Paused during/right after the baseline: no 'welcome back' reconnect framing —
    the next WS connect resolves the phase like any new assessment."""
    run = (await start_run(live_rtmt, SESSION, user, None, "TEST"))["surveyRunId"]
    await pause_run(live_rtmt, SESSION, user)
    result = await continue_run(live_rtmt, SESSION, user, run)
    sess = live_rtmt.get_or_create_session(SESSION)
    assert result["answered"] == 0
    assert sess.connection_count == 0
    assert sess.survey_run_id == run
    sess.connection_count += 1  # the first WS connect
    assert reconnect_instructions(sess, sess.survey_config) == ""


# ── Consent shown on every visit: each acceptance logged and tied to its run ──
async def test_every_consent_acceptance_is_kept_and_linked_to_its_pilot_run(live_rtmt, user):
    from db import get_consent_events, record_consent_event

    await record_consent_event(user, "v1", "PILOT")
    first = (await start_run(live_rtmt, SESSION, user, None, "PILOT"))["surveyRunId"]
    await pause_run(live_rtmt, SESSION, user)
    await record_consent_event(user, "v1", "PILOT")        # re-entered the page
    await continue_run(live_rtmt, SESSION, user, first)
    await record_consent_event(user, "v1", "PILOT")        # entered again, then left
    events = await get_consent_events(user)
    assert [e["survey_run_id"] for e in events] == [first, first, None]
    assert all(e["consent_version"] == "v1" for e in events)


async def test_consent_is_not_linked_to_non_pilot_runs(live_rtmt, user):
    from db import get_consent_events, record_consent_event

    await record_consent_event(user, "v1", "PILOT")
    await start_run(live_rtmt, SESSION, user, None, "TEST")
    assert [e["survey_run_id"] for e in await get_consent_events(user)] == [None]
