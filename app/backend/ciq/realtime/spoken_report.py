"""PILOT-only spoken (verbal) report: a dynamic three-part brief the voice agent reads aloud.

Built purely from the in-memory ``SessionState.survey_results`` at the moment the agent
calls ``query_survey_results("burnout_score")`` — nothing here touches the DB, the
written report or any endpoint. Structure (from the approved sample):

  1. Where Your Capacity Is Going — a framing line, then one line per biometric signal
     that actually has data, then a closing line.
  2. The Opportunity
  3. What This Unlocks

Everything is chosen deterministically in code (framing, signal wording, which
reassurance line is allowed); the LLM only voices the result and may not add claims.
Band categorisation reuses ``survey_loader`` (``blink_band`` / ``pupil_band``) so the
spoken report can never categorise a reading differently from the written one.
No I/O; unit-testable.
"""
from survey_loader import (
    blink_band,
    compute_section_scores,
    effective_score,
    get_score_bounds,
    pupil_band,
)

PILOT_SURVEY_TYPE = "PILOT"

TITLE_CAPACITY = "Where Your Capacity Is Going"
TITLE_OPPORTUNITY = "The Opportunity"
TITLE_UNLOCKS = "What This Unlocks"

# A trend (early vs late in the check-in) is only claimed with at least this many readings.
_MIN_TREND_SAMPLES = 4
_BLINK_TREND_PCT_POINTS = 10.0   # late half this much lower than early half → "dipped further"
_PUPIL_TREND_MM = 0.1            # late half this much lower than early half → "eased"
_PACE_SHIFT = 0.25               # ±25% change in mean answer latency between halves

# Same "top quarter of the question's own range" rule as query_survey_results' stress_questions.
_HIGH_ANSWER_RATIO = 0.75

# Spoken-friendly phrasing for each PILOT item's domain, used to say where the answers
# pointed most (fits "Your answers pointed most toward ___").
_DOMAIN_PHRASES = {
    "Emotional Exhaustion": "mental exhaustion",
    "Mental Distance": "losing enthusiasm for your work",
    "Cognitive Impairment": "difficulty staying focused",
    "Emotional Impairment": "difficulty managing your emotions",
    "Work-Related Burnout (Item 7)": "work feeling emotionally draining",
    "Work-Related Burnout (Item 11)": "dreading the day ahead",
    "Work-Related Burnout (Item 13)": "having little energy left for life outside work",
}

FRAMING_DRIVING_FORWARD = "driving_forward"
FRAMING_STEADY = "steady"
FRAMING_RUNNING_LOW = "running_low"


def _mean(values: list[float]) -> float:
    return sum(values) / len(values)


def _halves(values: list[float]) -> tuple[list[float], list[float]]:
    mid = len(values) // 2
    return values[:mid], values[mid:]


def _readings(results: list[dict], field: str) -> list[float]:
    """Non-null, non-zero readings in question order. Exactly 0 means "no reading" (camera
    off / no baseline — the live defaults are 0.0), so it is dropped rather than reported
    as a genuine "stayed at baseline"."""
    return [r[field] for r in results if r.get(field) not in (None, 0, 0.0)]


def _blink_signal(results: list[dict]) -> dict | None:
    vals = _readings(results, "blink_rate_change_percent")
    if not vals:
        return None
    avg = _mean(vals)
    band = blink_band(avg)
    if band == "Normal":
        return {"key": "blink_rate", "drive": False,
                "statement": "Blink rate stayed close to your own baseline — a steady, even rhythm."}
    if avg < 0:
        degree = "well below" if band.startswith("High") else "below"
        text = (f"Blink rate ran {degree} your baseline — sustained attention, "
                "but less physical reset built in.")
        if len(vals) >= _MIN_TREND_SAMPLES:
            early, late = _halves(vals)
            if _mean(late) <= _mean(early) - _BLINK_TREND_PCT_POINTS:
                text += " And it dipped further as the check-in went on."
        return {"key": "blink_rate", "drive": True, "statement": text}
    degree = "well above" if band.startswith("High") else "above"
    return {"key": "blink_rate", "drive": False,
            "statement": (f"Blink rate ran {degree} your baseline — the kind of pattern that can go with "
                          "tiredness or a system running at a higher pitch.")}


