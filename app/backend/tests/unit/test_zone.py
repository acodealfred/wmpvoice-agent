"""Fatigue ↔ Burnout zone — scoring, validity, rounding, trend and signals (ciq.zone)."""
import json
import logging

import pytest

from ciq.zone import (
    ZONE_CONFIG,
    ZoneConfigError,
    _strains,
    build_zone_trend,
    compute_signals,
    compute_trend,
    compute_zone,
    validate_config,
)
from survey_loader import load_survey

PILOT = load_survey("PILOT")
TEST = load_survey("TEST")

FATIGUE = ZONE_CONFIG["groups"]["fatigue"]   # bat_q1, bat_q3, cbi_q1, cbi_q2, cbi_q3 (reverse)
BURNOUT = ZONE_CONFIG["groups"]["burnout"]   # bat_q2, bat_q4
ALL_IDS = FATIGUE + BURNOUT


def _raw(qid: str, strain: float) -> int:
    """The raw answer that gives `strain` (0/25/50/75/100) on item `qid`."""
    if qid.startswith("bat_"):
        return int(1 + strain / 25)
    return int(100 - strain) if qid == "cbi_q3" else int(strain)


def _results(strains: dict | None = None, *, blink=None, latency=None) -> dict:
    """Full survey_results with every item at strain 0 unless overridden."""
    strains = strains or {}
    out = {}
    for qid in ALL_IDS:
        entry = {"score": _raw(qid, strains.get(qid, 0)), "blinkRateChange": 0, "responseLatencyMs": None}
        if blink is not None:
            entry["blinkRateChange"] = blink[qid] if isinstance(blink, dict) else blink
        if latency is not None:
            entry["responseLatencyMs"] = latency[qid] if isinstance(latency, dict) else latency
        out[qid] = entry
    return out


def _steps(n: int) -> dict:
    """Strains totalling `n` answer steps (25 strain each), filling items in order."""
    strains = {}
    for qid in ALL_IDS:
        take = min(4, n)
        strains[qid] = take * 25
        n -= take
    assert n == 0
    return strains


def _group(fatigue_steps: int, burnout_steps: int) -> dict:
    strains = {}
    for ids, n in ((FATIGUE, fatigue_steps), (BURNOUT, burnout_steps)):
        for qid in ids:
            take = min(4, n)
            strains[qid] = take * 25
            n -= take
        assert n == 0
    return strains


def _rec(run_id: str, created_at: str, results, survey_type="PILOT") -> dict:
    return {
        "survey_run_id": run_id,
        "created_at": created_at,
        "survey_type": survey_type,
        "survey_results": results if results is None or isinstance(results, str) else json.dumps(results),
    }


# ── Config ───────────────────────────────────────────────────────────────────

def test_groups_cover_exactly_the_pilot_question_ids():
    assert sorted(ALL_IDS) == sorted(q["id"] for q in PILOT["questions"])
    assert len(ALL_IDS) == len(set(ALL_IDS))


def test_pilot_config_is_valid():
    validate_config(PILOT)


def test_test_config_is_rejected():
    with pytest.raises(ZoneConfigError):
        validate_config(TEST)
    with pytest.raises(ZoneConfigError):
        build_zone_trend([], TEST)


def test_config_without_scoring_sections_is_rejected():
    with pytest.raises(ZoneConfigError):
        validate_config({**PILOT, "scoringSections": []})


# ── Strain ───────────────────────────────────────────────────────────────────

def test_strain_bounds_and_reverse_item():
    lo = _strains(PILOT, {**_results(), "bat_q1": {"score": 1}, "cbi_q1": {"score": 0}, "cbi_q3": {"score": 100}})
    hi = _strains(PILOT, {**_results(), "bat_q1": {"score": 5}, "cbi_q1": {"score": 100}, "cbi_q3": {"score": 0}})
    assert (lo["bat_q1"], lo["cbi_q1"], lo["cbi_q3"]) == (0, 0, 0)
    assert (hi["bat_q1"], hi["cbi_q1"], hi["cbi_q3"]) == (100, 100, 100)


# ── Validity ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("qid,score", [
    ("cbi_q1", 3),       # BAT value on a CBI item
    ("bat_q1", 25),      # CBI value on a BAT item
    ("bat_q1", True),
    ("bat_q1", None),
    ("bat_q1", "4"),
    ("bat_q1", 4.0),
])
def test_invalid_score_makes_run_incomplete(qid, score):
    results = _results()
    results[qid] = {"score": score}
    assert compute_zone(PILOT, results) is None


def test_missing_item_makes_run_incomplete():
    results = _results()
    del results["bat_q4"]
    assert compute_zone(PILOT, results) is None


# ── Severity, lean, marker ───────────────────────────────────────────────────

