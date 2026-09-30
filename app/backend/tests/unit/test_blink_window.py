"""Blink-rate accuracy: per-question windows, history handling, interpreter fallback."""
import asyncio
import json

from biometric_interpreter import BiometricInterpreter
from ciq.realtime.session import SessionState
from ciq.realtime.tools.handlers import survey_tool
from ciq.realtime.tools.schemas import SURVEY_SCHEMA


def _survey_session() -> SessionState:
    sess = SessionState(session_id="s1")
    sess.survey_phase = "survey"
    return sess


def test_question_window_uses_only_that_questions_blinks():
    sess = _survey_session()
    # Window opens at the first update in the survey phase.
    sess.update_blink_totals(40, 120_000, baseline_bpm=15.0)
    # Q1: 6 blinks in 20 s -> 18 bpm -> +20% vs 15.
    sess.update_blink_totals(46, 140_000, baseline_bpm=15.0)
    assert round(sess.take_question_blink_change(), 1) == 20.0
    # Q2: 3 blinks in 20 s -> 9 bpm -> -40%. The Q1 blinks must not leak in.
    sess.update_blink_totals(49, 160_000, baseline_bpm=15.0)
    assert round(sess.take_question_blink_change(), 1) == -40.0


def test_zero_blinks_is_minus_100_not_missing():
    sess = _survey_session()
    sess.update_blink_totals(10, 50_000, baseline_bpm=12.0)
    sess.update_blink_totals(10, 70_000, baseline_bpm=12.0)
    assert sess.take_question_blink_change() == -100.0


def test_short_window_returns_none_and_still_advances():
    sess = _survey_session()
    sess.update_blink_totals(0, 0, baseline_bpm=15.0)
    sess.update_blink_totals(2, 5_000, baseline_bpm=15.0)
    assert sess.take_question_blink_change() is None
    # Next window starts from where the short one ended.
    sess.update_blink_totals(8, 25_000, baseline_bpm=15.0)
    assert round(sess.take_question_blink_change(), 1) == 20.0


def test_no_window_before_survey_phase():
    sess = SessionState(session_id="s1")  # still "baseline"
    sess.update_blink_totals(30, 180_000, baseline_bpm=15.0)
    assert sess.blink_question_mark is None


def test_totals_going_backwards_reopens_window():
    sess = _survey_session()
    sess.update_blink_totals(50, 200_000, baseline_bpm=15.0)
    sess.update_blink_totals(0, 0, baseline_bpm=15.0)  # browser restarted analysis
    sess.update_blink_totals(5, 20_000, baseline_bpm=15.0)
    assert round(sess.take_question_blink_change(), 1) == 0.0


def test_missing_readings_are_skipped_but_real_zero_kept():
    sess = SessionState(session_id="s1")
    sess.update_biometric_history(None, "NEUTRAL")
    sess.update_biometric_history(0.0, "NEUTRAL")
    sess.update_biometric_history(40.0, "NEUTRAL")
    assert sess.blink_rate_history == [0.0, 40.0]
    assert sess.average_blink_rate_change() == 20.0


def test_survey_tool_ignores_model_supplied_blink_value():
    sess = _survey_session()
    sess.update_blink_totals(0, 0, baseline_bpm=15.0)
    sess.update_blink_totals(5, 20_000, baseline_bpm=15.0)  # 15 bpm -> 0%
    config = {"questions": [{"id": "q1"}, {"id": "q2"}]}
    asyncio.run(survey_tool(sess, config, {"question_id": "q1", "score": 3, "blink_rate_change_percent": 99.0}))
    assert sess.survey_results["q1"]["blink_rate_change_percent"] == 0.0


def test_schema_no_longer_asks_model_for_blink():
    assert "blink_rate_change_percent" not in json.dumps(SURVEY_SCHEMA)


def test_interpreter_uses_absolute_thresholds_without_baseline():
    interp = BiometricInterpreter()
    assert interp.analyze_blink_rate(40).state == "stressed"
    assert BiometricInterpreter().analyze_blink_rate(10).state == "relaxed"
    assert BiometricInterpreter().analyze_blink_rate(30).state == "normal"


def test_interpreter_uses_baseline_when_set():
    interp = BiometricInterpreter()
    interp.set_baseline_blink_rate(10)
    result = interp.analyze_blink_rate(14)
    assert result.state == "stressed"
    assert round(result.blink_rate_change_percent) == 40