def _pupil_signal(results: list[dict]) -> dict | None:
    vals = _readings(results, "pupil_mm_change")
    if not vals:
        return None
    avg = _mean(vals)
    band = pupil_band(avg)
    if band == "Low":
        return {"key": "pupil_dilation", "drive": False,
                "statement": "Pupil dilation stayed close to your baseline — no extra load showing there."}
    level = "clearly elevated" if band == "High" else "elevated"
    if len(vals) >= _MIN_TREND_SAMPLES:
        early, late = _halves(vals)
        if pupil_band(_mean(late)) == "Low" or _mean(late) <= _mean(early) - _PUPIL_TREND_MM:
            return {"key": "pupil_dilation", "drive": False,
                    "statement": "Pupil dilation was elevated early on and eased later — you settled in as it went."}
        return {"key": "pupil_dilation", "drive": True,
                "statement": (f"Pupil dilation stayed {level} through the later part of the check-in — "
                              "your system working harder to hold focus as it went on, not less.")}
    return {"key": "pupil_dilation", "drive": True,
            "statement": (f"Pupil dilation ran {level} across the check-in — "
                          "your system working harder to hold focus.")}


def _pace_signal(results: list[dict]) -> dict | None:
    """Response pacing from the gap between the agent finishing and the user starting to
    speak (``response_latency_ms``) — a pause measure, not a words-per-minute one."""
    lat = [r["response_latency_ms"] for r in results if r.get("response_latency_ms") is not None]
    if len(lat) < _MIN_TREND_SAMPLES:
        return None
    early, late = _halves(lat)
    early_mean = _mean(early)
    if early_mean <= 0:
        return None
    change = (_mean(late) - early_mean) / early_mean
    if change <= -_PACE_SHIFT:
        return {"key": "response_pace", "drive": True,
                "statement": ("Your pace picked up as you went — shorter pauses before answering later on, "
                              "a marker of pushing through rather than pacing.")}
    if change >= _PACE_SHIFT:
        return {"key": "response_pace", "drive": False,
                "statement": "You took a little longer before answering later on — more time to think things through."}
    return {"key": "response_pace", "drive": False,
            "statement": "Your pace stayed steady — similar pauses before answering from start to finish."}


def _focus_areas(survey_config: dict, survey_results: dict, limit: int = 2) -> list[str]:
    """Spoken phrases for the items answered in the top quarter of their own burnout range,
    highest first (ties keep question order)."""
    scored: list[tuple[float, str]] = []
    for qid, r in survey_results.items():
        lo, hi = get_score_bounds(survey_config, qid)
        if hi <= lo or r.get("score") is None:
            continue
        ratio = (effective_score(survey_config, qid, r["score"]) - lo) / (hi - lo)
        if ratio >= _HIGH_ANSWER_RATIO:
            domain = next((q.get("domain", "") for q in survey_config.get("questions", []) if q.get("id") == qid), "")
            phrase = _DOMAIN_PHRASES.get(domain, domain.lower())
            if phrase:
                scored.append((ratio, phrase))
    scored.sort(key=lambda t: -t[0])
    seen: list[str] = []
    for _, phrase in scored:
        if phrase not in seen:
            seen.append(phrase)
    return seen[:limit]


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else " and ".join(items)


def _pick_framing(risk_levels: list[str], drive_count: int) -> str:
    if "High" in risk_levels:
        return FRAMING_RUNNING_LOW
    if drive_count >= 2:
        return FRAMING_DRIVING_FORWARD
    return FRAMING_STEADY


def _lead_in(n_signals: int, framing: str) -> str | None:
    if n_signals == 0:
        return None
    what = {FRAMING_DRIVING_FORWARD: "That drive shows up", FRAMING_STEADY: "That steadiness shows up"}.get(
        framing, "That shows up")
    where = {1: "in one signal:", 2: "across two signals:"}.get(n_signals, "across a few signals:")
    return f"{what} {where}"


