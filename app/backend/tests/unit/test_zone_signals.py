"""Fatigue ↔ Burnout zone — supporting fatigue signals (spec 2026-10-01 §5)."""
import json

from ciq.zone import build_zone_trend, compute_signals
from survey_loader import load_survey

PILOT = load_survey("PILOT")
IDS = ["bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]
EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}


def blob(blinks=None, lats=None, scores=EXAMPLE):
    """blinks / lats: list of 7 per-item values (or None → serializer defaults 0 / None)."""
    blinks = blinks or [0] * 7
    lats = lats or [None] * 7
    return {q: {"score": scores[q], "blinkRateChange": b, "responseLatencyMs": lat}
            for q, b, lat in zip(IDS, blinks, lats)}


def keys(signals):
    return [s["key"] for s in signals]


# ── blink_up ──────────────────────────────────────────────────────────────

def test_blink_mean_exactly_20_is_hidden():
    assert keys(compute_signals(blob(blinks=[20] * 7), [])) == []


def test_blink_mean_above_20_is_shown():
    sig = compute_signals(blob(blinks=[20.1] * 7), [])
    assert sig == [{"key": "blink_up", "label": "Blink rate above your baseline", "approximate": True}]


def test_blink_zero_and_bool_are_missing():
    # 3 zeros + 1 bool → only 3 usable → below the 5-item minimum → hidden
    assert keys(compute_signals(blob(blinks=[30, 30, 30, 0, 0, 0, True]), [])) == []


def test_blink_five_usable_is_enough():
    assert keys(compute_signals(blob(blinks=[30, 30, 30, 30, 30, 0, 0]), [])) == ["blink_up"]


def test_blink_four_usable_is_hidden():
    assert keys(compute_signals(blob(blinks=[30, 30, 30, 30, 0, 0, 0]), [])) == []


def test_blink_below_baseline_is_not_a_signal():
    assert keys(compute_signals(blob(blinks=[-50] * 7), [])) == []


# ── slower ────────────────────────────────────────────────────────────────

def test_slower_needs_a_previous_run():
    assert keys(compute_signals(blob(lats=[5000] * 7), [])) == []


def test_slower_at_exactly_25_percent():
    prev = [blob(lats=[1000] * 7)]
    assert keys(compute_signals(blob(lats=[1250] * 7), prev)) == ["slower"]
    assert keys(compute_signals(blob(lats=[1249] * 7), prev)) == []


def test_slower_uses_median_of_previous_medians():
    prev = [blob(lats=[1000] * 7), blob(lats=[2000] * 7), blob(lats=[3000] * 7)]  # medians → 2000
    assert keys(compute_signals(blob(lats=[2500] * 7), prev)) == ["slower"]
    assert keys(compute_signals(blob(lats=[2400] * 7), prev)) == []


def test_slower_ignores_previous_runs_with_too_few_latencies():
    prev = [blob(lats=[1000, 1000, 1000, None, None, None, None])]
    assert keys(compute_signals(blob(lats=[5000] * 7), prev)) == []


def test_slower_ignores_non_positive_and_bool_latency():
    latest = blob(lats=[5000, 5000, 5000, 5000, 0, -1, True])  # only 4 usable
    assert keys(compute_signals(latest, [blob(lats=[1000] * 7)])) == []


def test_both_signals_in_fixed_order():
    sig = compute_signals(blob(blinks=[30] * 7, lats=[2000] * 7), [blob(lats=[1000] * 7)])
    assert keys(sig) == ["blink_up", "slower"]
    assert sig[1]["label"] == "Slower responses than your recent check-ins"


# ── wiring + independence from the score ──────────────────────────────────

def _rec(run_id, created, b):
    return {"survey_run_id": run_id, "created_at": created, "survey_type": "PILOT",
            "survey_results": json.dumps(b)}


def test_build_attaches_signals_to_latest_only():
    recs = [
        _rec("new", "2026-09-02T00:00:00", blob(blinks=[30] * 7, lats=[2000] * 7)),
        _rec("old", "2026-09-01T00:00:00", blob(lats=[1000] * 7)),
    ]
    out = build_zone_trend(recs, PILOT)
    assert keys(out["latest"]["signals"]) == ["blink_up", "slower"]
    assert all("signals" not in p for p in out["trend"]["points"])


def test_signals_never_change_the_score_or_trend():
    calm = [_rec("b", "2026-09-02T00:00:00", blob()), _rec("a", "2026-09-01T00:00:00", blob())]
    busy = [_rec("b", "2026-09-02T00:00:00", blob(blinks=[90] * 7, lats=[9000] * 7)),
            _rec("a", "2026-09-01T00:00:00", blob(lats=[1000] * 7))]
    c, b = build_zone_trend(calm, PILOT), build_zone_trend(busy, PILOT)
    def strip(o):
        return {**o["latest"], "signals": None}

    assert strip(c) == strip(b)
    assert c["trend"] == b["trend"]
