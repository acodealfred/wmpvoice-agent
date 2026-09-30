"""Timeline frames across Pause/Continue segments (ciq.realtime.timeline_capture + db)."""
import asyncio

from ciq.realtime.session import SessionState
from ciq.realtime.timeline_capture import (
    _frame_snapshot,
    start_timeline_capture,
    stop_timeline_capture,
)


def test_frame_index_continues_from_offset_and_carries_segment():
    sess = SessionState(session_id="s")
    sess.timeline_frame_offset = 42
    sess.timeline_segment_index = 2
    sess.timeline_frames.append(_frame_snapshot(sess, "idle", None, None))
    second = _frame_snapshot(sess, "idle", None, None)
    assert (sess.timeline_frames[0]["frame_index"], second["frame_index"]) == (42, 43)
    assert second["segment_index"] == 2


def test_fresh_session_numbers_from_zero_in_segment_zero():
    frame = _frame_snapshot(SessionState(session_id="s"), "idle", None, None)
    assert (frame["frame_index"], frame["segment_index"]) == (0, 0)


def test_reset_for_new_survey_unbinds_the_run():
    sess = SessionState(session_id="s")
    sess.survey_run_id, sess.user_id = "run", "user"
    sess.timeline_frame_offset, sess.timeline_segment_index = 10, 3
    sess.reset_for_new_survey()
    assert (sess.survey_run_id, sess.user_id) == (None, None)
    assert (sess.timeline_frame_offset, sess.timeline_segment_index) == (0, 0)


async def test_quick_stop_start_leaves_a_single_sampler():
    sess = SessionState(session_id="s")
    start_timeline_capture(sess)
    first = sess._timeline_task
    await asyncio.sleep(0)            # first sampler takes a frame, then sleeps 1s
    stop_timeline_capture(sess)
    start_timeline_capture(sess)      # restarted before the old loop wakes up
    await asyncio.sleep(1.2)
    assert first.done()               # old loop saw the newer generation and exited
    assert not sess._timeline_task.done()
    stop_timeline_capture(sess)
    await asyncio.sleep(1.1)


async def test_frame_upsert_relabels_and_keeps_segments(initialized_db):
    from conftest import seed_user_id

    from db import (
        create_active_survey_run,
        get_survey_timeline_frames,
        save_survey_timeline_frames,
    )

    user = await seed_user_id("guest1")
    await create_active_survey_run("run-1", user, None, "s", "TEST")
    frame = {"frame_index": 0, "segment_index": 0, "timestamp": "2026-01-01T00:00:00+00:00",
             "turn_state": "agent_other"}
    await save_survey_timeline_frames("run-1", user, "s", [frame])
    # Same frame flushed again after resolve_agent_turn relabelled it in memory.
    relabelled = {**frame, "turn_state": "agent_question", "question_id": "q1", "question_index": 1}
    resumed = {"frame_index": 1, "segment_index": 1, "timestamp": "2026-01-01T01:00:00+00:00",
               "turn_state": "idle"}
    await save_survey_timeline_frames("run-1", user, "s", [relabelled, resumed])

    rows = await get_survey_timeline_frames("run-1")
    assert [(r["frame_index"], r["segment_index"]) for r in rows] == [(0, 0), (1, 1)]
    assert (rows[0]["turn_state"], rows[0]["question_id"]) == ("agent_question", "q1")
