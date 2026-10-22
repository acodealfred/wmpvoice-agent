"""ciq/reports/signal_comparison.py — pure per-question signal comparison (no DB)."""
import copy
import itertools
import json
import re

import pytest

from ciq.reports.signal_comparison import (
    SIGNAL_CONFIG,
    SIGNAL_ORDER,
    compare_signals,
    question_readings,
    semitones,
    signal_spoken_lines,
)
from survey_loader import load_survey

PILOT = load_survey("PILOT")
QIDS = [q["id"] for q in PILOT["questions"]]
Q1, Q2 = "bat_q1", "bat_q2"


def _blank() -> dict:
    return {"blink_pct": None, "latency_ms": None, "pitch_hz": None, "intensity_db": None,
            "sentiment": None, "face_emotion": None, "answer": None}


def _readings(**per_question) -> dict:
    """Readings for every PILOT question, blank except the given {qid: {field: value}}."""
    out = {qid: _blank() for qid in QIDS}
    for qid, fields in per_question.items():
        out[qid].update(fields)
    return out


def _run(run_id: str, created_at: str, readings: dict, survey_type: str = "PILOT") -> dict:
    return {"record": {"survey_run_id": run_id, "survey_type": survey_type, "created_at": created_at},
            "readings": readings}


def _compare(today: dict, *past: dict, survey_type: str = "PILOT"):
    current = _run("run-now", "2026-10-19T09:00:00", today, survey_type)
    previous = [_run(f"run-{i}", f"2026-10-{12 - i:02d}T09:00:00", r) for i, r in enumerate(past)]
    return compare_signals(current, previous, SIGNAL_CONFIG, PILOT)


def _question(result, qid=Q1):
    assert result is not None
    return next((q for q in result["questions"] if q["questionId"] == qid), None)


def _status(result, qid=Q1):
    return _question(result, qid)["status"]


def _steady(result, qid=Q1) -> bool:
    """Listed, but nothing printed: steady status, no signals, no surfacing reason."""
    q = _question(result, qid)
    return q["status"] == "steady" and q["signals"] == [] and q["surfacedBy"] is None


def _signal(result, signal_id, qid=Q1):
    q = _question(result, qid)
    return next((s for s in q["signals"] if s["id"] == signal_id), None) if q else None


# A full-weight-free weak pair used to corroborate a single moved signal in tier tests.
_SENTIMENT_TODAY = {"sentiment": "negative"}
_SENTIMENT_PAST = {"sentiment": "neutral"}


def _frame(qid=Q1, turn_state="user_answer", **fields) -> dict:
    return {"question_id": qid, "turn_state": turn_state, **fields}


# ── question_readings ───────────────────────────────────────────────────────

def test_question_readings_uses_only_user_answer_frames():
    frames = (
        [_frame(blink_rate_change_percent=10.0, pitch_hz=200.0, intensity_db=60.0, voiced=1) for _ in range(3)]
        + [_frame(turn_state="agent_question", blink_rate_change_percent=90.0, pitch_hz=400.0, intensity_db=90.0, voiced=1)]
        + [_frame(turn_state="idle", blink_rate_change_percent=90.0)]
        + [_frame(qid=Q2, blink_rate_change_percent=90.0, pitch_hz=400.0, intensity_db=90.0, voiced=1)]
        + [_frame(pitch_hz=400.0, intensity_db=90.0, voiced=0)]
    )
    r = question_readings(frames, [], QIDS)[Q1]
    assert r["blink_pct"] == 10.0
    assert r["pitch_hz"] == 200.0
    assert r["intensity_db"] == 60.0


def test_question_readings_insufficient_frames_is_none():
    frames = [_frame(pitch_hz=200.0, intensity_db=60.0, voiced=1, face_emotion="HAPPY", blink_rate_change_percent=5.0)
              for _ in range(2)]
    r = question_readings(frames, [], QIDS)[Q1]
    assert r["pitch_hz"] is None and r["intensity_db"] is None and r["face_emotion"] is None
    assert r["blink_pct"] is None  # two frames and no item row to fall back on


