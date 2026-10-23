"""Compare a PILOT run's per-question signals with the same person's previous PILOT runs.

Pure helpers (no I/O), used by the report card "Your signals, compared with your past
check-ins" (GET /me/reports/{runId}/signal-comparison, ciq/reports/signal_comparison_routes.py).
Design: docs/signal-comparison.md.

Descriptive only (the biometric guardrail): this states which of the person's own
signals moved during a question, against their own history, and nothing else — no
meaning, cause or judgement of the answer. Pupil is never read. Every reference is
the person's own: their previous PILOT runs ("past", which decides whether a signal
moved) and this run itself ("today", which only adds a supporting clause).

Every question is listed with a status (changed / steady / no_data). Nothing to
show (not PILOT, first PILOT run, nothing comparable at all) → None, and the card
is hidden.
"""
import math
from collections import Counter
from statistics import median

from ciq.reports.comparison import _parse_date
from survey_loader import option_label, options_for_question

# Product judgement, not validated thresholds (like zone.ZONE_CONFIG): no source gives
# an absolute cut-off for any of these signals, so each is compared with the person's
# own history. Tune from pilot data without touching the logic below.
SIGNAL_CONFIG = {
    "signals": {
        # Percentage points of baseline-relative blink change; mirrors
        # survey_loader.blink_band (Normal within ±15%, High beyond 40%).
        "blink": {"weight": "full", "moved": 15.0, "strong": 40.0},
        # Ratio today ÷ past (zone.ZONE_CONFIG slower_ratio = 1.25, mirrored downward).
        "latency": {"weight": "full", "moved": 1.25, "strong": 2.0, "moved_faster": 0.75, "strong_faster": 0.5},
        # Semitones, so one rule fits low and high voices (1 st ≈ just noticeable).
        "pitch": {"weight": "full", "moved": 1.0, "strong": 2.0},
        # dB vs this run's other answers only — mic distance/gain differ between sessions.
        "intensity": {"weight": "full", "moved": 3.0, "strong": 6.0},
        # Weak signals: a change counts only alongside a full-weight one; never strong.
        "sentiment": {"weight": "weak", "moved": None, "strong": None},
        "face": {"weight": "weak", "moved": None, "strong": None},
    },
    "reference_window": 3,        # previous runs whose median is "past"
    "personal_tier_min_runs": 4,  # from this many previous runs, the person's own spread applies
    "personal_window": 6,         # runs the spread is measured over
    "min_frames": 3,              # qualifying per-second frames for a frame-based reading
    "min_latency_ms": 300,        # below this a latency is VAD noise
    "spread_moved_factor": 1.5,
    "spread_strong_factor": 3.0,
    # Voice report only: an answer this many scale steps (Never → Rarely → …) from EVERY
    # one of the previous answer_history_runs answers is spoken as a shift worth reflecting on.
    "answer_shift_steps": 2,
    "answer_history_runs": 2,
}

SIGNAL_ORDER = ("blink", "latency", "pitch", "intensity", "sentiment", "face")

# Real Rekognition emotion labels. NEUTRAL (the session's default) is merged into CALM;
# anything else ("No face detected", "multiple_faces_detected", ...) is not an emotion.
_FACE_LABELS = {"HAPPY", "SAD", "ANGRY", "CONFUSED", "DISGUSTED", "SURPRISED", "CALM", "FEAR"}
_SENTIMENTS = ("negative", "neutral", "positive")
_MAD_SCALE = 1.4826  # scales a median absolute deviation to a standard deviation
_EPS = 1e-9          # so a reading exactly on a threshold counts as reaching it


def semitones(today_hz: float, ref_hz: float) -> float:
    """Pitch difference in semitones: 12·log2(today ÷ ref)."""
    return 12 * math.log2(today_hz / ref_hz)


