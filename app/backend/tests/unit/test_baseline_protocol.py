"""Baseline protocol: migrations, audio gate, spoken cues + timeline stage, timeline start."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from azure.core.credentials import AzureKeyCredential

from ciq.prompts.builder import BASELINE_CUE_NAMES, baseline_cue_instructions
from ciq.realtime.middle_tier import RTMiddleTier
from ciq.realtime.session import reset_active_session, set_active_session


@pytest.mark.asyncio
async def test_baseline_column_migrations_are_idempotent(initialized_db):
    from db_init import init_db

    await init_db()  # second run must not fail on the existing baseline_* / stage columns


def test_every_cue_has_instructions():
    for cue in BASELINE_CUE_NAMES:
        assert baseline_cue_instructions(cue)
    assert baseline_cue_instructions("nope") is None


@pytest.fixture
def rtmt():
    mt = RTMiddleTier(endpoint="https://example.invalid", deployment="d", credentials=AzureKeyCredential("k"))
    mt.enable_survey_mode = True
    return mt


async def _to_server(mt: RTMiddleTier, sess, message: dict):
    token = set_active_session(sess)
    try:
        return await mt._process_message_to_server(SimpleNamespace(data=json.dumps(message)), None)
    finally:
        reset_active_session(token)


@pytest.mark.asyncio
async def test_user_audio_is_dropped_only_during_baseline(rtmt):
    sess = rtmt.get_or_create_session("s1")
    append = {"type": "input_audio_buffer.append", "audio": "AAAA"}

    sess.survey_phase = "baseline"
    assert await _to_server(rtmt, sess, append) is None

    sess.survey_phase = "survey"
    assert await _to_server(rtmt, sess, append) is not None


@pytest.mark.asyncio
async def test_baseline_cue_becomes_a_response_create(rtmt):
    sess = rtmt.get_or_create_session("s1")
    out = json.loads(await _to_server(rtmt, sess, {"type": "baseline.cue", "cue": "eyes_closed_start"}))
    assert out["type"] == "response.create"
    assert "close their eyes" in out["response"]["instructions"]
    assert out["response"]["tool_choice"] == "none"

    assert await _to_server(rtmt, sess, {"type": "baseline.cue", "cue": "bogus"}) is None


@pytest.mark.asyncio
async def test_baseline_cues_set_the_timeline_stage(rtmt):
    sess = rtmt.get_or_create_session("s1")
    sess.survey_phase = "baseline"
    assert sess.timeline_stage() == "baseline_setup"

    await _to_server(rtmt, sess, {"type": "baseline.cue", "cue": "eyes_open_start"})
    assert sess.timeline_stage() == "baseline_eyes_open"
    await _to_server(rtmt, sess, {"type": "baseline.cue", "cue": "eyes_closed_start"})
    assert sess.timeline_stage() == "baseline_eyes_closed"

    sess.unlock_survey()
    assert sess.timeline_stage() == "survey"
    sess.reset_for_new_survey()
    assert (sess.baseline_stage, sess.timeline_stage()) == (None, "baseline_setup")


@pytest.mark.asyncio
async def test_tools_are_disabled_only_during_baseline(rtmt):
    rtmt.tools["noop"] = SimpleNamespace(schema={"type": "function", "name": "noop"})
    sess = rtmt.get_or_create_session("s1")
    update = {"type": "session.update", "session": {}}

    sess.survey_phase = "baseline"
    assert json.loads(await _to_server(rtmt, sess, update))["session"]["tool_choice"] == "none"

    sess.survey_phase = "survey"
    assert json.loads(await _to_server(rtmt, sess, update))["session"]["tool_choice"] == "auto"


@pytest.mark.asyncio
async def test_unlock_starts_the_timeline(rtmt):
    sess = rtmt.get_or_create_session("s1")
    sess.survey_config = {"type": "TEST", "questions": []}
    sess.survey_phase = "baseline"
    assert not sess.timeline_active

    rtmt.unlock_survey_for_session("s1")
    try:
        assert sess.survey_phase == "survey"
        assert sess.timeline_active
    finally:
        sess.timeline_active = False
        await asyncio.sleep(0)