def test_worked_example():
    results = _results()
    for qid, raw in {"bat_q1": 4, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75,
                     "bat_q2": 2, "bat_q4": 2}.items():
        results[qid]["score"] = raw
    assert compute_zone(PILOT, results) == {
        "fatigue": 50, "burnout": 25, "severity": 43, "zone": "mild",
        "lean": "fatigue", "leanValue": -25, "marker": 38,
    }


def test_severity_is_item_weighted_not_group_weighted():
    # Burnout items maxed, fatigue items zero: item mean = 200/7 ≈ 28.6 (mild);
    # a group mean would give 50 (moderate).
    zone = compute_zone(PILOT, _results({"bat_q2": 100, "bat_q4": 100}))
    assert zone["severity"] == 29
    assert zone["zone"] == "mild"


def test_rounding_is_half_up():
    zone = compute_zone(PILOT, _results(_group(fatigue_steps=8, burnout_steps=1)))
    assert zone["burnout"] == 13          # 12.5 → 13
    zone = compute_zone(PILOT, _results(_group(fatigue_steps=10, burnout_steps=3)))
    assert zone["leanValue"] == -13       # −12.5 → −13 (half away from zero)
    assert zone["marker"] == 44           # 43.75 → 44


@pytest.mark.parametrize("steps,zone", [
    (0, "well"), (6, "well"), (7, "mild"), (13, "mild"), (14, "moderate"),
    (20, "moderate"), (21, "high"), (28, "high"),
])
def test_zone_boundaries(steps, zone):
    result = compute_zone(PILOT, _results(_steps(steps)))
    assert result["zone"] == zone
    assert result["severity"] == round(steps * 25 / 7)


@pytest.mark.parametrize("fatigue_steps,burnout_steps,lean_value,lean", [
    (8, 2, -15, "fatigue"),      # fatigue 40, burnout 25
    (10, 3, -12.5, "mixed"),     # fatigue 50, burnout 37.5
    (10, 5, 12.5, "mixed"),      # fatigue 50, burnout 62.5
    (7, 4, 15, "burnout"),       # fatigue 35, burnout 50
])
def test_lean_boundaries(fatigue_steps, burnout_steps, lean_value, lean):
    result = compute_zone(PILOT, _results(_group(fatigue_steps, burnout_steps)))
    assert result["zone"] != "well"
    assert result["lean"] == lean
    assert result["marker"] == int(50 + lean_value / 2 + 0.5)


def test_well_zone_has_no_lean_or_marker():
    result = compute_zone(PILOT, _results(_group(fatigue_steps=0, burnout_steps=2)))
    assert result["zone"] == "well"
    assert result["lean"] == "none"
    assert result["marker"] is None
    assert result["leanValue"] == 25


# ── Trend ────────────────────────────────────────────────────────────────────

def _runs(*severities) -> list[dict]:
    return [
        {"surveyRunId": f"r{i}", "date": f"2026-09-{i + 1:02d}", "severity": s, "zone": "mild", "lean": "mixed"}
        for i, s in enumerate(severities)
    ]


def test_trend_none_and_first():
    assert compute_trend([]) == {"status": "none", "points": []}
    first = compute_trend(_runs(40))
    assert first["status"] == "first"
    assert len(first["points"]) == 1


@pytest.mark.parametrize("severities,status", [
    ((40, 45), "worsening"),        # exactly +5
    ((40, 44.9), "steady"),
    ((40, 35), "improving"),        # exactly −5
    ((40, 35.1), "steady"),
])
def test_trend_dead_zone(severities, status):
    assert compute_trend(_runs(*severities))["status"] == status


def test_trend_compares_up_to_three_earlier_runs():
    two = compute_trend(_runs(30, 40))
    assert (two["compared"], two["ref"], two["delta"]) == (1, 30, 10)
    four = compute_trend(_runs(10, 20, 30, 40))
    assert (four["compared"], four["ref"], four["delta"]) == (3, 20, 20)
    five = compute_trend(_runs(90, 10, 20, 30, 40))     # the oldest run is outside the window
    assert (five["compared"], five["ref"]) == (3, 20)
    assert [p["surveyRunId"] for p in five["points"]] == ["r0", "r1", "r2", "r3", "r4"]


def test_trend_points_capped_at_most_recent():
    trend = compute_trend(_runs(*range(25)))
    assert len(trend["points"]) == ZONE_CONFIG["trend_points"]
    assert trend["points"][0]["surveyRunId"] == "r5"
    assert trend["points"][-1]["surveyRunId"] == "r24"


