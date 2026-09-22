"""PILOT spoken (verbal) report — dynamic framing/signals, tool wiring, prompt scoping."""
import json

from ciq.prompts.builder import conversation_state_instructions, survey_instructions
from ciq.realtime.session import SessionState
from ciq.realtime.spoken_report import (
    FRAMING_DRIVING_FORWARD,
    FRAMING_RUNNING_LOW,
    FRAMING_STEADY,
    TITLE_CAPACITY,
    TITLE_OPPORTUNITY,
    TITLE_UNLOCKS,
    build_pilot_spoken_report,
)
from ciq.realtime.tools.handlers import query_survey_tool
from survey_loader import load_survey

PILOT = load_survey("PILOT")
TEST = load_survey("TEST")

# bat_q1-4 (1-5) then cbi_q1-3 (0/25/50/75/100; cbi_q3 is a reverse item)
_IDS = ["bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]


def _results(bat, cbi, blink=None, pupil=None, latency=None):
    """survey_results in question order. blink/pupil/latency are 7-long lists (or None)."""
    scores = list(bat) + list(cbi)
    out = {}
    for i, qid in enumerate(_IDS):
        out[qid] = {
            "score": scores[i],
            "blink_rate_change_percent": blink[i] if blink else 0.0,
            "pupil_mm_change": pupil[i] if pupil else 0.0,
            "response_latency_ms": latency[i] if latency else None,
        }
    return out


LOW_BAT, LOW_CBI = [1, 2, 1, 2], [25, 25, 75]        # BAT 1.5 (Low), CBI ~ low (cbi_q3 reversed)
MOD_BAT, MOD_CBI = [3, 3, 3, 3], [50, 50, 50]        # BAT 3.0 (Moderate)
HIGH_BAT, HIGH_CBI = [5, 5, 4, 5], [100, 100, 0]     # both High

FOCUSED_BLINK = [-25.0] * 7
ELEVATED_PUPIL = [0.25] * 7
QUICKENING = [4000, 3800, 3500, 3200, 1500, 1400, 1300]


def _text(report):
    return report["plain_text"]


# ── framing ───────────────────────────────────────────────────────────────

def test_driving_forward_follows_the_sample_when_signals_line_up():
    r = build_pilot_spoken_report(
        PILOT, _results(LOW_BAT, LOW_CBI, FOCUSED_BLINK, ELEVATED_PUPIL, QUICKENING)
    )
    assert r["framing"] == FRAMING_DRIVING_FORWARD
    assert [p["title"] for p in r["parts"]] == [TITLE_CAPACITY, TITLE_OPPORTUNITY, TITLE_UNLOCKS]
    capacity = r["parts"][0]["say"]
    assert "someone in motion" in capacity[0]
    assert capacity[1] == "That drive shows up across a few signals:"
    assert any(s.startswith("Blink rate ran below your baseline") for s in capacity)
    assert any(s.startswith("Pupil dilation stayed elevated through the later part") for s in capacity)
    assert any("shorter pauses" in s for s in capacity)
    assert "None of this is a warning sign." in capacity[-1]
    assert "same drive, with more behind it" in r["parts"][1]["say"][0]


def test_warning_sign_line_is_only_said_when_every_subscale_is_low():
    moderate = build_pilot_spoken_report(
        PILOT, _results(MOD_BAT, MOD_CBI, FOCUSED_BLINK, ELEVATED_PUPIL, QUICKENING)
    )
    assert moderate["framing"] == FRAMING_DRIVING_FORWARD
    assert "warning sign" not in _text(moderate)
    assert "None of this is a diagnosis." in _text(moderate)


def test_high_risk_gets_running_low_and_never_reassures():
    r = build_pilot_spoken_report(
        PILOT, _results(HIGH_BAT, HIGH_CBI, FOCUSED_BLINK, ELEVATED_PUPIL, QUICKENING)
    )
    assert r["framing"] == FRAMING_RUNNING_LOW
    assert "warning sign" not in _text(r)
    assert "diagnosis" not in _text(r)
    assert "carrying a lot" in r["parts"][0]["say"][0]


def test_fewer_than_two_drive_signals_is_steady():
    r = build_pilot_spoken_report(PILOT, _results(LOW_BAT, LOW_CBI, blink=[2.0] * 7, pupil=[0.05] * 7))
    assert r["framing"] == FRAMING_STEADY
    assert "holding steady" in r["parts"][0]["say"][0]


# ── signals are dynamic and only claimed with real data ───────────────────

def test_no_biometrics_means_no_signal_lines_and_no_lead_in():
    r = build_pilot_spoken_report(PILOT, _results(LOW_BAT, LOW_CBI))
    assert r["framing"] == FRAMING_STEADY
    capacity = r["parts"][0]["say"]
    assert len(capacity) == 2  # framing line + closing line only
    assert "signals" not in " ".join(capacity)


def test_blink_above_baseline_is_not_described_as_focus():
    r = build_pilot_spoken_report(PILOT, _results(LOW_BAT, LOW_CBI, blink=[30.0] * 7))
    assert "above your baseline" in _text(r)
    assert "sustained attention" not in _text(r)


def test_eased_pupil_is_not_reported_as_elevated_into_the_later_part():
    pupil = [0.3, 0.3, 0.3, 0.0, 0.0, 0.0, 0.0]  # zeros = no reading, so use small real values
    pupil = [0.32, 0.32, 0.32, 0.05, 0.05, 0.05, 0.05]
    r = build_pilot_spoken_report(PILOT, _results(LOW_BAT, LOW_CBI, pupil=pupil))
    assert "eased later" in _text(r)
    assert "later part of the check-in" not in _text(r)


def test_pace_slowing_and_steady_are_distinguished():
    slowing = [1500, 1500, 1500, 1500, 3500, 3500, 3500]
    steady = [2000, 2100, 1900, 2000, 2050, 1950, 2000]
    assert "took a little longer" in _text(build_pilot_spoken_report(PILOT, _results(LOW_BAT, LOW_CBI, latency=slowing)))
    assert "pace stayed steady" in _text(build_pilot_spoken_report(PILOT, _results(LOW_BAT, LOW_CBI, latency=steady)))


def test_focus_area_from_high_answers_is_named_in_the_opportunity():
    # bat_q1 (Emotional Exhaustion) answered 5/5
    r = build_pilot_spoken_report(PILOT, _results([5, 1, 1, 1], LOW_CBI))
    assert r["parts"][1]["say"][0].startswith("Your answers pointed most toward mental exhaustion.")


def test_reverse_item_is_read_in_the_burnout_direction():
    # cbi_q3 answered 0 ("never enough energy") is the worst answer for a reverse item.
    r = build_pilot_spoken_report(PILOT, _results(LOW_BAT, [25, 25, 0]))
    assert "having little energy left for life outside work" in r["parts"][1]["say"][0]


def test_only_pilot_gets_a_spoken_report():
    assert build_pilot_spoken_report(TEST, {"q1": {"score": 3}}) is None
    assert build_pilot_spoken_report(PILOT, {}) is None


# ── tool wiring ───────────────────────────────────────────────────────────

async def test_burnout_score_carries_spoken_report_and_stores_it_for_followups():
    sess = SessionState(session_id="s1", survey_config=PILOT)
    sess.survey_results = _results(LOW_BAT, LOW_CBI, FOCUSED_BLINK, ELEVATED_PUPIL, QUICKENING)
    data = json.loads((await query_survey_tool(sess, PILOT, {"query_type": "burnout_score"})).to_text())
    assert [p["title"] for p in data["spoken_report"]["parts"]] == [TITLE_CAPACITY, TITLE_OPPORTUNITY, TITLE_UNLOCKS]
    assert len(data["sections"]) == 2  # the interpretations are still returned
    assert sess.spoken_report_text and TITLE_CAPACITY in sess.spoken_report_text


async def test_other_query_types_and_other_surveys_get_no_spoken_report():
    sess = SessionState(session_id="s2", survey_config=PILOT)
    sess.survey_results = _results(LOW_BAT, LOW_CBI)
    data = json.loads((await query_survey_tool(sess, PILOT, {"query_type": "summary"})).to_text())
    assert "spoken_report" not in data

    other = SessionState(session_id="s3", survey_config=TEST)
    other.survey_results = {f"q{i}": {"score": 3} for i in range(1, 6)}
    data = json.loads((await query_survey_tool(other, TEST, {"query_type": "burnout_score"})).to_text())
    assert "spoken_report" not in data
    assert other.spoken_report_text is None


# ── prompt scoping ────────────────────────────────────────────────────────

def test_only_pilot_instructions_mention_the_spoken_report():
    assert "spoken_report" in survey_instructions(PILOT)
    assert "spoken_report" not in survey_instructions(TEST)


def test_followup_context_includes_what_was_said_only_when_present():
    sess = SessionState(session_id="s4", survey_config=PILOT)
    sess.conversation_state = "report_delivered"
    assert "SPOKEN REPORT YOU DELIVERED" not in conversation_state_instructions(sess)
    sess.spoken_report_text = f"{TITLE_CAPACITY}: Your recent data points to someone in motion."
    for state in ("report_delivered", "qa_mode"):
        sess.conversation_state = state
        assert "someone in motion" in conversation_state_instructions(sess)


def test_reset_clears_the_stored_spoken_report():
    sess = SessionState(session_id="s5", survey_config=PILOT)
    sess.spoken_report_text = "x"
    sess.reset_for_new_survey()
    assert sess.spoken_report_text is None
