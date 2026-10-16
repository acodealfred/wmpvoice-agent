"""ciq/realtime/report_comparison.py — the voice report's comparison lines."""
import json
from types import SimpleNamespace

import pytest

from ciq.realtime import report_comparison


def _run(run_id, created, bat, risk):
    return {
        "survey_run_id": run_id, "survey_type": "PILOT", "created_at": created,
        "technical_report": json.dumps({"sections": [
            {"id": "bat4", "label": "BAT-4", "score": bat, "scoreRange": [1, 5], "riskLevel": risk},
        ]}),
    }


def _sess(survey_type="PILOT"):
    return SimpleNamespace(user_id="u1", survey_run_id="cur", survey_config={"type": survey_type})


@pytest.fixture
def records(monkeypatch):
    rows = []

    async def fake(user_id):
        assert user_id == "u1"  # always the session's own user
        return rows

    monkeypatch.setattr(report_comparison, "get_user_survey_records", fake)
    return rows


async def test_lines_for_a_second_pilot_run(records):
    records += [_run("cur", "2026-10-15T09:00:00", 2.0, "Low"), _run("old", "2026-10-14T09:00:00", 3.5, "High")]
    assert await report_comparison.report_comparison_lines(_sess()) == [
        "Since your last assessment yesterday, your BAT-4 result has improved, moving from high to low.",
    ]


async def test_first_run_other_types_and_errors_are_silent(records, monkeypatch):
    records.append(_run("cur", "2026-10-15T09:00:00", 2.0, "Low"))
    assert await report_comparison.report_comparison_lines(_sess()) == []
    assert await report_comparison.report_comparison_lines(_sess("BATFULL")) == []

    async def boom(_):
        raise RuntimeError("db down")

    monkeypatch.setattr(report_comparison, "get_user_survey_records", boom)
    assert await report_comparison.report_comparison_lines(_sess()) == []
