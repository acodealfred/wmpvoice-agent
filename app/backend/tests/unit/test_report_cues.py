"""PILOT report screen cues (report.cue → report_cue_instructions) — Start / Continue."""
import json

from ciq.prompts.builder import REPORT_CUE_NAMES, report_cue_instructions
from ciq.realtime.session import SessionState
from ciq.realtime.tools.handlers import query_survey_tool
from survey_loader import load_survey

PILOT = load_survey("PILOT")
TEST = load_survey("TEST")

_IDS = ["bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]


async def _pilot_report() -> dict:
    """The burnout_score result the middle tier computes at cue time."""
    sess = SessionState(session_id="s", survey_config=PILOT)
    scores = [3, 3, 3, 3, 50, 50, 50]
    sess.survey_results = {
        qid: {"score": s, "blink_rate_change_percent": 0.0, "pupil_mm_change": 0.0, "response_latency_ms": None}
        for qid, s in zip(_IDS, scores, strict=True)
    }
    return json.loads((await query_survey_tool(sess, PILOT, {"query_type": "burnout_score"})).to_text())


async def test_explain_carries_every_interpretation_and_spoken_line():
    report = await _pilot_report()
    text = report_cue_instructions("report_explain", report)
    assert "from the beginning" in text
    for section in report["sections"]:
        assert section["interpretation"] in text
    for part in report["spoken_report"]["parts"]:
        assert part["title"] in text
        for line in part["say"]:
            assert line in text


async def test_continue_resumes_without_repeating():
    report = await _pilot_report()
    text = report_cue_instructions("report_continue", report)
    assert "do NOT repeat" in text
    assert "from the beginning" not in text
    assert report["sections"][0]["interpretation"] in text   # full content kept for reference


async def test_unknown_cue_or_no_results_is_ignored():
    report = await _pilot_report()
    assert report_cue_instructions("report_bogus", report) is None
    assert report_cue_instructions("report_explain", {"error": "No survey results available."}) is None


def test_missing_spoken_report_falls_back_to_interpretations_only():
    text = report_cue_instructions("report_explain", {"sections": [{"label": "BAT-4", "interpretation": "Low."}]})
    assert "BAT-4: Low." in text
    assert "SPOKEN REPORT (STEP 4): none — go straight to the closing invitation." in text


def test_cue_names():
    assert REPORT_CUE_NAMES == {"report_explain", "report_continue"}


ZONE_LINES = [
    "Overall, your strain is in the mild zone.",
    "It leans towards fatigue — mostly tiredness, which rest and recovery are likely to help.",
    "This is your first check-in, so your trend starts from here.",
    "This zone is a wellbeing guide, not a diagnosis.",
]


async def test_zone_is_step_2_between_results_and_spoken_report():
    report = {**await _pilot_report(), "zone_lines": ZONE_LINES}
    for cue in ("report_explain", "report_continue"):
        text = report_cue_instructions(cue, report)
        for line in ZONE_LINES:
            assert line in text
        results, zone, spoken = (
            text.index("INTERPRETATIONS (STEP 1)"),
            text.index("FATIGUE ↔ BURNOUT ZONE (STEP 2)"),
            text.index("SPOKEN REPORT (STEP 4)"),
        )
        assert results < zone < spoken


async def test_zone_step_is_skipped_without_lines():
    text = report_cue_instructions("report_explain", {**await _pilot_report(), "zone_lines": []})
    assert "FATIGUE ↔ BURNOUT ZONE (STEP 2):" not in text
    assert "SPOKEN REPORT (STEP 4)" in text
    assert "skip this step silently" in text


COMPARISON_LINES = [
    "Since your last assessment a few weeks ago, your BAT-4 result has improved, moving from high to moderate.",
    "Your CBI-WRB3 result is about the same as last time.",
]


async def test_comparison_is_step_3_right_after_the_zone():
    report = {**await _pilot_report(), "zone_lines": ZONE_LINES, "comparison_lines": COMPARISON_LINES}
    for cue in ("report_explain", "report_continue"):
        text = report_cue_instructions(cue, report)
        for line in COMPARISON_LINES:
            assert line in text
        zone, comparison, spoken = (
            text.index("FATIGUE ↔ BURNOUT ZONE (STEP 2)"),
            text.index("SINCE YOUR LAST ASSESSMENT (STEP 3):"),
            text.index("SPOKEN REPORT (STEP 4)"),
        )
        assert zone < comparison < spoken


async def test_first_assessment_skips_the_comparison_silently():
    text = report_cue_instructions("report_explain", {**await _pilot_report(), "zone_lines": ZONE_LINES, "comparison_lines": []})
    assert "SINCE YOUR LAST ASSESSMENT (STEP 3):" not in text
    assert "do not mention a previous assessment" in text