def test_blink_fallback_to_item_row():
    r = question_readings([], [{"question_id": Q1, "blink_rate_change_percent": 22.5}], QIDS)[Q1]
    assert r["blink_pct"] == 22.5


def test_latency_below_floor_ignored():
    items = [{"question_id": Q1, "response_latency_ms": 299}, {"question_id": Q2, "response_latency_ms": 300}]
    r = question_readings([], items, QIDS)
    assert r[Q1]["latency_ms"] is None
    assert r[Q2]["latency_ms"] == 300


def test_face_ignores_non_emotion_and_camera_off_frames():
    camera_off = [_frame(face_emotion="NEUTRAL") for _ in range(5)]  # session default, no camera reading
    no_face = [_frame(face_emotion="No face detected", blink_rate_bpm=14.0) for _ in range(5)]
    assert question_readings(camera_off + no_face, [], QIDS)[Q1]["face_emotion"] is None

    seen = [_frame(face_emotion=e, blink_rate_bpm=14.0) for e in ("NEUTRAL", "CALM", "CALM", "HAPPY")]
    assert question_readings(seen, [], QIDS)[Q1]["face_emotion"] == "CALM"  # NEUTRAL merged into CALM


def test_answer_uses_raw_score_not_effective():
    items = [{"question_id": "cbi_q3", "raw_score": 25, "effective_score": 75}]
    assert question_readings([], items, QIDS)["cbi_q3"]["answer"] == 25


def test_sentiment_from_item_row_not_frames():
    frames = [_frame(voice_sentiment="positive") for _ in range(5)]
    items = [{"question_id": Q1, "voice_sentiment": "Negative"}]
    assert question_readings(frames, items, QIDS)[Q1]["sentiment"] == "negative"
    assert question_readings(frames, [], QIDS)[Q1]["sentiment"] is None


# ── thresholds ──────────────────────────────────────────────────────────────

def test_semitones():
    assert semitones(220, 110) == pytest.approx(12)
    assert semitones(196, 196) == 0
    assert semitones(110, 220) == pytest.approx(-12)


@pytest.mark.parametrize("delta, tier", [(14.9, None), (15.0, "moved"), (39.9, "moved"), (40.0, "strong")])
@pytest.mark.parametrize("sign, direction", [(1, "higher"), (-1, "lower")])
def test_blink_moved_and_strong_tiers(delta, tier, sign, direction):
    result = _compare(_readings(**{Q1: {"blink_pct": sign * delta, **_SENTIMENT_TODAY}}),
                      _readings(**{Q1: {"blink_pct": 0.0, **_SENTIMENT_PAST}}))
    s = _signal(result, "blink") if result else None
    if tier is None:
        assert s is None
    else:
        assert s["tier"] == tier and s["direction"] == direction and s["unit"] == "pp"


@pytest.mark.parametrize("ratio, tier, direction", [
    (1.24, None, None), (1.25, "moved", "longer"), (2.0, "strong", "longer"),
    (0.76, None, None), (0.75, "moved", "shorter"), (0.5, "strong", "shorter"),
])
def test_latency_tiers_both_directions(ratio, tier, direction):
    result = _compare(_readings(**{Q1: {"latency_ms": 2000 * ratio, **_SENTIMENT_TODAY}}),
                      _readings(**{Q1: {"latency_ms": 2000.0, **_SENTIMENT_PAST}}))
    s = _signal(result, "latency") if result else None
    if tier is None:
        assert s is None
    else:
        assert s["tier"] == tier and s["direction"] == direction


@pytest.mark.parametrize("base_hz", [110.0, 220.0])
@pytest.mark.parametrize("st, tier", [(0.9, None), (1.0, "moved"), (2.0, "strong")])
def test_pitch_tiers_in_semitones(base_hz, st, tier):
    today_hz = base_hz * 2 ** (st / 12)
    result = _compare(_readings(**{Q1: {"pitch_hz": today_hz, **_SENTIMENT_TODAY}}),
                      _readings(**{Q1: {"pitch_hz": base_hz, **_SENTIMENT_PAST}}))
    s = _signal(result, "pitch") if result else None
    if tier is None:
        assert s is None
    else:
        assert s["tier"] == tier and s["direction"] == "higher" and s["unit"] == "st"


