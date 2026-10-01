"""Fatigue ↔ Burnout zone — scoring rules (spec 2026-10-01 §3)."""
import pytest

from survey_loader import load_survey
from ciq.zone import ZONE_CONFIG, ZoneConfigError, compute_zone, round_half_up, validate_config

PILOT = load_survey("PILOT")
TEST = load_survey("TEST")

# Lowest-strain answer per item (cbi_q3 is reverse-scored, so 100 = no strain).
MIN = {"bat_q1": 1, "bat_q2": 1, "bat_q3": 1, "bat_q4": 1, "cbi_q1": 0, "cbi_q2": 0, "cbi_q3": 100}
MAX = {"bat_q1": 5, "bat_q2": 5, "bat_q3": 5, "bat_q4": 5, "cbi_q1": 100, "cbi_q2": 100, "cbi_q3": 0}
# One answer step = +25 strain on that item.
STEP = {"bat_q1": 1, "bat_q2": 1, "bat_q3": 1, "bat_q4": 1, "cbi_q1": 25, "cbi_q2": 25, "cbi_q3": -25}
ORDER = ["bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]

# Worked example from spec §3.
EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}


def results(scores: dict) -> dict:
    """Build a survey_results blob shaped like survey_loader.serialize_survey_results."""
    return {
        qid: {"score": s, "domain": "x", "userResponse": "", "voiceSentiment": "neutral",
              "blinkRateChange": 0, "leftGazePosition": "Center", "rightGazePosition": "Center",
              "responseLatencyMs": None}
        for qid, s in scores.items()
    }


def steps(k: int) -> dict:
    """Answers with exactly k answer-steps of strain, spread round-robin (severity = 25k/7)."""
    s = dict(MIN)
    for i in range(k):
        q = ORDER[i % 7]
        s[q] += STEP[q]
    return s


# ── config ────────────────────────────────────────────────────────────────

def test_groups_cover_exactly_the_pilot_questions():
    ids = [q["id"] for q in PILOT["questions"]]
    grouped = ZONE_CONFIG["groups"]["fatigue"] + ZONE_CONFIG["groups"]["burnout"]
    assert sorted(grouped) == sorted(ids)
    assert len(set(grouped)) == len(grouped)


def test_validate_config():
    validate_config(PILOT)  # no raise
    with pytest.raises(ZoneConfigError):
        validate_config(TEST)  # what load_survey("PILOT") silently returns when the file is broken
    with pytest.raises(ZoneConfigError):
        validate_config({**PILOT, "scoringSections": []})
    with pytest.raises(ZoneConfigError):
        validate_config(None)


# ── strain + groups ───────────────────────────────────────────────────────

def test_all_min_is_zero_strain():
    z = compute_zone(PILOT, results(MIN))
    assert (z["fatigue"], z["burnout"], z["severity"]) == (0, 0, 0)


def test_all_max_is_full_strain():
    z = compute_zone(PILOT, results(MAX))
    assert (z["fatigue"], z["burnout"], z["severity"]) == (100, 100, 100)
    assert z["zone"] == "high"


def test_cbi13_reversed_exactly_once():
    z = compute_zone(PILOT, results({**MIN, "cbi_q3": 0}))  # raw 0 on a reverse item = full strain
    assert z["fatigue"] == 20  # 100 / 5 fatigue items
    assert z["burnout"] == 0


def test_worked_example_from_spec():
    z = compute_zone(PILOT, results(EXAMPLE))
    assert z["fatigue"] == 50
    assert z["burnout"] == 25
    assert z["severity"] == 43          # 300 / 7 = 42.857…
    assert z["zone"] == "mild"
    assert z["lean"] == "fatigue"
    assert z["leanValue"] == -25
    assert z["marker"] == 38            # 37.5 rounds half-up
    assert z["severityExact"] == pytest.approx(300 / 7)


def test_severity_is_item_weighted_not_group_weighted():
    # 2 burnout steps only: item-weighted = 50/7 ≈ 7.14; group-weighted would be 12.5.
    z = compute_zone(PILOT, results({**MIN, "bat_q2": 2, "bat_q4": 2}))
    assert z["severityExact"] == pytest.approx(50 / 7)


