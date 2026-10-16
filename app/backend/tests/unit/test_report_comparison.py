"""ciq/reports/comparison.py — comparing a run with the previous same-type run."""
import json
import re

from ciq.reports.comparison import (
    compare_runs,
    comparison_spoken_lines,
    previous_same_type_run,
)

PILOT = {"type": "PILOT", "scoringSections": [{"id": "bat4"}, {"id": "cbi_wrb3"}]}
BAT = {"type": "BATFULL", "name": "BAT", "options": [{"value": 1}, {"value": 5}], "thresholds": {}}


def _pilot(run_id, created, bat, bat_risk, cbi, cbi_risk, **extra):
    return {
        "survey_run_id": run_id, "survey_type": "PILOT", "created_at": created,
        "technical_report": json.dumps({"sections": [
            {"id": "bat4", "label": "BAT-4", "score": bat, "scoreRange": [1, 5], "riskLevel": bat_risk},
            {"id": "cbi_wrb3", "label": "CBI-WRB3", "score": cbi, "scoreRange": [0, 100], "riskLevel": cbi_risk},
        ]}),
        **extra,
    }


def _bat(run_id, created, total, risk, answers=4):
    return {
        "survey_run_id": run_id, "survey_type": "BATFULL", "created_at": created,
        "survey_results": json.dumps({f"q{i}": {"score": 1} for i in range(answers)}),
        "technical_report": json.dumps({"totalScore": total, "riskLevel": risk}),
    }


def test_previous_run_is_latest_earlier_same_type_non_demo():
    cur = _pilot("c", "2026-10-15T10:00:00", 2.0, "Low", 40, "Low")
    older = _pilot("o", "2026-09-01T10:00:00", 3.5, "High", 60, "Moderate")
    newer_prev = _pilot("p", "2026-10-01T10:00:00", 3.0, "Moderate", 50, "Moderate")
    demo = _pilot("d", "2026-10-10T10:00:00", 1.0, "Low", 0, "Low", is_demo=1)
    other_type = _bat("b", "2026-10-12T10:00:00", 10, "Low")
    later = _pilot("l", "2026-10-16T10:00:00", 1.0, "Low", 0, "Low")
    records = [later, cur, other_type, demo, newer_prev, older]
    assert previous_same_type_run(records, cur)["survey_run_id"] == "p"


def test_first_assessment_has_nothing_to_compare():
    cur = _pilot("c", "2026-10-15T10:00:00", 2.0, "Low", 40, "Low")
    assert previous_same_type_run([cur], cur) is None
    assert compare_runs(cur, None, PILOT) is None
    assert comparison_spoken_lines(None) == []


def test_sections_improved_same_worse_with_risk_change():
    prev = _pilot("p", "2026-10-01T10:00:00", 3.5, "High", 50, "Moderate")
    cur = _pilot("c", "2026-10-15T10:00:00", 2.5, "Moderate", 52, "Moderate")
    result = compare_runs(cur, prev, PILOT)
    bat, cbi = result["measures"]
    assert (bat["direction"], bat["delta"], bat["previousRisk"], bat["currentRisk"]) == ("improved", -1.0, "High", "Moderate")
    assert cbi["direction"] == "same"  # 2 of 100 is under 5% of the range
    assert result["daysBetween"] == 14

    worse = compare_runs(_pilot("c", "2026-10-15", 4.5, "High", 90, "High"), prev, PILOT)
    assert [m["direction"] for m in worse["measures"]] == ["worse", "worse"]


def test_sections_only_compared_when_both_runs_have_them():
    prev = _pilot("p", "2026-10-01", 3.0, "Moderate", 50, "Moderate")
    prev_tr = json.loads(prev["technical_report"])
    prev_tr["sections"] = prev_tr["sections"][:1]  # older survey version without CBI
    prev["technical_report"] = json.dumps(prev_tr)
    result = compare_runs(_pilot("c", "2026-10-15", 2.0, "Low", 40, "Low"), prev, PILOT)
    assert [m["id"] for m in result["measures"]] == ["bat4"]


def test_total_score_survey():
    result = compare_runs(_bat("c", "2026-10-15", 8, "Low"), _bat("p", "2026-10-01", 16, "Moderate"), BAT)
    (m,) = result["measures"]
    assert (m["id"], m["direction"], m["scoreRange"]) == ("total", "improved", [4, 20])
    # Different number of answers → not comparable.
    assert compare_runs(_bat("c", "2026-10-15", 8, "Low"), _bat("p", "2026-10-01", 16, "Low", answers=6), BAT) is None


def test_qualitative_survey_is_never_compared():
    assert compare_runs(_bat("c", "2026-10-15", 8, "Low"), _bat("p", "2026-10-01", 16, "Low"), {"qualitative": True}) is None


def test_spoken_lines_have_no_numbers_and_say_since_last_assessment():
    prev = _pilot("p", "2026-10-01T10:00:00", 3.5, "High", 50, "Moderate")
    cur = _pilot("c", "2026-10-15T10:00:00", 2.5, "Moderate", 80, "High")
    lines = comparison_spoken_lines(compare_runs(cur, prev, PILOT))
    assert lines == [
        "Since your last assessment a few weeks ago, your BAT-4 result has improved, moving from high to moderate.",
        "Your CBI-WRB3 result has gone up, moving from moderate to high.",
    ]
    # Labels like "BAT-4" carry digits; nothing else may.
    assert not any(re.search(r"\d", line.replace("BAT-4", "").replace("CBI-WRB3", "")) for line in lines)
