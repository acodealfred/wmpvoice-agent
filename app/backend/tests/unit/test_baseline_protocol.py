"""Baseline protocol: user_baselines EEG column, audio gate, spoken cues, timeline start."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from azure.core.credentials import AzureKeyCredential

from ciq.prompts.builder import BASELINE_CUE_NAMES, baseline_cue_instructions
from ciq.realtime.middle_tier import RTMiddleTier
from ciq.realtime.session import reset_active_session, set_active_session


async def _user_id(name: str = "system1") -> str:
    from db import get_user_by_name

    return (await get_user_by_name(name))["user_id"]


@pytest.mark.asyncio
async def test_eeg_column_migration_is_idempotent(initialized_db):
    from db_init import init_db

    await init_db()  # second run must not fail on the existing column


@pytest.mark.asyncio
async def test_baseline_eeg_is_stored_but_not_returned_by_the_ttl_lookup(initialized_db):
    from db import get_user_baseline, get_user_baseline_eeg, upsert_user_baseline

    uid = await _user_id()
    eeg = {"schema": "muse-web-bridge/3", "markers": [{"label": "baseline_eyes_open", "t_ms_start": 0, "t_ms_end": 180000}]}
    await upsert_user_baseline(uid, 4.2, 17.0, eeg)

    row = await get_user_baseline(uid)
    assert row["pupil_size"] == 4.2 and row["blink_rate"] == 17.0
    assert "eeg_baseline_json" not in row
    assert await get_user_baseline_eeg(uid) == eeg


@pytest.mark.asyncio
async def test_baseline_overwrite_without_eeg_clears_the_old_eeg(initialized_db):
    from db import get_user_baseline, get_user_baseline_eeg, upsert_user_baseline

    uid = await _user_id()
    await upsert_user_baseline(uid, 4.2, 17.0, {"schema": "muse-web-bridge/3"})
    await upsert_user_baseline(uid, 3.9, 15.0)

    assert (await get_user_baseline(uid))["pupil_size"] == 3.9
    assert await get_user_baseline_eeg(uid) is None


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