def test_intensity_uses_run_median_not_past():
    flat_today = {qid: {"intensity_db": 70.0} for qid in QIDS}
    flat_past = {qid: {"intensity_db": 60.0} for qid in QIDS}  # +10 dB across sessions
    flat_today[Q1].update(_SENTIMENT_TODAY)
    flat_past[Q1].update(_SENTIMENT_PAST)
    assert _steady(_compare(_readings(**flat_today), _readings(**flat_past)))

    flat_today[Q1]["intensity_db"] = 73.0  # 3 dB above this run's other answers
    s = _signal(_compare(_readings(**flat_today), _readings(**flat_past)), "intensity")
    assert s["tier"] == "moved" and s["direction"] == "louder" and s["reference"] == "today"


# ── surfacing ───────────────────────────────────────────────────────────────

def test_weak_signals_cannot_surface_alone():
    assert _steady(_compare(_readings(**{Q1: {"sentiment": "negative", "face_emotion": "SURPRISED"}}),
                            _readings(**{Q1: {"sentiment": "neutral", "face_emotion": "CALM"}})))


def test_two_moved_with_one_full_weight_surfaces():
    result = _compare(_readings(**{Q1: {"blink_pct": 20.0, **_SENTIMENT_TODAY}}),
                      _readings(**{Q1: {"blink_pct": 0.0, **_SENTIMENT_PAST}}))
    assert _question(result)["surfacedBy"] == "corroborated"


def test_single_strong_surfaces():
    result = _compare(_readings(**{Q1: {"latency_ms": 5000.0}}), _readings(**{Q1: {"latency_ms": 2000.0}}))
    q = _question(result)
    assert q["surfacedBy"] == "strong" and [s["id"] for s in q["signals"]] == ["latency"]


def test_single_moved_is_silent():
    assert _steady(_compare(_readings(**{Q1: {"blink_pct": 20.0}}), _readings(**{Q1: {"blink_pct": 0.0}})))


def test_reference_is_median_of_window():
    past = [_readings(**{Q1: {"latency_ms": v}}) for v in (2000.0, 2100.0, 9000.0)]
    result = _compare(_readings(**{Q1: {"latency_ms": 4200.0}}), *past)
    assert _signal(result, "latency")["past"] == 2100.0  # median, so the 9000 outlier doesn't pull it

    # A fourth, older run is outside the reference window.
    four = past + [_readings(**{Q1: {"latency_ms": 2050.0}})]
    result = _compare(_readings(**{Q1: {"latency_ms": 9000.0}}), *four)
    assert result["referenceCount"] == 3
    assert result["referenceRunIds"] == ["run-0", "run-1", "run-2"]


def test_personal_tier_only_tightens():
    # Wide spread across 4+ runs: a 25-point blink change no longer counts as "moved".
    wide = [_readings(**{Q1: {"blink_pct": v, **_SENTIMENT_PAST}}) for v in (0.0, 20.0, -20.0, 25.0, -25.0)]
    assert _steady(_compare(_readings(**{Q1: {"blink_pct": 25.0, **_SENTIMENT_TODAY}}), *wide))

    # Tiny spread: thresholds stay at the fixed ones, never lower.
    tight = [_readings(**{Q1: {"blink_pct": v, **_SENTIMENT_PAST}}) for v in (0.0, 0.5, -0.5, 0.2)]
    assert _steady(_compare(_readings(**{Q1: {"blink_pct": 14.0, **_SENTIMENT_TODAY}}), *tight))
    result = _compare(_readings(**{Q1: {"blink_pct": 15.5, **_SENTIMENT_TODAY}}), *tight)
    assert _signal(result, "blink")["tier"] == "moved"
    assert result["tier"] == "personal"
    assert _compare(_readings(**{Q1: {"blink_pct": 15.5, **_SENTIMENT_TODAY}}), *tight[:3])["tier"] == "fixed"


