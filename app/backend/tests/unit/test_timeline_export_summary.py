"""SURVEY RESPONSES / SURVEY TOTAL / BASELINE blocks appended to the timeline + combined CSV exports."""
import json

from ciq.api.history_routes import (
    _BASELINE_HEADERS,
    _SURVEY_RESPONSES_HEADERS,
    build_survey_summary_rows,
)


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
    assert q1[4:7] == ["Most days", 4, 4]
    # q3 is a reverse item on 1-5: raw 4 -> effective 2.
    assert responses[3][5:7] == [4, 2]

    total = _block(rows, "SURVEY TOTAL")
    assert total[0] == ["survey_type", "total_score", "max_score", "risk_level"]
    # 4 + 3 + 2 (q3 reversed) + 4 + 4 (q5 reversed: 6 - 2) = 17
    assert total[1][:3] == ["TEST", 17, 25]


def test_unanswered_question_is_listed_blank():
    rows = build_survey_summary_rows(_record("TEST", {"q1": {"score": 4, "userResponse": "Yes"}}))
    responses = _block(rows, "SURVEY RESPONSES")
    assert len(responses) == 1 + 5  # header + every question in the survey
    assert responses[2][4:7] == ["", "", ""]


def test_pilot_has_one_total_row_per_section():
    results = {qid: {"score": 3} for qid in ("bat_q1", "bat_q2", "bat_q3", "bat_q4")}
    results.update({"cbi_q1": {"score": 75}, "cbi_q2": {"score": 50}, "cbi_q3": {"score": 25}})
    total = _block(build_survey_summary_rows(_record("PILOT", results)), "SURVEY TOTAL")

    assert total[0] == ["survey_type", "section", "score", "score_range", "risk_level"]
    assert [r[1] for r in total[1:]] == ["BAT-4", "CBI-WRB3"]
    assert total[1][2:4] == [3.0, "1-5"]
    # cbi_q3 is reversed on 0-100: 25 -> 75, so avg(75, 50, 75) = 66.7.
    assert total[2][2:4] == [66.7, "0-100"]


def test_baseline_block_ties_the_run_to_its_baseline_segment():
    record = {**_record("TEST", {"q1": {"score": 4}}), "survey_run_id": "run-1", "status": "completed",
              "baseline_blink_rate": 16.5, "baseline_completed_at": "2026-01-01T09:06:00",
              "baseline_segment_index": 1}
    block = _block(build_survey_summary_rows(record), "BASELINE")
    assert block == [_BASELINE_HEADERS, ["run-1", "completed", 16.5, "2026-01-01T09:06:00", 1]]


def test_run_without_a_baseline_says_so():
    record = {**_record("TEST", {}), "survey_run_id": "run-1", "status": "closed"}
    assert _block(build_survey_summary_rows(record), "BASELINE")[1] == ["run-1", "closed", "no baseline recorded", "", ""]


def test_partial_run_takes_its_answers_from_the_item_rows():
    record = {**_record("TEST", {}), "survey_results": None, "status": "closed"}
    item_rows = [{"question_id": "q1", "raw_score": 4, "domain": "Emotional Exhaustion", "user_response": "Most days"}]
    responses = _block(build_survey_summary_rows(record, item_rows), "SURVEY RESPONSES")
    assert responses[1][:2] == [1, "q1"]
    assert responses[1][4:7] == ["Most days", 4, 4]
    assert responses[2][4:7] == ["", "", ""]  # q2 not answered before it was closed


def test_readiness_keeps_answers_with_blank_scores():
    rows = build_survey_summary_rows(
        _record("READINESS", {"readiness_q1": {"score": None, "userResponse": "Busy but manageable"}})
    )
    responses = _block(rows, "SURVEY RESPONSES")
    assert len(responses) == 1 + 5  # no stray rows for unknown ids
    assert responses[1][1] == "readiness_q1"
    assert responses[1][4] == "Busy but manageable"
    assert all(r[5:7] == ["", ""] for r in responses[1:])
    assert _block(rows, "SURVEY TOTAL")[1] == ["READINESS", "", "", ""]


def test_voice_summary_columns_follow_the_scores():
    """Per-answer voice acoustics (ciq.voice) come from the item rows; blank when not measured."""
    from ciq.api.history_routes import _SURVEY_RESPONSES_HEADERS
    from ciq.voice.keys import ANSWER_FEATURE_KEYS

    record = {"survey_run_id": "run-1", "survey_type": "TEST", "status": "closed", "survey_results": None}
    items = [{"question_id": "q1", "raw_score": 4, "domain": "", "user_response": "Most days",
              "voice_pitch_mean_hz": 182.5, "voice_pause_count": 2}]
    responses = _block(build_survey_summary_rows(record, items), "SURVEY RESPONSES")
    assert responses[0] == _SURVEY_RESPONSES_HEADERS
    q1 = dict(zip(_SURVEY_RESPONSES_HEADERS, responses[1]))
    assert (q1["voice_pitch_mean_hz"], q1["voice_pause_count"]) == (182.5, 2)
    assert q1["voice_speech_ms"] == ""                       # not measured → blank
    assert all(v == "" for v in responses[2][7:7 + len(ANSWER_FEATURE_KEYS)])  # unanswered q2
