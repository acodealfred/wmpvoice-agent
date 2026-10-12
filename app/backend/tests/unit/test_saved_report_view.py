"""Saved report view (ciq.reports.saved_routes.saved_report_view) — pure parts."""
import json

from ciq.reports.saved_routes import saved_report_view

ANSWER = {"score": 4, "domain": "Exhaustion", "userResponse": "Often", "voiceSentiment": "neutral",
          "blinkRateChange": 12, "leftGazePosition": "Center", "rightGazePosition": "Left",
          "responseLatencyMs": 1800}


def _record(survey_type, technical, results=None, prompt_info=None):
    return {
        "survey_run_id": "run-1234abcd",
        "survey_type": survey_type,
        "created_at": "2026-10-10T02:15:00",
        "survey_results": json.dumps(results if results is not None else {"q1": ANSWER, "q2": {**ANSWER, "score": 2}}),
        "technical_report": json.dumps(technical),
        "prompt_info": json.dumps(prompt_info or {}),
    }


def test_flat_report_rebuilds_snapshots_in_order_and_adds_max_score():
    technical = {"analysis": {"patterns": []}, "totalScore": 6, "riskLevel": "Low",
                 "interpretation": "Low text.", "domainTotals": {"Exhaustion": 6}}
    view = saved_report_view(_record("TEST", technical))

    assert view["surveyRunId"] == "run-1234abcd"
    assert view["surveyType"] == "TEST"
    assert view["createdAt"] == "2026-10-10T02:15:00"
    assert [s["questionId"] for s in view["snapshots"]] == ["q1", "q2"]
    assert view["snapshots"][0] == {"questionId": "q1", **ANSWER}
    # TEST answers top out at 5 → 2 answers x 5.
    assert view["report"] == {"totalScore": 6, "maxScore": 10, "riskLevel": "Low",
                              "interpretation": "Low text.", "domainTotals": {"Exhaustion": 6}}


def test_sections_report_has_no_combined_max():
    sections = [{"id": "bat4", "label": "BAT-4", "score": 3.0, "scoreRange": [1, 5],
                 "riskLevel": "Moderate", "interpretation": "BAT text."}]
    view = saved_report_view(_record("PILOT", {"analysis": {}, "sections": sections, "domainTotals": {}}))

    assert view["report"] == {"sections": sections, "domainTotals": {}}


def test_ai_insights_are_never_returned():
    technical = {"analysis": {"patterns": [{"insight": "AI text"}]}, "totalScore": 6, "riskLevel": "Low"}
    view = saved_report_view(_record("TEST", technical, prompt_info={"agentResponse": "AI summary"}))

    assert "analysis" not in view["report"]
    assert "AI" not in json.dumps(view)


def test_missing_or_broken_data_gives_none():
    technical = {"totalScore": 6, "riskLevel": "Low"}
    assert saved_report_view(_record("TEST", technical, results={})) is None
    assert saved_report_view({**_record("TEST", technical), "technical_report": None}) is None
    assert saved_report_view({**_record("TEST", technical), "survey_results": "not json"}) is None
