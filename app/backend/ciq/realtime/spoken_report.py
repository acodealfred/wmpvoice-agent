"""PILOT-only spoken (verbal) report: a dynamic three-part brief the voice agent reads aloud.

Built purely from the in-memory ``SessionState.survey_results`` at the moment the agent
calls ``query_survey_results("burnout_score")`` — nothing here touches the DB, the
written report or any endpoint. Structure (from the approved sample):

  1. Where Your Capacity Is Going — a framing line, then one line per signal that
     actually has data (blink, answer pace, voice tone), then a closing line.
  2. The Opportunity
  3. What This Unlocks

plus ``domain_lines`` — the domain area(s) the answers sit highest in, always named.
The voice report (ciq.prompts.builder) speaks Capacity in its "this assessment" section
and domain_lines → Opportunity → Unlocks as its closing section.

Everything is chosen deterministically in code (framing, signal wording, which
reassurance line is allowed); the LLM only voices the result and may not add claims.
Band categorisation reuses ``survey_loader`` (``blink_band``) so the spoken report
can never categorise a reading differently from the written one. Pupil dilation is
still captured and stored but deliberately not reported.
No I/O; unit-testable.
"""
from survey_loader import (
    blink_band,
    compute_section_scores,
    effective_score,
    get_score_bounds,
)

PILOT_SURVEY_TYPE = "PILOT"

TITLE_CAPACITY = "Where Your Capacity Is Going"
TITLE_OPPORTUNITY = "The Opportunity"
TITLE_UNLOCKS = "What This Unlocks"

# A trend (early vs late in the check-in) is only claimed with at least this many readings.
_MIN_TREND_SAMPLES = 4
_BLINK_TREND_PCT_POINTS = 10.0   # late half this much lower than early half → "dipped further"
_PACE_SHIFT = 0.25               # ±25% change in mean answer latency between halves

# Same "top quarter of the question's own range" rule as query_survey_results' stress_questions.
_HIGH_ANSWER_RATIO = 0.75
_MODERATE_ANSWER_RATIO = 0.5     # the middle of the range ("Sometimes") and above
_MAX_TOP_AREAS = 3               # areas named when several are high — never a long list
_MAX_TIED_AREAS = 2              # otherwise the top area, plus one that is level with it
_AREA_TIE = 0.05                 # area scores this close count as level

# Voice tone: a whole-run tone is only claimed with at least this many tagged answers, and
# "mostly X" only when X is at least this share of them.
_MIN_TONE_SAMPLES = 3
_TONE_MAJORITY = 0.6
_TONE_WORDS = {"positive": "positive", "neutral": "even and neutral", "negative": "on the heavier side"}

# Each PILOT item's domain as a spoken area (fits "point most toward ___"). The four BAT
# items are its four core dimensions; the three CBI items all belong to one scale, so
# they share one area. Plain language, no clinical label (the area is not a diagnosis).
_DOMAIN_AREAS = {
    "Emotional Exhaustion": "exhaustion",
    "Mental Distance": "mental distance from your work",
    "Cognitive Impairment": "difficulty keeping your focus",
    "Emotional Impairment": "difficulty managing your emotions at work",
}
_CBI_AREA = "work-related fatigue"

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
                "statement": "Your pace picked up as you went — shorter pauses later on, more pushing through than pacing."}
    if change >= _PACE_SHIFT:
        return {"key": "response_pace", "drive": False,
                "statement": "You took a little longer before answering later on — more time to think things through."}
    return {"key": "response_pace", "drive": False,
            "statement": "Your pace stayed steady — similar pauses before answering from start to finish."}


def _tone_signal(results: list[dict]) -> dict | None:
    """The tone the voice-sentiment tool tagged on each answer, over the whole check-in."""
    tones = [str(r.get("voice_sentiment") or "").strip().lower() for r in results]
    tones = [t for t in tones if t in _TONE_WORDS]
    if len(tones) < _MIN_TONE_SAMPLES:
        return None
    ranked = sorted(_TONE_WORDS, key=lambda t: -tones.count(t))  # ties keep positive → negative
    top = ranked[0]
    if tones.count(top) / len(tones) >= _TONE_MAJORITY:
        text = f"The tone of your answers stayed mostly {_TONE_WORDS[top]} throughout."
    else:
        text = (f"The tone of your answers moved around as you went — some moments "
                f"{_TONE_WORDS[top]}, others {_TONE_WORDS[ranked[1]]}.")
    return {"key": "voice_tone", "drive": False, "statement": text}


def _area(domain: str) -> str:
    return _CBI_AREA if domain.startswith("Work-Related Burnout") else _DOMAIN_AREAS.get(domain, domain.lower())