def _num(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _face_label(value) -> str | None:
    label = str(value or "").strip().upper()
    if label == "NEUTRAL":
        return "CALM"
    return label if label in _FACE_LABELS else None


def _has_camera(frame: dict) -> bool:
    return _num(frame.get("blink_rate_change_percent")) is not None or _num(frame.get("blink_rate_bpm")) is not None


def question_readings(frames: list[dict], item_responses: list[dict], question_ids: list[str]) -> dict[str, dict]:
    """One run's reading of every signal per question; each None when there isn't enough data.

    Frame-based readings use only the question's `user_answer` frames (the person
    speaking): blink = mean, pitch = median and intensity = mean over voiced frames,
    face = the most common real emotion label over frames with a camera reading.
    Latency, sentiment and the answer (raw_score — the words the person chose) come
    from the item row; blink falls back to it when there are too few frames.
    """
    min_frames = SIGNAL_CONFIG["min_frames"]
    items = {r.get("question_id"): r for r in item_responses}
    readings = {}
    for qid in question_ids:
        answering = [f for f in frames if f.get("question_id") == qid and f.get("turn_state") == "user_answer"]
        item = items.get(qid) or {}

        blinks = [v for v in (_num(f.get("blink_rate_change_percent")) for f in answering) if v is not None]
        blink = sum(blinks) / len(blinks) if len(blinks) >= min_frames else _num(item.get("blink_rate_change_percent"))

        voiced = [f for f in answering if f.get("voiced") == 1]
        pitches = [v for v in (_num(f.get("pitch_hz")) for f in voiced) if v is not None and v > 0]
        levels = [v for v in (_num(f.get("intensity_db")) for f in voiced) if v is not None]

        faces = [lbl for lbl in (_face_label(f.get("face_emotion")) for f in answering if _has_camera(f)) if lbl]

        latency = _num(item.get("response_latency_ms"))
        sentiment = str(item.get("voice_sentiment") or "").strip().lower()

        readings[qid] = {
            "blink_pct": blink,
            "latency_ms": latency if latency is not None and latency >= SIGNAL_CONFIG["min_latency_ms"] else None,
            "pitch_hz": median(pitches) if len(pitches) >= min_frames else None,
            "intensity_db": sum(levels) / len(levels) if len(levels) >= min_frames else None,
            "sentiment": sentiment if sentiment in _SENTIMENTS else None,
            "face_emotion": Counter(faces).most_common(1)[0][0] if len(faces) >= min_frames else None,
            "answer": _num(item.get("raw_score")),
        }
    return readings


# ── Per-signal comparison ─────────────────────────────────────────────────────

def _spread(values: list[float]) -> float | None:
    """Scaled median absolute deviation, or None with too few values to trust."""
    if len(values) < SIGNAL_CONFIG["personal_tier_min_runs"]:
        return None
    mid = median(values)
    return _MAD_SCALE * median(abs(v - mid) for v in values)


def _thresholds(fixed_moved: float, fixed_strong: float, spread: float | None, config: dict) -> tuple[float, float]:
    """The person's own spread can only make a threshold stricter, never looser."""
    if spread is None:
        return fixed_moved, fixed_strong
    return (max(fixed_moved, config["spread_moved_factor"] * spread),
            max(fixed_strong, config["spread_strong_factor"] * spread))


def _tier(magnitude: float, moved: float, strong: float) -> str | None:
    if magnitude >= strong - _EPS:
        return "strong"
    if magnitude >= moved - _EPS:
        return "moved"
    return None


def _others(readings: dict, qid: str, key: str) -> list[float]:
    return [r[key] for q, r in readings.items() if q != qid and r.get(key) is not None]


def _blink(qid, today, past_values, spread_values, run, config):
    rule = config["signals"]["blink"]
    past = median(past_values)
    delta = today - past
    moved, strong = _thresholds(rule["moved"], rule["strong"], _spread(spread_values), config)
    tier = _tier(abs(delta), moved, strong)
    if not tier:
        return None
    direction = "higher" if delta > 0 else "lower"
    support = None
    if direction == "higher" and today >= rule["moved"] - _EPS:
        support = "above_baseline"
    elif direction == "lower" and today <= -rule["moved"] + _EPS:
        support = "below_baseline"
    return _change("blink", direction, tier, "past", today, past, delta, "pp", support)


def _latency(qid, today, past_values, spread_values, run, config):
    rule = config["signals"]["latency"]
    past = median(past_values)
    ratio = today / past
    spread = _spread([math.log(v) for v in spread_values])
    if ratio >= 1:
        moved, strong = _thresholds(math.log(rule["moved"]), math.log(rule["strong"]), spread, config)
        tier, direction = _tier(math.log(ratio), moved, strong), "longer"
    else:
        moved, strong = _thresholds(-math.log(rule["moved_faster"]), -math.log(rule["strong_faster"]), spread, config)
        tier, direction = _tier(-math.log(ratio), moved, strong), "shorter"
    if not tier:
        return None
    support = None
    others = _others(run, qid, "latency_ms")
    if others:
        run_ratio = today / median(others)
        if direction == "longer" and run_ratio >= rule["moved"] - _EPS:
            support = "above_run_median"
        elif direction == "shorter" and run_ratio <= rule["moved_faster"] + _EPS:
            support = "below_run_median"
    return _change("latency", direction, tier, "past", today, past, (ratio - 1) * 100, "%", support)


def _pitch(qid, today, past_values, spread_values, run, config):
    rule = config["signals"]["pitch"]
    past = median(past_values)
    delta = semitones(today, past)
    spread = _spread([semitones(v, past) for v in spread_values])
    moved, strong = _thresholds(rule["moved"], rule["strong"], spread, config)
    tier = _tier(abs(delta), moved, strong)
    if not tier:
        return None
    direction = "higher" if delta > 0 else "lower"
    support = None
    others = _others(run, qid, "pitch_hz")
    if others:
        run_delta = semitones(today, median(others))
        if (run_delta if direction == "higher" else -run_delta) >= rule["moved"] - _EPS:
            support = "above_run_median" if direction == "higher" else "below_run_median"
    return _change("pitch", direction, tier, "past", today, past, delta, "st", support)


def _intensity(qid, run, config):
    """Within this run only: the answer vs the median of the person's other answers today."""
    rule = config["signals"]["intensity"]
    today = run[qid]["intensity_db"]
    others = _others(run, qid, "intensity_db")
    if today is None or not others:
        return None
    reference = median(others)
    delta = today - reference
    tier = _tier(abs(delta), rule["moved"], rule["strong"])
    if not tier:
        return None
    return _change("intensity", "louder" if delta > 0 else "quieter", tier, "today", today, reference, delta, "dB", None)


def _category(signal_id: str, today, past):
    if today is None or past is None or today == past:
        return None
    return _change(signal_id, "changed", "moved", "past", today, past, None, None, None)


def _rnd(value):
    return round(value, 2) if isinstance(value, float) else value


def _change(signal_id, direction, tier, reference, today, past, delta, unit, support) -> dict:
    return {
        "id": signal_id,
        "direction": direction,
        "tier": tier,
        "reference": reference,
        "today": _rnd(today),
        "past": _rnd(past),
        "delta": _rnd(delta),
        "unit": unit,
        "todaySupport": support,
    }


_NUMERIC = {"blink": ("blink_pct", _blink), "latency": ("latency_ms", _latency), "pitch": ("pitch_hz", _pitch)}


def _question_signals(qid: str, run: dict, history: list[dict], config: dict) -> tuple[list[dict], int]:
    """The signals that moved for one question, in SIGNAL_ORDER, and how many signals
    had a reading on both sides to compare at all. `history` = previous runs'
    readings, newest first, up to personal_window."""
    window = history[: config["reference_window"]]
    signals = []
    compared = 0
    for signal_id in SIGNAL_ORDER:
        if signal_id in _NUMERIC:
            key, compare = _NUMERIC[signal_id]
            today = run[qid].get(key)
            past_values = [h[qid][key] for h in window if h.get(qid, {}).get(key) is not None]
            if today is None or not past_values:
                continue
            spread_values = [h[qid][key] for h in history if h.get(qid, {}).get(key) is not None]
            change = compare(qid, today, past_values, spread_values, run, config)
        elif signal_id == "intensity":
            if run[qid].get("intensity_db") is None or not _others(run, qid, "intensity_db"):
                continue
            change = _intensity(qid, run, config)
        else:
            key = "sentiment" if signal_id == "sentiment" else "face_emotion"
            last = next((h[qid][key] for h in history if h.get(qid, {}).get(key) is not None), None)
            if run[qid].get(key) is None or last is None:
                continue
            change = _category(signal_id, run[qid].get(key), last)
        compared += 1
        if change:
            signals.append(change)
    return signals, compared


def _surfaced_by(signals: list[dict], config: dict) -> str | None:
    if any(s["tier"] == "strong" for s in signals):
        return "strong"
    full = [s for s in signals if config["signals"][s["id"]]["weight"] == "full"]
    if len(signals) >= 2 and full:
        return "corroborated"
    return None


def _answer(qid: str, run: dict, history: list[dict], survey_config: dict) -> dict:
    current = run[qid].get("answer")
    answered = [h[qid]["answer"] for h in history if h.get(qid, {}).get("answer") is not None]
    previous = answered[0] if answered else None
    recent = answered[: SIGNAL_CONFIG["answer_history_runs"]]

    def label(value):
        return option_label(survey_config, qid, int(value)) if value is not None else None

    return {
        "previousLabel": label(previous),
        "currentLabel": label(current),
        "previousValue": int(previous) if previous is not None else None,
        "currentValue": int(current) if current is not None else None,
        "changed": current is not None and previous is not None and current != previous,
        # The last few answers, newest first (the voice report's answer-shift rule).
        "recentValues": [int(v) for v in recent],
        "recentLabels": [label(v) for v in recent],
    }


def compare_signals(current: dict, previous: list[dict], config: dict, survey_config: dict) -> dict | None:
    """The card's payload (see docs/signal-comparison.md for the contract), or None.

    `current` and each `previous` are {"record": survey_records row, "readings":
    question_readings(...)}; `previous` holds the person's earlier, non-demo, scored
    PILOT runs, newest first.

    Every question is listed, in survey order, with a status: "changed" (meets the
    surfacing rule — its moved signals are listed), "steady" (signals were compared
    but none meets the rule — no signal is listed, so a lone small movement is never
    shown) or "no_data" (nothing to compare). None when it isn't PILOT, there is no
    earlier run, or every question is "no_data".
    """
    if (current["record"].get("survey_type") or "").upper() != "PILOT" or not previous:
        return None
    history_runs = previous[: config["personal_window"]]
    history = [p["readings"] for p in history_runs]
    run = current["readings"]

    questions = []
    for q in survey_config.get("questions", []):
        qid = q.get("id")
        if qid not in run:
            continue
        signals, compared = _question_signals(qid, run, history, config)
        by = _surfaced_by(signals, config)
        status = "changed" if by else ("steady" if compared else "no_data")
        questions.append({
            "questionId": qid,
            "label": q.get("domain") or q.get("text") or qid,
            "shortLabel": q.get("short") or q.get("domain") or q.get("text") or qid,
            "prompt": q.get("prompt") or q.get("text") or "",
            "answer": _answer(qid, run, history, survey_config),
            "status": status,
            "surfacedBy": by,
            "signals": signals if by else [],
        })
    if all(q["status"] == "no_data" for q in questions):
        return None

    references = history_runs[: config["reference_window"]]
    latest = references[0]["record"]
    cur_date, ref_date = _parse_date(current["record"].get("created_at")), _parse_date(latest.get("created_at"))
    return {
        "surveyRunId": current["record"].get("survey_run_id"),
        "referenceRunIds": [p["record"].get("survey_run_id") for p in references],
        "referenceCount": len(references),
        "latestReferenceDate": latest.get("created_at"),
        "daysSinceLatest": (cur_date.date() - ref_date.date()).days if cur_date and ref_date else None,
        "tier": "personal" if len(previous) >= config["personal_tier_min_runs"] else "fixed",
        "questions": questions,
    }


# ── Spoken lines (the PILOT voice report's question-by-question section,
#    ciq/realtime/report_signals.py) ──

def _spoken_label(label: str | None) -> str:
    return (label or "").replace(" / ", " or ").lower()


def _spoken_face(label) -> str:
    word = str(label or "").lower()
    return "calm" if word == "neutral" else word


def _clause(s: dict) -> str:
    """One signal as a spoken clause — no numbers, "notably" for the strong tier. The
    comparison point ("your past check-ins") is set once by the section's lead line."""
    notably = "notably " if s["tier"] == "strong" else ""
    d = s["direction"]
    if s["id"] == "blink":
        return f"your blink rate was {notably}{d}"
    if s["id"] == "latency":
        return (f"your reply came {notably}more quickly" if d == "shorter"
                else f"you paused {notably}longer before replying")
    if s["id"] == "pitch":
        return f"your voice was {notably}{d} in pitch"
    if s["id"] == "intensity":
        return f"you spoke {notably}{'more quietly' if d == 'quieter' else 'more loudly'} than on your other answers"
    if s["id"] == "sentiment":
        more = "more negative" if _SENTIMENTS.index(s["today"]) < _SENTIMENTS.index(s["past"]) else "more positive"
        return f"the tone of your words read as {more}"
    return f"your expression read as {_spoken_face(s['today'])} rather than {_spoken_face(s['past'])}"


def _join(parts: list[str]) -> str:
    return parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"


def _answer_shifted(qid: str, answer: dict, survey_config: dict) -> bool:
    """True when today's answer is answer_shift_steps or more scale steps away from EVERY
    one of the recent previous answers (one close answer is enough to count as in line).
    Raw values, so a reverse-scored item needs no special case."""
    values = [o.get("value") for o in options_for_question(survey_config, qid)]
    current, recent = answer.get("currentValue"), answer.get("recentValues") or []
    if current not in values or not recent or any(v not in values for v in recent):
        return False
    steps = SIGNAL_CONFIG["answer_shift_steps"]
    return all(abs(values.index(current) - values.index(v)) >= steps for v in recent)


def _said_before(answer: dict) -> str:
    """Where the earlier answers were, in words: "last time you said often" / "before, you
    said often both times" / "before, you said always, then often"."""
    labels = [_spoken_label(lbl) for lbl in answer.get("recentLabels") or [] if lbl]
    if len(labels) < 2:
        return f"last time you said {labels[0]}" if labels else "before you answered differently"
    newest, older = labels[0], labels[1]
    if newest == older:
        return f"before, you said {newest} both times"
    return f"before, you said {older}, then {newest}"


def _your_answer(answer: dict) -> str:
    label = _spoken_label(answer.get("currentLabel"))
    return f"your answer of {label}" if label else "your answer"


# A reflection after a question whose signals moved notably. An observation and an
# invitation to reflect — never a verdict on the answer. Rotated so the passage doesn't
# repeat one sentence. {answer} is "your answer of <label>", always mid-sentence. Kept
# short: the whole report is one spoken response with an output cap.
_SIGNAL_REFLECTIONS = (
    "So {answer} may not be the whole story.",
    "This one may sit closer to home than {answer} shows.",
    "Here, {answer} may be only part of the picture.",
)

# A reflection after an answer that moved a long way from the recent ones (signals steady).
_SHIFT_REFLECTIONS = (
    "That's quite a shift — worth asking whether {current} fits a usual week, or mostly today.",
    "That's a big move — {current} may reflect lately more than a usual week.",
)


def _changed_line(subject: str, q: dict, shifted: bool, turn: int) -> str:
    """Case A: notable signal movement — what moved, then a gentle reflection."""
    a = q["answer"]
    clauses = _join([_clause(s) for s in q["signals"]])
    current = _spoken_label(a["currentLabel"])
    if shifted:
        said = f"you said {current}, a big shift from before, and while you answered, "
    elif a["changed"]:
        said = f"you said {current}, after {_spoken_label(a['previousLabel'])} last time, and while you answered, "
    elif a["previousLabel"]:
        said = "same answer as last time, but while you answered, "
    else:
        said = "while you answered, "
    reflection = _SIGNAL_REFLECTIONS[turn % len(_SIGNAL_REFLECTIONS)].format(answer=_your_answer(a))
    return f"On {subject}, {said}{clauses}. {reflection}"


def _shift_line(subject: str, q: dict, turn: int) -> str:
    """Case C: signals steady, but the answer moved a long way from the recent ones."""
    a = q["answer"]
    current = _spoken_label(a["currentLabel"])
    reflection = _SHIFT_REFLECTIONS[turn % len(_SHIFT_REFLECTIONS)].format(current=current)
    return f"On {subject}, you said {current}, where {_said_before(a)}. {reflection}"


# Case B endings, keyed by (status, whether earlier answers were there to line up with).
_QUIET_ENDINGS = {
    ("steady", True): "nothing notable changed",
    ("steady", False): "your signals were steady",
    ("no_data", True): "your answers were in line with before, with too few readings to compare signals",
    ("no_data", False): "there weren't enough readings to compare",
}


def signal_spoken_lines(result: dict | None, survey_config: dict) -> list[str]:
    """Fixed sentences for the voice report's question-by-question section: every question,
    in survey order (the card's order).

    A. signals moved notably ("changed") → its own sentence: what moved, the answer then →
       now, and a gentle reflection that the answer may not be the whole picture;
    B. otherwise, an answer in line with at least one of the recent ones → grouped with
       its quiet neighbours into one short "no notable change" sentence;
    C. otherwise (answer_shift_steps or more from all of them) → its own sentence naming
       the shift and inviting reflection.
    Observations and invitations only — never a verdict on the answer. No numbers.
    [] when there is nothing to say."""
    questions = (result or {}).get("questions") or []
    if not questions:
        return []
    # Each question by its short name ("morning exhaustion"): the passage covers every
    # question in one spoken response with an output cap, so names are kept brief.
    phrases = {q.get("id"): (q.get("short") or "").lower() or q.get("spoken") or q.get("prompt")
               for q in survey_config.get("questions", [])}

    def subject(q: dict) -> str:
        return phrases.get(q["questionId"]) or q["prompt"]

    reference = "your recent check-ins" if result.get("referenceCount", 1) > 1 else "your last check-in"
    lines = [f"Now, question by question, compared with {reference}."]
    shifted = {q["questionId"]: _answer_shifted(q["questionId"], q["answer"], survey_config) for q in questions}
    if all(q["status"] == "steady" and not shifted[q["questionId"]] for q in questions):
        consistent = all(q["answer"].get("recentValues") for q in questions)
        what = "your answers and signals were" if consistent else "your signals were"
        return lines + [f"On every question, {what} in line with before — a steady, consistent picture."]

    quiet: list[tuple[dict, tuple]] = []  # a run of neighbouring questions with the same ending
    signal_turn = shift_turn = 0

    def flush():
        if quiet:
            lines.append(f"On {_join([subject(q) for q, _ in quiet])}, {_QUIET_ENDINGS[quiet[0][1]]}.")
            quiet.clear()

    for q in questions:
        if q["status"] == "changed":
            flush()
            lines.append(_changed_line(subject(q), q, shifted[q["questionId"]], signal_turn))
            signal_turn += 1
        elif shifted[q["questionId"]]:
            flush()
            lines.append(_shift_line(subject(q), q, shift_turn))
            shift_turn += 1
        else:
            key = (q["status"], bool(q["answer"].get("recentValues")))
            if quiet and quiet[0][1] != key:
                flush()
            quiet.append((q, key))
    flush()
    return lines