def test_answer_labels_from_options():
    bat = _compare(_readings(**{Q1: {"answer": 4, "latency_ms": 5000.0}}),
                   _readings(**{Q1: {"answer": 2, "latency_ms": 2000.0}}))
    a = _question(bat)["answer"]
    assert (a["previousLabel"], a["currentLabel"], a["changed"]) == ("Rarely", "Often", True)

    cbi = _compare(_readings(**{"cbi_q1": {"answer": 75, "latency_ms": 5000.0}}),
                   _readings(**{"cbi_q1": {"answer": 25, "latency_ms": 2000.0}}))
    a = _question(cbi, "cbi_q1")["answer"]
    assert (a["previousLabel"], a["currentLabel"], a["changed"]) == ("Seldom", "Often", True)

    same = _compare(_readings(**{Q1: {"answer": 3, "latency_ms": 5000.0}}),
                    _readings(**{Q1: {"answer": 3, "latency_ms": 2000.0}}))
    assert _question(same)["answer"]["changed"] is False

    one_step = _compare(_readings(**{Q1: {"answer": 3, "latency_ms": 5000.0}}),
                        _readings(**{Q1: {"answer": 2, "latency_ms": 2000.0}}))
    assert _question(one_step)["answer"]["changed"] is True


def test_every_question_listed_in_survey_order():
    strong = {"latency_ms": 5000.0}                   # 1 strong
    two_moved = {"blink_pct": 20.0, "sentiment": "negative"}
    today = _readings(**{
        "bat_q1": dict(strong, answer=3),
        "bat_q2": dict(two_moved, answer=3),
        "bat_q3": dict(two_moved, answer=4),          # answer changed → first
        "bat_q4": dict(strong, blink_pct=20.0, answer=3),  # 1 strong + 1 moved
    })
    past = _readings(**{q: {"latency_ms": 2000.0, "blink_pct": 0.0, "sentiment": "neutral", "answer": 3}
                        for q in ("bat_q1", "bat_q2", "bat_q3", "bat_q4")})
    result = _compare(today, past)
    assert [q["questionId"] for q in result["questions"]] == QIDS  # all of them, survey order
    assert [_status(result, q) for q in ("bat_q1", "bat_q2", "bat_q3", "bat_q4")] == ["changed"] * 4
    assert all(_status(result, q) == "no_data" for q in QIDS[4:])


def test_steady_vs_no_data():
    # Blink compared but unmoved → steady; no reading on one side → no_data.
    today = _readings(**{Q1: {"blink_pct": 5.0}, Q2: {"blink_pct": 5.0}})
    past = _readings(**{Q1: {"blink_pct": 0.0}})
    result = _compare(today, past)
    assert _status(result, Q1) == "steady"
    assert _status(result, Q2) == "no_data"
    assert _question(result, Q2)["signals"] == [] and _question(result, Q2)["surfacedBy"] is None


def test_camera_off_question_is_no_data_not_steady():
    # Face labels without a camera reading never reach the readings (question_readings), so
    # only the answer is left: nothing compared.
    result = _compare(_readings(**{Q1: {"answer": 3}, Q2: {"blink_pct": 5.0}}),
                      _readings(**{Q1: {"answer": 3}, Q2: {"blink_pct": 0.0}}))
    assert _status(result, Q1) == "no_data"
    assert _question(result, Q1)["answer"]["currentLabel"] == "Sometimes"  # the answer is still shown


def test_steady_hides_single_moved_signal():
    result = _compare(_readings(**{Q1: {"blink_pct": 30.0}}), _readings(**{Q1: {"blink_pct": 0.0}}))
    assert _steady(result)  # blink moved 30 points, but alone it isn't printed


def test_all_no_data_is_none():
    assert _compare(_readings(**{Q1: {"answer": 3}}), _readings(**{Q1: {"answer": 2}})) is None


def test_no_previous_run_is_none():
    assert _compare(_readings(**{Q1: {"latency_ms": 5000.0}})) is None


