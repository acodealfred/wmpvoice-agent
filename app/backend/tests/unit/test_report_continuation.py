"""PILOT voice report: a response cut off at the output-token cap is carried on (bounded),
and every other ending closes the report so ordinary replies are never continued."""
import json
from types import SimpleNamespace

import pytest
from azure.core.credentials import AzureKeyCredential

from ciq.realtime.middle_tier import RTMiddleTier
from ciq.realtime.report_continuation import (
    MAX_AUTO_CONTINUES,
    cut_off_by_token_limit,
    response_end_summary,
)
from ciq.realtime.session import (
    ConnectionState,
    SessionState,
    reset_active_connection,
    reset_active_session,
    set_active_connection,
    set_active_session,
)
from survey_loader import load_survey

PILOT = load_survey("PILOT")
_IDS = [q["id"] for q in PILOT["questions"]]
_REPORT = {"sections": [{"label": "BAT-4", "interpretation": "On screen."}],
           "spoken_report": {"parts": [{"title": "Where Your Capacity Is Going", "say": ["Steady."]}],
                             "domain_lines": ["Your answers were highest on exhaustion."]}}


def _done(status="completed", reason=None, output_tokens=120):
    response = {"output": [], "status": status,
                "usage": {"output_tokens": output_tokens,
                          "output_token_details": {"audio_tokens": output_tokens - 20, "text_tokens": 20}}}
    if reason:
        response["status_details"] = {"type": status, "reason": reason}
    return {"type": "response.done", "response": response}


CUT_OFF = _done("incomplete", "max_output_tokens", 4096)


class FakeServerWs:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


@pytest.fixture
def rtmt():
    return RTMiddleTier(endpoint="https://example.invalid", deployment="d", credentials=AzureKeyCredential("k"))


def _sess() -> SessionState:
    sess = SessionState(session_id="s", survey_config=PILOT)
    sess.survey_results = {qid: {"score": 3} for qid in _IDS}
    return sess


async def _to_client(mt, sess, conn, server_ws, message: dict):
    s_token, c_token = set_active_session(sess), set_active_connection(conn)
    try:
        return await mt._process_message_to_client(SimpleNamespace(data=json.dumps(message)), None, server_ws)
    finally:
        reset_active_connection(c_token)
        reset_active_session(s_token)


async def _to_server(mt, sess, conn, message: dict):
    s_token, c_token = set_active_session(sess), set_active_connection(conn)
    try:
        return await mt._process_message_to_server(SimpleNamespace(data=json.dumps(message)), None)
    finally:
        reset_active_connection(c_token)
        reset_active_session(s_token)


# ── pure helpers ────────────────────────────────────────────────────────────

def test_only_an_incomplete_max_output_tokens_ending_is_a_cut_off():
    assert cut_off_by_token_limit(CUT_OFF)
    assert not cut_off_by_token_limit(_done())
    assert not cut_off_by_token_limit(_done("cancelled", "client_cancelled"))
    assert not cut_off_by_token_limit(_done("incomplete", "content_filter"))
    assert not cut_off_by_token_limit({"type": "response.done"})


def test_summary_names_status_reason_and_tokens():
    line = response_end_summary(CUT_OFF)
    assert "status=incomplete" in line and "reason=max_output_tokens" in line
    assert "output_tokens=4096" in line and "audio=4076" in line
    assert response_end_summary({"type": "response.done"}).startswith("status=None")


# ── middle tier ─────────────────────────────────────────────────────────────

async def test_report_cue_is_remembered_on_the_connection(rtmt):
    sess, conn = _sess(), ConnectionState()
    out = json.loads(await _to_server(rtmt, sess, conn, {"type": "report.cue", "cue": "report_explain"}))
    assert out["type"] == "response.create"
    assert conn.report_cue is not None and conn.report_cue["sections"]
    assert conn.report_auto_continues == 0


async def test_cut_off_report_is_continued_then_bounded(rtmt):
    sess, conn, ws = _sess(), ConnectionState(report_cue=_REPORT), FakeServerWs()
    for i in range(MAX_AUTO_CONTINUES):
        await _to_client(rtmt, sess, conn, ws, CUT_OFF)
        assert len(ws.sent) == i + 1
        sent = ws.sent[-1]
        assert sent["type"] == "response.create" and sent["response"]["tool_choice"] == "none"
        assert "cut off part-way by a length limit" in sent["response"]["instructions"]
    await _to_client(rtmt, sess, conn, ws, CUT_OFF)  # limit reached: give up, close the report
    assert len(ws.sent) == MAX_AUTO_CONTINUES
    assert conn.report_cue is None


@pytest.mark.parametrize("ending", [_done(), _done("cancelled", "client_cancelled"),
                                    _done("incomplete", "content_filter")])
async def test_any_other_ending_closes_the_report_without_continuing(rtmt, ending):
    sess, conn, ws = _sess(), ConnectionState(report_cue=_REPORT), FakeServerWs()
    await _to_client(rtmt, sess, conn, ws, ending)
    assert ws.sent == [] and conn.report_cue is None
    await _to_client(rtmt, sess, conn, ws, CUT_OFF)  # a later (Q&A) reply cut off: not continued
    assert ws.sent == []


async def test_ordinary_reply_cut_off_is_not_continued(rtmt):
    sess, conn, ws = _sess(), ConnectionState(), FakeServerWs()
    await _to_client(rtmt, sess, conn, ws, CUT_OFF)
    assert ws.sent == []
