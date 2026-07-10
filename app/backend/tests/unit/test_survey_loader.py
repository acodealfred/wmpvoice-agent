"""Be-C1 - survey scoring testing"""

import pytest

from survey_loader import (
    blink_band,
    compute_section_scores,
    compute_survey_summary,
    effective_score,
    get_score_bounds,
    is_reverse_item,
    load_survey,
    pupil_band,
)

TEST = load_survey("TEST") # q3 & q5 are reverse items; bounds (1,5); thresholds 12/22
PILOT = load_survey("PILOT") # bat_q1-4 (BAT-4, 1-5) + cbi_q1-3 (CBI-WRB3, 0-100, cbi_q3 reverse)

# ── load_survey ────────────────────────────────────────────────────────────

def test_load_survey():
    assert TEST["type"] == "TEST"
    assert len(TEST["questions"]) == 5

def test_load_unkonwn_falls_back_test():
    cfg = load_survey("DOES_NOT_EXIST")
    assert cfg["type"] == "TEST"    

# ── get_score_bounds ────────────────────────────────────────────────────────────
def test_score_bounds_from_configs():
    assert get_score_bounds(TEST) == (1,5)

def test_score_bounds_default_when_no_options():
    assert get_score_bounds({}) == (1, 5)

# ── is_reverse_item ────────────────────────────────────────────────────────
def test_reverse_flags():
    assert is_reverse_item(TEST, "q3") is True   # Personal Accomplishment
    assert is_reverse_item(TEST, "q5") is True   # Job Satisfaction
    assert is_reverse_item(TEST, "q1") is False
    assert is_reverse_item(TEST, "nope") is False    
# ── effective_score ────────────────────────────────────────────────────────
@pytest.mark.parametrize("raw,expected", [(1, 1), (3, 3), (5, 5)])
def test_effective_score_normal_item(raw, expected):
    assert effective_score(TEST, "q1", raw) == expected


@pytest.mark.parametrize("raw,expected", [(1, 5), (2, 4), (3, 3), (4, 2), (5, 1)])
def test_effective_score_reverse_item(raw, expected):
    # reverse: (min+max) - raw = (1+5) - raw = 6 - raw
    assert effective_score(TEST, "q3", raw) == expected


def test_effective_score_none_is_zero():
    assert effective_score(TEST, "q1", None) == 0


# ── compute_survey_summary ─────────────────────────────────────────────────
def _snap(qid, score, domain="D"):
    return {"questionId": qid, "score": score, "domain": domain}


def test_summary_all_high_burnout():
    # q1,q2,q4 high (5); q3,q5 reverse answered low (1 → effective 5). Total = 25 → High.
    snaps = [_snap("q1", 5), _snap("q2", 5), _snap("q3", 1), _snap("q4", 5), _snap("q5", 1)]
    s = compute_survey_summary(TEST, snaps)
    assert s["totalScore"] == 25
    assert s["maxScore"] == 25          # 5 questions * max 5
    assert s["riskLevel"] == "High"
    assert s["interpretation"] == TEST["interpretation"]["high"]









def test_summary_all_low_burnout():
    # q1,q2,q4 low (1); q3,q5 reverse answered high (5 → effective 1). Total = 5 → Low.
    snaps = [_snap("q1", 1), _snap("q2", 1), _snap("q3", 5), _snap("q4", 1), _snap("q5", 5)]
    s = compute_survey_summary(TEST, snaps)
    assert s["totalScore"] == 5
    assert s["riskLevel"] == "Low"


@pytest.mark.parametrize("total,expected", [
    (12, "Low"),       # low_max boundary → Low
    (13, "Moderate"),  # just over low_max
    (22, "Moderate"),  # moderate_max boundary → Moderate
    (23, "High"),      # just over moderate_max
])
def test_summary_risk_thresholds(total, expected):
    # Build N normal-item snapshots summing to `total` (use q1, a non-reverse item).
    snaps, remaining = [], total
    while remaining > 0:
        step = min(5, remaining)
        snaps.append(_snap("q1", step))
        remaining -= step
    assert compute_survey_summary(TEST, snaps)["riskLevel"] == expected


def test_summary_domain_totals():
    snaps = [_snap("q1", 4, "Emotional Exhaustion"), _snap("q2", 2, "Depersonalization")]
    s = compute_survey_summary(TEST, snaps)
    assert s["domainTotals"] == {"Emotional Exhaustion": 4, "Depersonalization": 2}


# ── compute_section_scores / scoringSections (PILOT's BAT-4 + CBI-WRB3) ────────
def _pilot_snaps(bat=(4, 4, 4, 4), cbi=(4, 4, 2)):
    return [
        _snap("bat_q1", bat[0]), _snap("bat_q2", bat[1]), _snap("bat_q3", bat[2]), _snap("bat_q4", bat[3]),
        _snap("cbi_q1", cbi[0]), _snap("cbi_q2", cbi[1]), _snap("cbi_q3", cbi[2]),
    ]


def test_pilot_declares_two_scoring_sections():
    ids = [s["id"] for s in PILOT["scoringSections"]]
    assert ids == ["bat4", "cbi_wrb3"]


