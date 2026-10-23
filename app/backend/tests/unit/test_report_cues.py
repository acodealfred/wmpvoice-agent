"""PILOT report screen cues (report.cue → report_cue_instructions) — Start / Continue."""
import json

from ciq.prompts.builder import (
    REPORT_AUTO_CONTINUE,
    REPORT_CUE_NAMES,
    report_cue_instructions,
)
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


async def test_explain_carries_every_spoken_line_but_not_the_on_screen_interpretations():
    report = await _pilot_report()
    text = report_cue_instructions("report_explain", report)
    assert "from the beginning" in text
    for section in report["sections"]:
        assert section["interpretation"] not in text  # already on screen — never read out
    assert "do NOT read out the scores" in text
    for part in report["spoken_report"]["parts"]:
        assert part["title"] in text
        for line in part["say"]:
            assert line in text


async def test_continue_resumes_without_repeating():
    report = await _pilot_report()
    text = report_cue_instructions("report_continue", report)
    assert "do NOT repeat" in text
    assert "from the beginning" not in text
    assert report["spoken_report"]["parts"][0]["say"][0] in text   # full content kept for reference


async def test_unknown_cue_or_no_results_is_ignored():
    report = await _pilot_report()
    assert report_cue_instructions("report_bogus", report) is None
    assert report_cue_instructions("report_explain", {"error": "No survey results available."}) is None


def test_missing_spoken_report_falls_back_to_interpretations_only():
    text = report_cue_instructions("report_explain", {"sections": [{"label": "BAT-4", "interpretation": "Low."}]})
    assert "BAT-4: Low." not in text  # interpretations are on screen, never read out
    assert "WHERE YOUR ANSWERS POINT (SECTION 4): none — go straight to the closing invitation." in text


def test_cue_names():
    assert REPORT_CUE_NAMES == {"report_explain", "report_continue"}


ZONE_LINES = [
    "Overall, your strain is in the mild zone.",
    "It leans towards fatigue — mostly tiredness, which rest and recovery are likely to help.",
    "This is your first check-in, so your trend starts from here.",
    "This zone is a wellbeing guide, not a diagnosis.",
]

COMPARISON_LINES = [
    "Since your last assessment a few weeks ago, your BAT-4 result has improved, moving from high to moderate.",
    "Your CBI-WRB3 result is about the same as last time.",
]

SIGNAL_LINES = [
    "Now let's go through the questions one at a time, each compared with your last check-in.",
    "On feeling mentally exhausted at work, your answer matched last time, but while you answered, "
    "your reply came notably more quickly than usual. That's worth noticing — on this one, your answer "
    "of often may only be part of the picture.",
]

_HEADINGS = ("SINCE YOUR LAST CHECK-IN (SECTION 1):", "THIS ASSESSMENT (SECTION 2):",
             "QUESTION BY QUESTION (SECTION 3):", "WHERE YOUR ANSWERS POINT (SECTION 4):")


async def _full_report() -> dict:
    return {**await _pilot_report(), "zone_lines": ZONE_LINES, "comparison_lines": COMPARISON_LINES,
            "signal_lines": SIGNAL_LINES}


async def test_four_sections_in_the_agreed_order():
    report = await _full_report()
    for cue in ("report_explain", "report_continue"):
        text = report_cue_instructions(cue, report)
        positions = [text.index(h) for h in _HEADINGS]
        assert positions == sorted(positions)
        # The delivery rules name the sections in the same order.
        rules = [text.index(f"SECTION {i} —") for i in range(1, 5)]
        assert rules == sorted(rules)
        for line in COMPARISON_LINES + ZONE_LINES + SIGNAL_LINES:
            assert f"- {line}" in text


async def test_section_1_is_the_comparison_then_the_zone():
    text = report_cue_instructions("report_explain", await _full_report())
    s1, s2 = text.index(_HEADINGS[0]), text.index(_HEADINGS[1])
    assert s1 < text.index(COMPARISON_LINES[0]) < text.index(ZONE_LINES[0]) < s2


async def test_section_2_is_capacity_only():
    report = await _full_report()
    text = report_cue_instructions("report_explain", report)
    s2, s3 = text.index(_HEADINGS[1]), text.index(_HEADINGS[2])
    capacity = report["spoken_report"]["parts"][0]
    assert s2 < text.index(f"* {capacity['title']}") < s3
    for line in capacity["say"]:
        assert s2 < text.index(line) < s3


async def test_section_4_is_domains_then_opportunity_and_unlocks():
    report = await _full_report()
    text = report_cue_instructions("report_explain", report)
    s4 = text.index(_HEADINGS[3])
    domain = text.index(report["spoken_report"]["domain_lines"][0])
    opportunity, unlocks = (text.index(f"* {p['title']}") for p in report["spoken_report"]["parts"][1:])
    assert s4 < domain < opportunity < unlocks