# ── validity ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("override", [
    {"cbi_q1": 3},        # BAT-scale value on a CBI item — in the shared tool enum
    {"bat_q1": 25},       # CBI-scale value on a BAT item
    {"bat_q1": True},     # bool is an int subclass in Python
    {"bat_q1": None},
    {"bat_q1": "4"},
    {"bat_q1": 4.0},      # float, not int
    {"cbi_q2": 60},       # in 0–100 range but not an option value
])
def test_invalid_scores_make_run_incomplete(override):
    assert compute_zone(PILOT, results({**EXAMPLE, **override})) is None


def test_missing_item_makes_run_incomplete():
    partial = dict(EXAMPLE)
    del partial["bat_q4"]
    assert compute_zone(PILOT, results(partial)) is None


@pytest.mark.parametrize("blob", [None, {}, "not a dict", {"bat_q1": "not a dict"}])
def test_malformed_results_are_incomplete(blob):
    assert compute_zone(PILOT, blob) is None


# ── zones (severity = 25k/7, so 25/50/75 are hit exactly at k = 7/14/21) ──

@pytest.mark.parametrize("k,zone", [
    (0, "well"), (6, "well"), (7, "mild"), (13, "mild"),
    (14, "moderate"), (20, "moderate"), (21, "high"), (28, "high"),
])
def test_zone_boundaries(k, zone):
    assert compute_zone(PILOT, results(steps(k)))["zone"] == zone


# ── lean ──────────────────────────────────────────────────────────────────

def test_lean_exactly_minus_15_is_fatigue():
    # burnout 25, fatigue 40 → lean −15, severity 250/7 (mild)
    s = {"bat_q1": 5, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 0, "cbi_q3": 100, "bat_q2": 2, "bat_q4": 2}
    z = compute_zone(PILOT, results(s))
    assert (z["zone"], z["lean"], z["leanValue"]) == ("mild", "fatigue", -15)


def test_lean_minus_12_5_is_mixed():
    # burnout 37.5, fatigue 50 → lean −12.5 (rounds half-up away from zero to −13)
    s = {"bat_q1": 5, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 100, "bat_q2": 3, "bat_q4": 2}
    z = compute_zone(PILOT, results(s))
    assert (z["lean"], z["leanValue"]) == ("mixed", -13)


def test_lean_plus_12_5_is_mixed():
    # burnout 62.5, fatigue 50 → lean +12.5
    s = {"bat_q1": 5, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 100, "bat_q2": 4, "bat_q4": 3}
    z = compute_zone(PILOT, results(s))
    assert (z["zone"], z["lean"], z["leanValue"]) == ("moderate", "mixed", 13)


def test_lean_exactly_plus_15_is_burnout():
    # burnout 50, fatigue 35 → lean +15
    s = {"bat_q1": 4, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 0, "cbi_q3": 100, "bat_q2": 3, "bat_q4": 3}
    z = compute_zone(PILOT, results(s))
    assert (z["lean"], z["leanValue"]) == ("burnout", 15)


def test_well_zone_has_no_lean_and_no_marker():
    z = compute_zone(PILOT, results({**MIN, "bat_q2": 3}))  # burnout-heavy but tiny overall
    assert z["zone"] == "well"
    assert z["lean"] == "none"
    assert z["marker"] is None
    assert z["leanValue"] == 25


def test_marker_extremes():
    # Pure fatigue: all fatigue items max, burnout min → lean −100 → marker 0
    z = compute_zone(PILOT, results({**MAX, "bat_q2": 1, "bat_q4": 1}))
    assert z["marker"] == 0
    # Pure burnout: burnout max, fatigue min → lean +100 → marker 100
    z = compute_zone(PILOT, results({**MIN, "bat_q2": 5, "bat_q4": 5}))
    assert z["marker"] == 100


# ── rounding ──────────────────────────────────────────────────────────────

def test_round_half_up():
    assert round_half_up(12.5) == 13
    assert round_half_up(37.5) == 38
    assert round_half_up(42.857142857142854) == 43
    assert round_half_up(-12.5) == -13


def test_burnout_12_5_reports_13():
    z = compute_zone(PILOT, results({**EXAMPLE, "bat_q2": 2, "bat_q4": 1}))
    assert z["burnout"] == 13
