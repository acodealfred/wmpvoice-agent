"""SURVEY RESPONSES / SURVEY TOTAL blocks appended to the timeline + combined CSV exports."""
import json

from ciq.api.history_routes import _SURVEY_RESPONSES_HEADERS, build_survey_summary_rows


def _record(survey_type: str, results: dict) -> dict:
    return {"survey_type": survey_type, "survey_results": json.dumps(results)}


def _block(rows: list[list], title: str) -> list[list]:
    """Rows between a block's title row and the next blank row (header included)."""
    start = rows.index([title]) + 1
    end = next((i for i in range(start, len(rows)) if rows[i] == []), len(rows))
    return rows[start:end]


def test_no_record_adds_nothing():
    assert build_survey_summary_rows(None) == []


def test_test_survey_responses_and_total():
    results = {
        "q1": {"score": 4, "domain": "Emotional Exhaustion", "userResponse": "Most days"},
        "q2": {"score": 3, "domain": "Depersonalization", "userResponse": "Sometimes"},
        "q3": {"score": 4, "domain": "Personal Accomplishment", "userResponse": "Pretty confident"},
        "q4": {"score": 4, "domain": "Physical", "userResponse": "Often"},
        "q5": {"score": 2, "domain": "Engagement", "userResponse": "Rarely"},
    }
    rows = build_survey_summary_rows(_record("TEST", results))

    assert rows[0] == []  # blank separator after the per-second rows
    responses = _block(rows, "SURVEY RESPONSES")
    assert responses[0] == _SURVEY_RESPONSES_HEADERS
    q1 = responses[1]
    assert q1[:2] == [1, "q1"]
    assert q1[3] == "How often do you feel emotionally exhausted at the end of a work day?"
    assert q1[4:] == ["Most days", 4, 4]
    # q3 is a reverse item on 1-5: raw 4 -> effective 2.
    assert responses[3][5:] == [4, 2]

    total = _block(rows, "SURVEY TOTAL")
    assert total[0] == ["survey_type", "total_score", "max_score", "risk_level"]
    # 4 + 3 + 2 (q3 reversed) + 4 + 4 (q5 reversed: 6 - 2) = 17
    assert total[1][:3] == ["TEST", 17, 25]


def test_unanswered_question_is_listed_blank():
    rows = build_survey_summary_rows(_record("TEST", {"q1": {"score": 4, "userResponse": "Yes"}}))
    responses = _block(rows, "SURVEY RESPONSES")
    assert len(responses) == 1 + 5  # header + every question in the survey
    assert responses[2][4:] == ["", "", ""]


def test_pilot_has_one_total_row_per_section():
    results = {qid: {"score": 3} for qid in ("bat_q1", "bat_q2", "bat_q3", "bat_q4")}
    results.update({"cbi_q1": {"score": 75}, "cbi_q2": {"score": 50}, "cbi_q3": {"score": 25}})
    total = _block(build_survey_summary_rows(_record("PILOT", results)), "SURVEY TOTAL")

    assert total[0] == ["survey_type", "section", "score", "score_range", "risk_level"]
    assert [r[1] for r in total[1:]] == ["BAT-4", "CBI-WRB3"]
    assert total[1][2:4] == [3.0, "1-5"]
    # cbi_q3 is reversed on 0-100: 25 -> 75, so avg(75, 50, 75) = 66.7.
    assert total[2][2:4] == [66.7, "0-100"]


def test_readiness_keeps_answers_with_blank_scores():
    rows = build_survey_summary_rows(
        _record("READINESS", {"readiness_q1": {"score": None, "userResponse": "Busy but manageable"}})
    )
    responses = _block(rows, "SURVEY RESPONSES")
    assert len(responses) == 1 + 5  # no stray rows for unknown ids
    assert responses[1][1] == "readiness_q1"
    assert responses[1][4] == "Busy but manageable"
    assert all(r[5:] == ["", ""] for r in responses[1:])
    assert _block(rows, "SURVEY TOTAL")[1] == ["READINESS", "", "", ""]
