"""PILOT closing line: silent after the last answer, spoken on the `survey_complete` cue
(the report progress screen's 4th card) instead."""
import json
from types import SimpleNamespace

import pytest
from azure.core.credentials import AzureKeyCredential

from ciq.prompts.builder import LANGUAGE_RULE, baseline_cue_instructions
from ciq.realtime.middle_tier import RTMiddleTier
from ciq.realtime.session import (
    ConnectionState,
    SessionState,
    reset_active_connection,
    reset_active_session,
    set_active_connection,
    set_active_session,
)
from ciq.realtime.tools.base import ToolResult, ToolResultDirection
from ciq.realtime.tools.handlers import pilot_survey_just_completed
from survey_loader import load_survey

PILOT = load_survey("PILOT")
TEST = load_survey("TEST")


class FakeServerWs:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


@pytest.fixture
def rtmt():
    mt = RTMiddleTier(endpoint="https://example.invalid", deployment="d", credentials=AzureKeyCredential("k"))

    async def fake_record(_args):
        return ToolResult(json.dumps({"ok": True}), ToolResultDirection.TO_SERVER)

    mt.tools["record_survey_response"] = SimpleNamespace(target=fake_record)
    return mt


def _answered(config: dict, n: int) -> SessionState:
    sess = SessionState(session_id="s", survey_config=config)
    sess.survey_results = {q["id"]: {"score": 3} for q in config["questions"][:n]}
    return sess


async def _to_client(mt, sess, conn, server_ws, message: dict):
    s_token = set_active_session(sess)
    c_token = set_active_connection(conn)
    try:
        return await mt._process_message_to_client(SimpleNamespace(data=json.dumps(message)), None, server_ws)
    finally:
        reset_active_connection(c_token)
        reset_active_session(s_token)


async def _answer_turn(mt, sess, conn, ws):
    """One record_survey_response tool call, start to finish, then response.done."""
    item = {"type": "function_call", "call_id": "c1", "name": "record_survey_response", "arguments": "{}"}
    await _to_client(mt, sess, conn, ws, {"type": "conversation.item.created", "previous_item_id": "p", "item": item})
    await _to_client(mt, sess, conn, ws, {"type": "response.output_item.done", "item": item})
    await _to_client(mt, sess, conn, ws, {"type": "response.done", "response": {"output": []}})


def test_pilot_survey_just_completed_only_for_a_fully_answered_pilot():
    total = len(PILOT["questions"])
    assert pilot_survey_just_completed(_answered(PILOT, total))
    assert not pilot_survey_just_completed(_answered(PILOT, total - 1))
    assert not pilot_survey_just_completed(_answered(TEST, len(TEST["questions"])))
    assert not pilot_survey_just_completed(SessionState(session_id="e", survey_config={}))


@pytest.mark.asyncio
async def test_last_pilot_answer_gets_no_automatic_reply(rtmt):
    sess, conn, ws = _answered(PILOT, len(PILOT["questions"])), ConnectionState(), FakeServerWs()
    await _answer_turn(rtmt, sess, conn, ws)

    # The tool result still reaches Azure, but no response.create follows it.
    assert [m["type"] for m in ws.sent] == ["conversation.item.create"]
    assert conn.skip_tool_followup is False  # one-shot
    assert conn.tools_pending == {}


@pytest.mark.asyncio
async def test_earlier_answers_still_get_the_automatic_reply(rtmt):
    sess, conn, ws = _answered(PILOT, 2), ConnectionState(), FakeServerWs()
    await _answer_turn(rtmt, sess, conn, ws)
    assert [m["type"] for m in ws.sent] == ["conversation.item.create", "response.create"]


@pytest.mark.asyncio
async def test_other_surveys_still_reply_after_the_last_answer(rtmt):
    sess, conn, ws = _answered(TEST, len(TEST["questions"])), ConnectionState(), FakeServerWs()
    await _answer_turn(rtmt, sess, conn, ws)
    assert ws.sent[-1] == {"type": "response.create"}


def test_survey_complete_cue_is_the_closing_line():
    text = baseline_cue_instructions("survey_complete")
    assert text.startswith(LANGUAGE_RULE)
    assert "press Start" in text
    assert "Do not tell them any result" in text