def test_non_pilot_is_none():
    assert _compare(_readings(**{Q1: {"latency_ms": 5000.0}}), _readings(**{Q1: {"latency_ms": 2000.0}}),
                    survey_type="TEST") is None


def test_today_support_clause():
    today = _readings(**{Q1: {"blink_pct": 30.0, **_SENTIMENT_TODAY}})
    assert _signal(_compare(today, _readings(**{Q1: {"blink_pct": 0.0, **_SENTIMENT_PAST}})), "blink")[
        "todaySupport"] == "above_baseline"
    today[Q1]["blink_pct"] = 10.0  # moved vs a past of -10, but within ±15 of today's baseline
    assert _signal(_compare(today, _readings(**{Q1: {"blink_pct": -10.0, **_SENTIMENT_PAST}})), "blink")[
        "todaySupport"] is None


def test_result_never_mentions_pupil():
    result = _compare(_readings(**{Q1: {"latency_ms": 5000.0, "blink_pct": 30.0}}),
                      _readings(**{Q1: {"latency_ms": 2000.0, "blink_pct": 0.0}}))
    assert "pupil" not in json.dumps(result).lower()
    assert "pupil" not in json.dumps(SIGNAL_CONFIG).lower()


def test_signal_config_covers_every_signal():
    signals = SIGNAL_CONFIG["signals"]
    assert set(signals) == set(SIGNAL_ORDER)
    for signal_id, rule in signals.items():
        assert {"weight", "moved", "strong"} <= set(rule)
        if rule["weight"] == "weak":
            assert rule["strong"] is None


def test_compare_does_not_mutate_inputs():
    today = _readings(**{Q1: {"latency_ms": 5000.0}})
    past = _readings(**{Q1: {"latency_ms": 2000.0}})
    before = copy.deepcopy((today, past))
    _compare(today, past)
    assert (today, past) == before


# ── spoken lines (voice report STEP 4) ──────────────────────────────────────

_SPOKEN_FORBIDDEN = re.compile(
    r"\b(lie|honest\w*|mismatch\w*|contradict\w*|verdict|pass|fail\w*|detect\w*|stress\w*|anxious|"
    r"suggests?|because|means|should|try|consider|pupil|gaze|burnout)\b", re.IGNORECASE)


def _changed_q(qid, *, answer_changed=False, strong=0, moved=1, previous="Rarely", current="Often"):
    signals = ([{"id": "latency", "direction": "shorter", "tier": "strong", "today": 900, "past": 2400}] * strong
               + [{"id": "blink", "direction": "higher", "tier": "moved", "today": 20, "past": 0}] * moved)
    return {"questionId": qid, "prompt": "p", "status": "changed",
            "answer": {"changed": answer_changed, "previousLabel": previous,
                       "currentLabel": current if answer_changed else previous},
            "signals": signals}


def _quiet_q(qid, status="steady"):
    return {"questionId": qid, "prompt": "p", "status": status,
            "answer": {"changed": False, "previousLabel": "Often", "currentLabel": "Often"}, "signals": []}


def _spoken(*questions, reference_count=1):
    return signal_spoken_lines({"referenceCount": reference_count, "questions": list(questions)}, PILOT)


def test_every_pilot_question_has_a_short_label_in_the_payload():
    result = _compare(_readings(**{Q1: {"latency_ms": 5000.0}}), _readings(**{Q1: {"latency_ms": 2000.0}}))
    labels = {q["questionId"]: q["shortLabel"] for q in result["questions"]}
    assert labels["bat_q1"] == "Mental exhaustion"
    assert labels["cbi_q3"] == "Energy for family and friends"
    for q in PILOT["questions"]:
        assert q.get("short") and not re.search(r"\d", q["short"]), q["id"]


def test_every_pilot_question_has_a_spoken_phrase():
    for q in PILOT["questions"]:
        assert q.get("spoken"), q["id"]
        assert not re.search(r"\d", q["spoken"])


LEAD_ONE = "Compared with your last check-in, here's what was recorded while you were answering."