def build_pilot_spoken_report(survey_config: dict, survey_results: dict) -> dict | None:
    """Build the spoken brief for a completed PILOT survey, or None for any other survey
    type / no answers.

    Returns ``{"framing", "parts", "plain_text"}``: ``parts`` is what the agent is given
    (a list of ``{"title", "say"}``), ``plain_text`` is the same content flattened for the
    agent's post-report follow-up context.
    """
    if survey_config.get("type") != PILOT_SURVEY_TYPE or not survey_results:
        return None

    snapshots = [{"questionId": qid, "score": r.get("score")} for qid, r in survey_results.items()]
    risk_levels = [s["riskLevel"] for s in compute_section_scores(survey_config, snapshots)]

    ordered = list(survey_results.values())
    signals = [s for s in (_blink_signal(ordered), _pupil_signal(ordered), _pace_signal(ordered)) if s]
    drive_count = sum(1 for s in signals if s["drive"])
    framing = _pick_framing(risk_levels, drive_count)
    all_low = bool(risk_levels) and all(level == "Low" for level in risk_levels)

    # ── 1. Where Your Capacity Is Going ─────────────────────────────────────
    intro = {
        FRAMING_DRIVING_FORWARD: "Your recent data points to someone in motion — steady focus, "
                                 "consistent output, a clear pull toward finishing what you start.",
        FRAMING_STEADY: "Your recent data points to someone holding steady — an even keel, "
                        "with your energy in reasonable balance.",
        FRAMING_RUNNING_LOW: "Your recent data points to someone carrying a lot right now — "
                             "more is going out than is coming back in.",
    }[framing]
    capacity_lines = [intro]
    lead_in = _lead_in(len(signals), framing)
    if lead_in:
        capacity_lines.append(lead_in)
        capacity_lines.extend(s["statement"] for s in signals)

    # The reassurance line is gated by the survey result: "not a warning sign" is only
    # ever said when every subscale is Low; a Moderate result gets "not a diagnosis"; a
    # High result gets neither, just a non-judgmental map.
    if framing == FRAMING_RUNNING_LOW:
        capacity_lines.append("This isn't a judgment. It's a picture of where your energy is going "
                              "right now — and it shows how much you're carrying.")
    else:
        reassurance = "None of this is a warning sign." if all_low else "None of this is a diagnosis."
        where_to = {
            FRAMING_DRIVING_FORWARD: "It's a map of where your energy is currently going — "
                                     "mostly toward output, less toward reset.",
            FRAMING_STEADY: "It's a map of where your energy is currently going — "
                            "and right now it looks steady.",
        }[framing]
        capacity_lines.append(f"{reassurance} {where_to}")

    # ── 2. The Opportunity ──────────────────────────────────────────────────
    opportunity = {
        FRAMING_DRIVING_FORWARD: (
            "Right now, more of your capacity is spent driving forward than rebuilding the reserve "
            "that drive runs on. That's not a flaw — it's a gap between two things you're already "
            "doing well: pushing, and finishing. Closing it doesn't mean slowing down. It means the "
            "same drive, with more behind it."),
        FRAMING_STEADY: (
            "Right now, your capacity and your recovery are in fairly good balance. The opportunity "
            "is to protect that — the habits that are working are the reserve your focus draws on, "
            "so keeping them steady is what lets you keep going well."),
        FRAMING_RUNNING_LOW: (
            "Right now, more of your capacity is going out than is coming back in, and that gap is "
            "worth taking seriously. That's not a flaw — it's information. The opportunity is to make "
            "rebuilding your reserve a real priority rather than an afterthought, and to lean on the "
            "support around you while you do."),
    }[framing]
    areas = _focus_areas(survey_config, survey_results)
    if areas:
        opportunity = f"Your answers pointed most toward {_join(areas)}. {opportunity}"

    # ── 3. What This Unlocks ────────────────────────────────────────────────
    unlocks = {
        FRAMING_DRIVING_FORWARD: (
            "People who close this exact gap — high output, low recovery — don't just feel better. "
            "They typically report catching more, deciding faster, and having more in reserve when it "
            "counts. Recovery here isn't rest for its own sake — it's the input your focus is already "
            "drawing on."),
        FRAMING_STEADY: (
            "Keeping this balance is what keeps your focus sustainable: clear thinking, steady energy, "
            "and room to respond when something unexpected lands. Protecting your recovery isn't a "
            "break from your work — it's part of what makes it last."),
        FRAMING_RUNNING_LOW: (
            "Rebuilding reserve isn't about doing less of what matters — it's what gives what matters "
            "something to run on. Even small, regular recovery — a real break, a boundary, a "
            "conversation with someone you trust — adds back the capacity your focus and decisions "
            "draw from."),
    }[framing]

    parts = [
        {"title": TITLE_CAPACITY, "say": capacity_lines},
        {"title": TITLE_OPPORTUNITY, "say": [opportunity]},
        {"title": TITLE_UNLOCKS, "say": [unlocks]},
    ]
    plain_text = "\n\n".join(f"{p['title']}: " + " ".join(p["say"]) for p in parts)
    return {"framing": framing, "parts": parts, "plain_text": plain_text}