def _domain_lines(survey_config: dict, survey_results: dict) -> list[str]:
    """Section 4: ALWAYS names the domain area(s) the answers sit highest in, worded by how
    high that is. Each area's score is the mean of its questions' place in their own
    burnout range (0 = lowest, 1 = highest; reverse items flipped), so the four one-item
    BAT areas and the three-item CBI area compare fairly. [] when nothing was scored."""
    questions = {q.get("id"): q for q in survey_config.get("questions", [])}
    by_area: dict[str, list[tuple[float, dict]]] = {}
    for qid, r in survey_results.items():
        lo, hi = get_score_bounds(survey_config, qid)
        if hi <= lo or r.get("score") is None or qid not in questions:
            continue
        ratio = (effective_score(survey_config, qid, r["score"]) - lo) / (hi - lo)
        area = _area(questions[qid].get("domain", ""))
        if area:
            by_area.setdefault(area, []).append((ratio, questions[qid]))
    if not by_area:
        return []
    scores = {area: sum(r for r, _ in items) / len(items) for area, items in by_area.items()}
    ranked = sorted(scores, key=lambda a: -scores[a])  # ties keep question order
    top = scores[ranked[0]]
    if top >= _HIGH_ANSWER_RATIO:
        level = "high"
        named = [a for a in ranked if scores[a] >= _HIGH_ANSWER_RATIO][:_MAX_TOP_AREAS]
    else:
        level = "moderate" if top >= _MODERATE_ANSWER_RATIO else "low"
        named = [a for a in ranked if top - scores[a] <= _AREA_TIE][:_MAX_TIED_AREAS]
    # The single highest question inside the named areas, to make it concrete.
    best = max((item for a in named for item in by_area[a]), key=lambda t: t[0])[1]
    subject = best.get("spoken") or best.get("text") or best["id"]
    if level == "high":
        first = f"Your answers were highest on {_join(named)} — especially {subject}."
    elif level == "moderate":
        first = (f"Nothing reached the high range, but your answers leaned most toward {_join(named)} — "
                 f"especially {subject}.")
    else:
        were = "was" if len(named) == 1 else "were"
        first = (f"Your answers were low across the board; the area{'s' if len(named) > 1 else ''} "
                 f"that came out slightly highest {were} {_join(named)}.")
    return [first, "That isn't a label — just a good place to start looking after yourself."]


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


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

    Returns ``{"framing", "parts", "domain_lines", "plain_text"}``: ``parts`` is what the
    agent is given (a list of ``{"title", "say"}``), ``domain_lines`` the fixed sentences on
    where the answers point, ``plain_text`` is the same content flattened for the
    agent's post-report follow-up context.
    """
    if survey_config.get("type") != PILOT_SURVEY_TYPE or not survey_results:
        return None

    snapshots = [{"questionId": qid, "score": r.get("score")} for qid, r in survey_results.items()]
    risk_levels = [s["riskLevel"] for s in compute_section_scores(survey_config, snapshots)]

    ordered = list(survey_results.values())
    signals = [s for s in (_blink_signal(ordered), _pace_signal(ordered), _tone_signal(ordered)) if s]
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
        capacity_lines.append("This isn't a judgment — just a picture of how much you're carrying right now.")
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
            "Right now, more of your capacity goes into driving forward than into rebuilding the "
            "reserve that drive runs on. Closing that gap doesn't mean slowing down — it means the "
            "same drive, with more behind it."),
        FRAMING_STEADY: (
            "Right now, your capacity and your recovery are in fairly good balance. The opportunity "
            "is to protect the habits that keep it that way."),
        FRAMING_RUNNING_LOW: (
            "That gap is worth taking seriously. The opportunity is to make rebuilding your reserve a "
            "real priority, and to lean on the support around you while you do."),
    }[framing]

    # ── 3. What This Unlocks ────────────────────────────────────────────────
    unlocks = {
        FRAMING_DRIVING_FORWARD: (
            "People who close this gap typically report deciding faster and having more in reserve "
            "when it counts. Recovery here is the input your focus already draws on."),
        FRAMING_STEADY: (
            "Keeping this balance keeps your focus sustainable, with room to respond when something "
            "unexpected lands."),
        FRAMING_RUNNING_LOW: (
            "Even small, regular recovery — a real break, a boundary, a conversation with someone you "
            "trust — adds back the capacity your focus and decisions draw from."),
    }[framing]

    parts = [
        {"title": TITLE_CAPACITY, "say": capacity_lines},
        {"title": TITLE_OPPORTUNITY, "say": [opportunity]},
        {"title": TITLE_UNLOCKS, "say": [unlocks]},
    ]
    domain_lines = _domain_lines(survey_config, survey_results)
    plain_text = "\n\n".join(
        [f"{parts[0]['title']}: " + " ".join(parts[0]["say"]),
         "Where your answers point: " + " ".join(domain_lines)]
        + [f"{p['title']}: " + " ".join(p["say"]) for p in parts[1:]]
    )
    return {"framing": framing, "parts": parts, "domain_lines": domain_lines, "plain_text": plain_text}
