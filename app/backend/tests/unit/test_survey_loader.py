"""Be-C1 - survey scoring testing"""

import pytest

from survey_loader import (
    blink_band,
    compute_survey_summary,
    effective_score,
    get_score_bounds,
    is_reverse_item,
    load_survey,
    pupil_band,
)

TEST = load_survey("TEST") # q3 & q5 are reverse items; bounds (1,5); thresholds 12/22

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
