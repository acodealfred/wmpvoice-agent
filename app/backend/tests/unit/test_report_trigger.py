"""The browser opens the report on the survey.biometric.update with completed == total
(App.tsx). An answer stored without a score used to crash building that message
(sum over None), so the counter showed 7/7 but the report never opened."""
import json
from types import SimpleNamespace

from azure.core.credentials import AzureKeyCredential

from ciq.realtime.middle_tier import RTMiddleTier
from ciq.realtime.session import (
    ConnectionState,
    reset_active_connection,
    reset_active_session,
    set_active_connection,
    set_active_session,
)
from ciq.realtime.tools.base import RTToolCall, Tool, ToolResult, ToolResultDirection

CONFIG = {"type": "TEST", "questions": [{"id": f"q{i}", "prompt": f"Question {i}?"} for i in range(1, 4)]}


class _FakeWS:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


async def test_last_answer_still_opens_the_report_when_an_earlier_one_has_no_score():
    mt = RTMiddleTier(endpoint="https://example.invalid", deployment="d", credentials=AzureKeyCredential("k"))
    sess = mt.get_or_create_session("s1")
    sess.survey_config = CONFIG
    # q1 restored without a score; the tool below has just recorded the last answer.
    sess.survey_results = {"q1": {"score": None}, "q2": {"score": 3}, "q3": {"score": 4}}

    async def fake_tool(_args):
        return ToolResult(json.dumps({"question_id": "q3", "score": 4, "recorded": True}), ToolResultDirection.TO_CLIENT)

    mt.tools["record_survey_response"] = Tool(target=fake_tool, schema={})
    conn = ConnectionState()
    conn.tools_pending["call-1"] = RTToolCall("call-1", "prev")
    message = {"type": "response.output_item.done",
               "item": {"type": "function_call", "name": "record_survey_response", "call_id": "call-1",
                        "arguments": json.dumps({"question_id": "q3", "score": 4})}}

    client_ws, server_ws = _FakeWS(), _FakeWS()
    s_token, c_token = set_active_session(sess), set_active_connection(conn)
    try:
        await mt._process_message_to_client(SimpleNamespace(data=json.dumps(message)), client_ws, server_ws)
    finally:
        reset_active_connection(c_token)
        reset_active_session(s_token)

    (update,) = [m for m in client_ws.sent if m["type"] == "survey.biometric.update"]
    assert (update["completed"], update["total"]) == (3, 3)
    assert update["totalScore"] == 7
