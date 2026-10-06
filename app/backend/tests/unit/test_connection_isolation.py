"""Concurrent users: tool-call state is per WS connection, never shared on RTMiddleTier."""
import json
from types import SimpleNamespace

import pytest
from azure.core.credentials import AzureKeyCredential

from ciq.realtime.middle_tier import RTMiddleTier
from ciq.realtime.session import (
    ConnectionState,
    reset_active_connection,
    reset_active_session,
    set_active_connection,
    set_active_session,
)


class FakeServerWs:
    """Stands in for one connection's upstream Azure socket."""

    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


@pytest.fixture
def rtmt():
    return RTMiddleTier(endpoint="https://example.invalid", deployment="d", credentials=AzureKeyCredential("k"))


async def _to_client(mt, sess, conn, server_ws, message: dict):
    """Relay one Azure->client message as if on the given connection."""
    s_token = set_active_session(sess)
    c_token = set_active_connection(conn)
    try:
        return await mt._process_message_to_client(SimpleNamespace(data=json.dumps(message)), None, server_ws)
    finally:
        reset_active_connection(c_token)
        reset_active_session(s_token)


def _function_call_created(call_id):
    return {
        "type": "conversation.item.created",
        "previous_item_id": "prev",
        "item": {"type": "function_call", "call_id": call_id, "name": "record_survey_response"},
    }


_RESPONSE_DONE = {"type": "response.done", "response": {"output": []}}


@pytest.mark.asyncio
async def test_new_connection_does_not_wipe_another_users_pending_tools(rtmt):
    sess_a, conn_a = rtmt.get_or_create_session("user-a"), ConnectionState()
    await _to_client(rtmt, sess_a, conn_a, FakeServerWs(), _function_call_created("a1"))

    # User B connects mid-way through A's tool call (previously reset shared state).
    sess_b, conn_b = rtmt.get_or_create_session("user-b"), ConnectionState()
    await _to_client(rtmt, sess_b, conn_b, FakeServerWs(), {"type": "response.created"})

    assert "a1" in conn_a.tools_pending
    assert conn_b.tools_pending == {}


@pytest.mark.asyncio
async def test_response_done_only_affects_its_own_connection(rtmt):
    sess_a, conn_a, ws_a = rtmt.get_or_create_session("user-a"), ConnectionState(), FakeServerWs()
    sess_b, conn_b, ws_b = rtmt.get_or_create_session("user-b"), ConnectionState(), FakeServerWs()

    await _to_client(rtmt, sess_a, conn_a, ws_a, _function_call_created("a1"))
    await _to_client(rtmt, sess_b, conn_b, ws_b, _function_call_created("b1"))
    await _to_client(rtmt, sess_b, conn_b, ws_b, {"type": "response.created"})

    await _to_client(rtmt, sess_a, conn_a, ws_a, _RESPONSE_DONE)

    # A's follow-up goes to A's upstream only; B's pending call and running response are untouched.
    assert conn_a.tools_pending == {}
    assert ws_a.sent == [{"type": "response.create"}]
    assert conn_a.response_in_progress is True
    assert conn_b.tools_pending.keys() == {"b1"}
    assert conn_b.response_in_progress is True
    assert ws_b.sent == []


@pytest.mark.asyncio
async def test_busy_response_on_one_connection_does_not_block_anothers_follow_up(rtmt):
    sess_a, conn_a, ws_a = rtmt.get_or_create_session("user-a"), ConnectionState(), FakeServerWs()
    sess_b, conn_b, ws_b = rtmt.get_or_create_session("user-b"), ConnectionState(), FakeServerWs()

    await _to_client(rtmt, sess_a, conn_a, ws_a, {"type": "response.created"})  # A is mid-response
    await _to_client(rtmt, sess_b, conn_b, ws_b, _function_call_created("b1"))
    await _to_client(rtmt, sess_b, conn_b, ws_b, _RESPONSE_DONE)

    assert ws_b.sent == [{"type": "response.create"}]
    assert conn_a.response_in_progress is True


def test_reconnect_starts_with_fresh_connection_state():
    conn = ConnectionState()
    assert conn.tools_pending == {}
    assert conn.response_in_progress is False
    assert ConnectionState().tools_pending is not conn.tools_pending


def test_tool_state_outside_a_connection_fails_loudly(rtmt):
    with pytest.raises(RuntimeError):
        rtmt._tools_pending
    with pytest.raises(RuntimeError):
        rtmt._response_in_progress = True