async def test_first_check_in_keeps_the_zone_and_skips_the_comparison_silently():
    text = report_cue_instructions("report_explain", {**await _pilot_report(), "zone_lines": ZONE_LINES})
    assert _HEADINGS[0] in text and ZONE_LINES[0] in text
    assert "do not mention a previous assessment" in " ".join(text.split())
    assert _HEADINGS[2] not in text


async def test_nothing_from_the_past_skips_sections_1_and_3():
    text = report_cue_instructions("report_explain", await _pilot_report())
    assert _HEADINGS[0] not in text and _HEADINGS[2] not in text
    assert _HEADINGS[1] in text and _HEADINGS[3] in text
    assert "skip this section silently" in text
    assert "do not mention signals" in " ".join(text.split())  # the rule wraps across lines


def test_reflections_are_framed_as_invitations_never_verdicts():
    text = " ".join(report_cue_instructions("report_explain", {"sections": [{"label": "x", "interpretation": "y"}]}).split())
    assert "NEVER say or imply the user was wrong, untruthful or inconsistent" in text
    assert "never ask them to change an answer" in text


async def test_auto_continue_is_server_side_and_resumes_without_repeating():
    report = await _full_report()
    assert REPORT_AUTO_CONTINUE not in REPORT_CUE_NAMES  # never a client cue
    text = report_cue_instructions(REPORT_AUTO_CONTINUE, report)
    assert "cut off part-way by a length limit" in text
    assert "Do NOT repeat" in text and "from the beginning" not in text
    assert all(h in text for h in _HEADINGS)  # full content kept for reference


# ── length budget: the explanation is ONE response with an output cap ─────────
# A heavy-but-realistic report must fit in one response (~3 minutes). The extreme case —
# every question notable — may run longer; the middle tier then auto-continues once the
# response is cut off at the cap (ciq.realtime.report_continuation), so it is only bounded.

_SPOKEN_WORD_BUDGET = 450
_EXTREME_WORD_CEILING = 600
_LABELS = {1: "Never", 2: "Rarely", 3: "Sometimes", 4: "Often", 5: "Always"}
_TWO_STRONG = [{"id": "blink", "direction": "higher", "tier": "strong", "today": 40, "past": 0},
               {"id": "latency", "direction": "longer", "tier": "strong", "today": 9000, "past": 2000}]


def _q(qid, status, current, recent, signals=()):
    return {"questionId": qid, "prompt": "p", "status": status, "signals": list(signals),
            "answer": {"changed": current != recent[0], "previousLabel": _LABELS[recent[0]],
                       "currentLabel": _LABELS[current], "currentValue": current, "recentValues": list(recent),
                       "recentLabels": [_LABELS[v] for v in recent]}}


async def _spoken_words(questions) -> int:
    import re

    from ciq.reports.signal_comparison import signal_spoken_lines

    # Longest Section 2: blink, pace and tone all present.
    results = {qid: {"score": s, "blink_rate_change_percent": -25.0, "response_latency_ms": lat,
                     "voice_sentiment": tone}
               for qid, s, lat, tone in zip(_IDS, [5, 5, 4, 5, 100, 100, 0],
                                            [4000, 3800, 3500, 3200, 1500, 1400, 1300],
                                            ["negative"] * 4 + ["neutral"] * 3, strict=True)}
    sess = SessionState(session_id="b", survey_config=PILOT)
    sess.survey_results = results
    report = json.loads((await query_survey_tool(sess, PILOT, {"query_type": "burnout_score"})).to_text())
    report.update(zone_lines=ZONE_LINES, comparison_lines=COMPARISON_LINES,
                  signal_lines=signal_spoken_lines({"referenceCount": 3, "questions": questions}, PILOT))
    content = report_cue_instructions("report_explain", report).split(_HEADINGS[0])[1]
    spoken = [line for line in content.splitlines() if line.lstrip().startswith(("- ", "* "))]
    return len(re.findall(r"[\w']+", " ".join(spoken)))


async def test_heavy_realistic_script_fits_one_response():
    questions = [_q("bat_q1", "changed", 1, (5, 4), _TWO_STRONG),   # notable + answer shift
                 _q("bat_q2", "changed", 4, (4, 4), _TWO_STRONG),
                 _q("bat_q3", "changed", 3, (2, 2), _TWO_STRONG[:1]),
                 _q("bat_q4", "steady", 1, (4, 5)),                  # answer shift only
                 _q("cbi_q1", "steady", 3, (3, 3)), _q("cbi_q2", "steady", 3, (3, 3)),
                 _q("cbi_q3", "no_data", 3, (3, 3))]
    words = await _spoken_words(questions)
    assert words <= _SPOKEN_WORD_BUDGET, words


async def test_extreme_script_stays_bounded():
    words = await _spoken_words([_q(qid, "changed", 1, (5, 4), _TWO_STRONG) for qid in _IDS])
    assert words <= _EXTREME_WORD_CEILING, words