def test_spoken_lines_nothing_to_say():
    assert signal_spoken_lines(None, PILOT) == []
    assert signal_spoken_lines({"referenceCount": 1, "questions": []}, PILOT) == []


def test_spoken_lines_cover_every_question_in_survey_order():
    lines = _spoken(*[_changed_q(qid) for qid in QIDS])
    assert lines[0] == LEAD_ONE
    assert len(lines) == 1 + len(QIDS)  # no cap, no "more on your screen" line
    phrases = [q["spoken"] for q in PILOT["questions"]]
    for line, phrase in zip(lines[1:], phrases, strict=True):
        assert line.startswith(f"On {phrase},")
    assert not any("on your screen" in line for line in lines)


def test_neighbouring_quiet_questions_are_grouped_by_status():
    lines = _spoken(
        _changed_q("bat_q1"),
        _quiet_q("bat_q2"), _quiet_q("bat_q3"),                        # steady run
        _changed_q("bat_q4"),
        _quiet_q("cbi_q1", "no_data"), _quiet_q("cbi_q2", "no_data"),  # no_data run
        _quiet_q("cbi_q3"),                                            # steady again
    )
    assert lines[2] == ("On finding enthusiasm for your work and staying focused at work, "
                        "there was no notable change in your signals.")
    assert lines[3].startswith("On keeping control of your emotions at work, your answer was the same")
    assert lines[4] == ("On whether your work is emotionally exhausting and feeling exhausted in the morning at the "
                        "thought of another day at work, there weren't enough readings to compare.")
    assert lines[5] == ("On having enough energy for family and friends in your free time, "
                        "there was no notable change in your signals.")
    assert len(lines) == 6


def test_three_quiet_questions_join_with_commas_and_and():
    lines = _spoken(_quiet_q("bat_q1"), _quiet_q("bat_q2"), _quiet_q("bat_q3"), _changed_q("bat_q4"))
    assert lines[1] == ("On feeling mentally exhausted at work, finding enthusiasm for your work and staying "
                        "focused at work, there was no notable change in your signals.")


def test_all_steady_is_one_sentence():
    assert _spoken(*[_quiet_q(qid) for qid in QIDS]) == [
        LEAD_ONE, "There was no notable change in your signals on any of the questions."]


def test_spoken_answer_templates_and_reference():
    same = _spoken(_changed_q("cbi_q1", previous="Never / Almost Never"), reference_count=3)
    assert same[0] == "Compared with your recent check-ins, here's what was recorded while you were answering."
    assert same[1] == ("On whether your work is emotionally exhausting, your answer was the same as last time; "
                       "while you answered, your blink rate was higher than last time.")
    changed = _spoken(_changed_q("cbi_q1", answer_changed=True, previous="Never / Almost Never", current="Often"))
    assert "you said often this time, where last time you said never or almost never;" in changed[1]


def test_spoken_lines_have_no_numbers_or_forbidden_words():
    directions = {"blink": ("higher", "lower"), "latency": ("longer", "shorter"), "pitch": ("higher", "lower"),
                  "intensity": ("louder", "quieter")}
    signals = [{"id": sid, "direction": d, "tier": t, "today": 1.5, "past": 2.5}
               for sid, ds in directions.items() for d, t in itertools.product(ds, ("moved", "strong"))]
    signals += [{"id": "sentiment", "direction": "changed", "tier": "moved", "today": a, "past": b}
                for a, b in itertools.permutations(("negative", "neutral", "positive"), 2)]
    signals += [{"id": "face", "direction": "changed", "tier": "moved", "today": "SURPRISED", "past": "NEUTRAL"}]
    for i, signal in enumerate(signals):
        q = _changed_q(QIDS[i % len(QIDS)], answer_changed=bool(i % 2), previous="Never / Almost Never")
        q["signals"] = [signal]
        quiet = [_quiet_q(qid, "steady" if j % 2 else "no_data") for j, qid in enumerate(QIDS) if qid != q["questionId"]]
        for line in _spoken(q, *quiet, reference_count=1 + i % 3):
            assert not re.search(r"\d", line), line
            assert not _SPOKEN_FORBIDDEN.search(line), line

