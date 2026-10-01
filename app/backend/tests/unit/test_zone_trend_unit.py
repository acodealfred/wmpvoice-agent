"""Fatigue ↔ Burnout zone — trend + record pipeline (spec 2026-10-01 §4)."""
import json

import pytest

from survey_loader import load_survey
from ciq.zone import ZoneConfigError, build_zone_trend, compute_trend

PILOT = load_survey("PILOT")
TEST = load_survey("TEST")

EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}
MIN = {"bat_q1": 1, "bat_q2": 1, "bat_q3": 1, "bat_q4": 1, "cbi_q1": 0, "cbi_q2": 0, "cbi_q3": 100}


def blob(scores, blink=0, latency=None):
    return {qid: {"score": s, "blinkRateChange": blink, "responseLatencyMs": latency} for qid, s in scores.items()}


def rec(run_id, created_at, scores=None, survey_type="PILOT", raw=None):
    return {
        "survey_run_id": run_id,
        "created_at": created_at,
        "survey_type": survey_type,
        "survey_results": raw if raw is not None else json.dumps(blob(scores)),
    }


def runs(*sevs):
    return [{"severityExact": s} for s in sevs]


# ── compute_trend ─────────────────────────────────────────────────────────

def test_trend_none_and_first():
    assert compute_trend([]) == {"status": "none"}
    assert compute_trend(runs(40)) == {"status": "first"}


@pytest.mark.parametrize("sevs,status,delta,ref,compared", [
    ((40, 50), "worsening", 10, 40, 1),
    ((50, 45), "improving", -5, 50, 1),        # exactly −5 → improving
    ((50, 55), "worsening", 5, 50, 1),         # exactly +5 → worsening
    ((50, 45.5), "steady", -5, 50, 1),         # −4.5 → steady (delta still rounds to −5 for display)
    ((50, 54.9), "steady", 5, 50, 1),
    ((20, 30, 40, 24), "improving", -6, 30, 3),
    ((10, 20, 30, 40, 30), "steady", 0, 30, 3),  # window is the 3 runs before the latest
])
def test_trend_rules(sevs, status, delta, ref, compared):
    t = compute_trend(runs(*sevs))
    assert t == {"status": status, "delta": delta, "ref": ref, "compared": compared}


def test_one_answer_change_is_steady_two_is_not():
    # Item-weighted: one answer step = 25/7 ≈ 3.57; two = 7.14 (owner decision 2026-10-01).
    one = 25 / 7
    assert compute_trend(runs(50, 50 - one))["status"] == "steady"
    assert compute_trend(runs(50, 50 - 2 * one))["status"] == "improving"
    assert compute_trend(runs(50, 50 + 2 * one))["status"] == "worsening"


# ── build_zone_trend ──────────────────────────────────────────────────────

def test_build_empty():
    out = build_zone_trend([], PILOT)
    assert out == {"latest": None, "trend": {"status": "none", "points": []}}


def test_build_sorts_desc_input_oldest_first():
    recs = [  # newest first, as db.get_user_survey_records returns them
        rec("r3", "2026-09-03T10:00:00", MIN),
        rec("r2", "2026-09-02T10:00:00", EXAMPLE),
        rec("r1", "2026-09-01T10:00:00", EXAMPLE),
    ]
    out = build_zone_trend(recs, PILOT)
    assert [p["surveyRunId"] for p in out["trend"]["points"]] == ["r1", "r2", "r3"]
    assert out["latest"]["surveyRunId"] == "r3"
    assert out["latest"]["date"] == "2026-09-03"
    assert out["trend"]["status"] == "improving"  # 0 vs ref 42.86


def test_incomplete_newest_run_is_ignored():
    partial = dict(EXAMPLE)
    del partial["bat_q1"]
    recs = [rec("new", "2026-09-02T10:00:00", partial), rec("old", "2026-09-01T10:00:00", EXAMPLE)]
    out = build_zone_trend(recs, PILOT)
    assert out["latest"]["surveyRunId"] == "old"
    assert out["trend"]["status"] == "first"


@pytest.mark.parametrize("bad", [
    rec("t", "2026-09-05T00:00:00", EXAMPLE, survey_type="TEST"),
    rec("e", "2026-09-05T00:00:00", EXAMPLE, survey_type=""),
    rec("n", "2026-09-05T00:00:00", EXAMPLE, survey_type=None),
    rec("d", "2026-09-05T00:00:00", raw="{}"),
    rec("z", "2026-09-05T00:00:00", raw=""),
    {"survey_run_id": "null", "created_at": "2026-09-05T00:00:00", "survey_type": "PILOT", "survey_results": None},
    rec("m", "2026-09-05T00:00:00", raw="not json"),
    rec("l", "2026-09-05T00:00:00", raw="[1, 2]"),
])
def test_build_skips_non_pilot_and_bad_rows(bad):
    out = build_zone_trend([bad, rec("ok", "2026-09-01T00:00:00", EXAMPLE)], PILOT)
    assert [p["surveyRunId"] for p in out["trend"]["points"]] == ["ok"]


def test_build_accepts_lowercase_pilot_type():
    out = build_zone_trend([rec("a", "2026-09-01T00:00:00", EXAMPLE, survey_type="pilot")], PILOT)
    assert out["latest"]["surveyRunId"] == "a"


def test_build_accepts_already_parsed_results():
    r = rec("a", "2026-09-01T00:00:00", EXAMPLE)
    r["survey_results"] = json.loads(r["survey_results"])
    assert build_zone_trend([r], PILOT)["latest"]["surveyRunId"] == "a"


def test_points_capped_at_20_most_recent():
    recs = [rec(f"r{i:02d}", f"2026-08-{i:02d}T00:00:00", EXAMPLE) for i in range(1, 26)]
    pts = build_zone_trend(recs, PILOT)["trend"]["points"]
    assert len(pts) == 20
    assert pts[0]["surveyRunId"] == "r06" and pts[-1]["surveyRunId"] == "r25"


def test_output_shape_has_no_internal_keys():
    out = build_zone_trend([rec("a", "2026-09-01T00:00:00", EXAMPLE)], PILOT)
    assert set(out["latest"]) == {"surveyRunId", "date", "fatigue", "burnout", "severity",
                                  "zone", "lean", "leanValue", "marker", "signals"}
    assert set(out["trend"]["points"][0]) == {"surveyRunId", "date", "severity", "zone", "lean"}


def test_tie_on_created_at_breaks_by_run_id():
    recs = [rec("b", "2026-09-01T00:00:00", MIN), rec("a", "2026-09-01T00:00:00", EXAMPLE)]
    assert build_zone_trend(recs, PILOT)["latest"]["surveyRunId"] == "b"


def test_build_rejects_fallback_config():
    with pytest.raises(ZoneConfigError):
        build_zone_trend([rec("a", "2026-09-01T00:00:00", EXAMPLE)], TEST)
