"""ciq/realtime/report_signals.py — the voice report's signal lines (STEP 4)."""
import logging
from types import SimpleNamespace

import pytest

from ciq.realtime import report_signals
from survey_loader import load_survey

PILOT = load_survey("PILOT")

_RESULT = {
    "referenceCount": 1,
    "questions": [{
        "questionId": "bat_q1",
        "prompt": "At work, I feel mentally exhausted.",
        "status": "changed",
        "answer": {"previousLabel": "Rarely", "currentLabel": "Often", "previousValue": 2, "currentValue": 4, "changed": True},
        "surfacedBy": "strong",
        "signals": [{"id": "latency", "direction": "shorter", "tier": "strong", "reference": "past",
                     "today": 900, "past": 2400, "delta": -62.5, "unit": "%", "todaySupport": None}],
    }],
}


def _sess(survey_type="PILOT", run_id="cur"):
    config = PILOT if survey_type == "PILOT" else {"type": survey_type}
    return SimpleNamespace(user_id="u1", survey_run_id=run_id, survey_config=config)


@pytest.fixture
def loader(monkeypatch):
    calls = []
    state = {"result": _RESULT}

    async def fake(user_id, run_id):
        calls.append((user_id, run_id))  # always the session's own user and run
        return state["result"]

    monkeypatch.setattr(report_signals, "load_signal_comparison", fake)
    return SimpleNamespace(calls=calls, state=state)


async def test_lines_for_the_sessions_own_run(loader):
    assert await report_signals.report_signal_lines(_sess()) == [
        "Compared with your last check-in, here's what was recorded while you were answering.",
        "On feeling mentally exhausted at work, you said often this time, where last time you said rarely; "
        "while you answered, you answered notably more quickly.",
    ]
    assert loader.calls == [("u1", "cur")]


async def test_other_types_missing_run_and_nothing_to_say_are_silent(loader):
    assert await report_signals.report_signal_lines(_sess("BATFULL")) == []
    assert await report_signals.report_signal_lines(_sess(run_id=None)) == []
    assert loader.calls == []  # neither even loads
    loader.state["result"] = None  # first check-in / switched off / nothing comparable
    assert await report_signals.report_signal_lines(_sess()) == []


async def test_errors_are_silent_and_logged(monkeypatch, caplog):
    async def boom(*_):
        raise RuntimeError("db down")

    monkeypatch.setattr(report_signals, "load_signal_comparison", boom)
    with caplog.at_level(logging.ERROR, logger="voicerag"):
        assert await report_signals.report_signal_lines(_sess()) == []
    assert "[Signals]" in caplog.text