def test_bat4_score_is_plain_average_on_native_1_to_5_scale():
    # All four items answered 4 -> average 4.0, scoreRange [1,5] == native range (identity rescale).
    sections = compute_section_scores(PILOT, _pilot_snaps(bat=(4, 4, 4, 4)))
    bat4 = next(s for s in sections if s["id"] == "bat4")
    assert bat4["score"] == 4.0
    assert bat4["scoreRange"] == [1, 5]
    assert bat4["riskLevel"] == "High"  # > 3.0


def test_cbi_wrb3_reverse_scores_item13_and_rescales_1_5_to_0_100():
    # cbi_q1=4, cbi_q2=4, cbi_q3=2 (reverse -> effective (1+5)-2=4) -> raw avg (4+4+4)/3=4.0
    # rescaled to 0-100: (4-1)*100/4 = 75.0
    sections = compute_section_scores(PILOT, _pilot_snaps(cbi=(4, 4, 2)))
    cbi = next(s for s in sections if s["id"] == "cbi_wrb3")
    assert cbi["score"] == 75.0
    assert cbi["scoreRange"] == [0, 100]


@pytest.mark.parametrize("bat,expected", [
    ((2, 2, 2, 2), "Low"),       # avg 2.0 -> low_max boundary -> Low
    ((2, 2, 2, 3), "Moderate"),  # avg 2.25 -> just over low_max
    ((3, 3, 3, 3), "Moderate"),  # avg 3.0 -> moderate_max boundary -> Moderate
    ((3, 3, 3, 4), "High"),      # avg 3.25 -> just over moderate_max
])
def test_bat4_risk_band_thresholds(bat, expected):
    sections = compute_section_scores(PILOT, _pilot_snaps(bat=bat))
    assert next(s for s in sections if s["id"] == "bat4")["riskLevel"] == expected


@pytest.mark.parametrize("cbi,expected_score,expected_band", [
    ((3, 3, 4), 41.7, "Low"),       # effective sum 3+3+2=8 -> avg 2.667 -> rescaled 41.7 (<=49)
    ((3, 3, 3), 50.0, "Moderate"),  # effective sum 3+3+3=9 -> avg 3.0 -> rescaled 50.0 (>49, <=74)
    ((4, 4, 3), 66.7, "Moderate"),  # effective sum 4+4+3=11 -> avg 3.667 -> rescaled 66.7
    ((4, 4, 2), 75.0, "High"),      # effective sum 4+4+4=12 (cbi_q3 reversed 2->4) -> rescaled 75.0 (>74)
])
def test_cbi_wrb3_risk_band_thresholds(cbi, expected_score, expected_band):
    sections = compute_section_scores(PILOT, _pilot_snaps(cbi=cbi))
    cbi_section = next(s for s in sections if s["id"] == "cbi_wrb3")
    assert cbi_section["score"] == expected_score
    assert cbi_section["riskLevel"] == expected_band


def test_pilot_section_omitted_when_no_questions_answered_yet():
    # Only BAT-4 questions answered so far (mid-survey) -> CBI-WRB3 section is absent,
    # not a bogus zero-division score.
    snaps = [_snap("bat_q1", 3), _snap("bat_q2", 3), _snap("bat_q3", 3), _snap("bat_q4", 3)]
    sections = compute_section_scores(PILOT, snaps)
    assert [s["id"] for s in sections] == ["bat4"]


def test_pilot_summary_replaces_combined_score_with_sections():
    summary = compute_survey_summary(PILOT, _pilot_snaps())
    assert "sections" in summary
    assert "totalScore" not in summary
    assert "riskLevel" not in summary
    assert len(summary["sections"]) == 2
    assert set(summary["domainTotals"]) == {
        "Emotional Exhaustion", "Mental Distance", "Cognitive Impairment", "Emotional Impairment",
        "Work-Related Burnout (Item 7)", "Work-Related Burnout (Item 11)", "Work-Related Burnout (Item 13)",
    }


def test_test_survey_summary_unaffected_by_sections_feature():
    # TEST has no scoringSections -> must keep the original flat shape exactly as before.
    snaps = [_snap("q1", 5), _snap("q2", 5), _snap("q3", 1), _snap("q4", 5), _snap("q5", 1)]
    summary = compute_survey_summary(TEST, snaps)
    assert "sections" not in summary
    assert summary["totalScore"] == 25


# ── blink_band / pupil_band (level contract — keep in lockstep with FE bands.ts) ──
@pytest.mark.parametrize("pct,level", [
    (None, "Unknown"), (0, "Normal"), (15, "Normal"), (-15, "Normal"),
    (15.1, "Elevated"), (40, "Elevated"), (-40, "Elevated"),
    (40.1, "High"), (-41, "High"),
])
def test_blink_band_levels(pct, level):
    assert blink_band(pct).split(" ")[0] == level  # strip "(above/below baseline)" suffix


@pytest.mark.parametrize("mm,band", [
    (None, "Unknown"), (-0.5, "Low"), (0.1, "Low"),
    (0.11, "Medium"), (0.3, "Medium"),
    (0.31, "High"), (1.0, "High"),
])
def test_pupil_band(mm, band):
    assert pupil_band(mm) == band