@pytest.mark.parametrize("group", ["burnout", "fatigue"])
def test_granularity_one_answer_steady_two_answers_move(group):
    items = BURNOUT if group == "burnout" else FATIGUE
    base = {qid: 50 for qid in ALL_IDS}
    one_up = {**base, items[0]: 75}
    two_up = {**base, items[0]: 75, items[1]: 75}
    two_down = {**base, items[0]: 25, items[1]: 25}

    def status(latest):
        records = [_rec("a", "2026-09-01T00:00:00", _results(base)),
                   _rec("b", "2026-09-02T00:00:00", _results(latest))]
        return build_zone_trend(records, PILOT)["trend"]["status"]

    assert status(one_up) == "steady"
    assert status(two_up) == "worsening"
    assert status(two_down) == "improving"


def test_build_sorts_desc_input_and_ignores_incomplete_newest():
    incomplete = _results()
    del incomplete["bat_q1"]
    records = [  # newest first, like get_user_survey_records
        _rec("newest-incomplete", "2026-09-04T00:00:00", incomplete),
        _rec("c", "2026-09-03T00:00:00", _results(_steps(14))),
        _rec("b", "2026-09-02T00:00:00", _results(_steps(7))),
        _rec("a", "2026-09-01T00:00:00", _results(_steps(0))),
    ]
    out = build_zone_trend(records, PILOT)
    assert out["latest"]["surveyRunId"] == "c"
    assert out["latest"]["date"] == "2026-09-03"
    assert [p["surveyRunId"] for p in out["trend"]["points"]] == ["a", "b", "c"]
    assert out["trend"]["compared"] == 2


def test_build_filters_rows(caplog):
    good = _results(_steps(7))
    records = [
        _rec("ok", "2026-09-05T00:00:00", good),
        _rec("lower", "2026-09-06T00:00:00", good, survey_type="pilot"),
        _rec("test", "2026-09-07T00:00:00", good, survey_type="TEST"),
        _rec("blank-type", "2026-09-08T00:00:00", good, survey_type=""),
        _rec("null-type", "2026-09-09T00:00:00", good, survey_type=None),
        _rec("empty", "2026-09-10T00:00:00", "{}"),
        _rec("null", "2026-09-11T00:00:00", None),
        _rec("bad-json", "2026-09-12T00:00:00", "{not json"),
    ]
    with caplog.at_level(logging.WARNING, logger="voicerag"):
        out = build_zone_trend(records, PILOT)
    assert [p["surveyRunId"] for p in out["trend"]["points"]] == ["ok", "lower"]
    assert any("Unparseable" in m for m in caplog.messages)


def test_build_with_no_records():
    assert build_zone_trend([], PILOT) == {"latest": None, "trend": {"status": "none", "points": []}}


# ── Signals ──────────────────────────────────────────────────────────────────

def _keys(signals):
    return [s["key"] for s in signals]


def test_blink_up_threshold_is_strictly_above_20():
    assert _keys(compute_signals(PILOT, _results(blink=20), [])) == []
    assert _keys(compute_signals(PILOT, _results(blink=20.1), [])) == ["blink_up"]


def test_blink_zero_and_bool_are_missing_data():
    blink = {qid: 30 for qid in ALL_IDS}
    blink.update({"bat_q1": 0, "bat_q2": 0, "bat_q3": True})   # only 4 usable left
    assert compute_signals(PILOT, _results(blink=blink), []) == []
    blink["bat_q3"] = 30                                       # 5 usable → shown
    assert _keys(compute_signals(PILOT, _results(blink=blink), [])) == ["blink_up"]


def test_slower_needs_a_previous_run():
    assert compute_signals(PILOT, _results(latency=5000), []) == []
    # a previous run with too little latency data doesn't count either
    sparse = {qid: (1000 if i < 4 else None) for i, qid in enumerate(ALL_IDS)}
    assert compute_signals(PILOT, _results(latency=5000), [_results(latency=sparse)]) == []


def test_slower_at_the_25_percent_boundary():
    previous = [_results(latency=1000)]
    assert _keys(compute_signals(PILOT, _results(latency=1250), previous)) == ["slower"]
    assert compute_signals(PILOT, _results(latency=1249), previous) == []


def test_signals_are_approximate_and_never_change_scores():
    strains = _steps(10)
    plain = [_rec("a", "2026-09-01T00:00:00", _results(strains, latency=1000)),
             _rec("b", "2026-09-02T00:00:00", _results(strains))]
    noisy = [_rec("a", "2026-09-01T00:00:00", _results(strains, latency=1000)),
             _rec("b", "2026-09-02T00:00:00", _results(strains, blink=45, latency=4000))]
    p, n = build_zone_trend(plain, PILOT), build_zone_trend(noisy, PILOT)
    assert p["latest"]["signals"] == []
    assert _keys(n["latest"]["signals"]) == ["blink_up", "slower"]
    assert all(s["approximate"] for s in n["latest"]["signals"])
    strip = lambda z: {k: v for k, v in z.items() if k != "signals"}  # noqa: E731
    assert strip(p["latest"]) == strip(n["latest"])
    assert p["trend"] == n["trend"]
