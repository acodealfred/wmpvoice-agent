import json
import logging
from pathlib import Path

logger = logging.getLogger("voicerag")

SURVEY_MAP: dict[str, str] = {
    "TEST":      "surveys/test-survey.json",
    "BATFULL":   "surveys/bat-full-survey.json",
    "PILOT":     "surveys/pilot-survey.json",
    "CBTFULL":   "surveys/cbt-full-survey.json",
    "READINESS": "surveys/readiness-survey.json",
}

_BASE_DIR = Path(__file__).parent


def load_survey(survey_type: str) -> dict:
    """Load a survey config from its JSON file.

    Falls back to TEST with a warning if the requested type is unknown or
    its file is missing / malformed.
    """
    survey_type = survey_type.upper()
    if survey_type not in SURVEY_MAP:
        logger.warning("[SurveyLoader] Unknown survey type '%s', falling back to TEST", survey_type)
        survey_type = "TEST"

    file_path = _BASE_DIR / SURVEY_MAP[survey_type]
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        logger.info("[SurveyLoader] Loaded survey '%s' from %s (%d questions)",
                    survey_type, file_path, len(config.get("questions", [])))
        return config
    except FileNotFoundError:
        logger.error("[SurveyLoader] Survey file not found: %s — falling back to TEST", file_path)
    except json.JSONDecodeError as e:
        logger.error("[SurveyLoader] Malformed JSON in %s: %s — falling back to TEST", file_path, e)

    # Last-resort fallback: load TEST
    fallback_path = _BASE_DIR / SURVEY_MAP["TEST"]
    with open(fallback_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── Scoring helpers ──────────────────────────────────────────────────────────
# Positively-worded items (e.g. Personal Accomplishment, Job Satisfaction) are
# marked "reverse": true in the survey config. For those, a high answer means LESS
# burnout, so the burnout-direction ("effective") score is flipped: (min+max) - raw.
# Without this, a burnt-out person who answers low on positive items can never reach
# the High band — the total is structurally capped in the Moderate range.

def options_for_question(config: dict, question_id: str | None) -> list[dict]:
    """Return the option (value/label) list governing one question's answer scale.

    Prefers the `scoringSections` entry that owns `question_id` — so a survey like
    PILOT can give BAT-4 and CBI-WRB3 each their own scale — and falls back to the
    survey-level `options` for surveys without sections (TEST/BATFULL/CBTFULL) or
    when `question_id` isn't given/found.
    """
    if question_id is not None:
        for section in config.get("scoringSections", []):
            if question_id in section.get("questionIds", []) and section.get("options"):
                return section["options"]
    return config.get("options", [])


def get_score_bounds(config: dict, question_id: str | None = None) -> tuple[int, int]:
    """Return (min, max) option values for a question (or the whole survey); defaults to (1, 5)."""
    options = options_for_question(config, question_id)
    vals = [o.get("value") for o in options if isinstance(o.get("value"), (int, float))]
    return (int(min(vals)), int(max(vals))) if vals else (1, 5)


def is_reverse_item(config: dict, question_id: str) -> bool:
    for q in config.get("questions", []):
        if q.get("id") == question_id:
            return bool(q.get("reverse", False))
    return False


def effective_score(config: dict, question_id: str, raw_score) -> int:
    """Burnout-direction score for a question. Reverse items are flipped so that a
    high answer on a positive item counts toward LOW burnout."""
    if raw_score is None:
        return 0
    if is_reverse_item(config, question_id):
        lo, hi = get_score_bounds(config, question_id)
        return (lo + hi) - int(raw_score)
    return int(raw_score)


# ── Single source of truth for report figures + biometric categories ─────────
# Every consumer (the /analyze-report endpoint, the /ssot-report endpoint and the
# realtime agent's query_survey_results tool) MUST derive scores and biometric
# bands from these helpers so they can never diverge.

def _domain_totals(config: dict, snapshots: list) -> dict:
    """Reverse-aware effective-score sum per question `domain`.

    Independent of whether the survey scores as one combined total or as
    several `scoringSections` — domain is a separate axis (e.g. "Emotional
    Exhaustion") that stays useful supplementary detail either way.
    """
    domain_totals: dict = {}
    for s in snapshots:
        dom = s.get("domain", "Unknown")
        domain_totals[dom] = domain_totals.get(dom, 0) + effective_score(
            config, s.get("questionId", ""), s.get("score", 0)
        )
    return domain_totals


def _band(score: float, thresholds: dict, interp_map: dict) -> tuple[str, str]:
    """Shared Low/Moderate/High banding against a section's or survey's own thresholds."""
    if score <= thresholds.get("low_max", 12):
        return "Low", interp_map.get("low", "This score suggests low work-related burnout risk right now.")
    if score <= thresholds.get("moderate_max", 22):
        return "Moderate", interp_map.get(
            "moderate", "This score suggests a moderate level of work-related burnout risk."
        )
    return "High", interp_map.get(
        "high",
        "This score suggests elevated work-related burnout risk. It is not a diagnosis, but it may "
        "indicate that current work demands are placing significant strain on your recovery, energy, "
        "and wellbeing.",
    )


def compute_section_scores(config: dict, snapshots: list) -> list[dict]:
    """Score each of a survey's `scoringSections` independently.

    Each section (e.g. BAT-4, CBI-WRB3) averages the reverse-aware effective
    score of only its own `questionIds`, then linearly rescales that average
    from the section's OWN native option range (`get_score_bounds`, resolved
    per-section so e.g. BAT-4's 1-5 and CBI-WRB3's 0/25/50/75/100 don't bleed
    into each other) into the section's own declared `scoreRange` (identity
    for both today, since each section's native range now equals its own
    scoreRange), and bands the rescaled value against the section's own
    thresholds/interpretation. A section with none of its questions answered
    yet is omitted (no partial/zero-division score).
    """
    by_id = {s.get("questionId", ""): s for s in snapshots}

    sections = []
    for section in config.get("scoringSections", []):
        matched = [by_id[qid] for qid in section.get("questionIds", []) if qid in by_id]
        if not matched:
            continue

        question_ids = section.get("questionIds", [])
        native_lo, native_hi = get_score_bounds(config, question_ids[0] if question_ids else None)

        raw_avg = sum(
            effective_score(config, s.get("questionId", ""), s.get("score", 0)) for s in matched
        ) / len(matched)

        lo, hi = section.get("scoreRange", [native_lo, native_hi])
        if native_hi != native_lo:
            rescaled = lo + (raw_avg - native_lo) * (hi - lo) / (native_hi - native_lo)
        else:
            rescaled = lo

        risk_level, interpretation = _band(
            rescaled,
            section.get("thresholds", {"low_max": 12, "moderate_max": 22}),
            section.get("interpretation", {}),
        )

        sections.append({
            "id": section.get("id", ""),
            "label": section.get("label", section.get("id", "")),
            "score": round(rescaled, 1),
            "scoreRange": [lo, hi],
            "riskLevel": risk_level,
            "interpretation": interpretation,
        })

    return sections


def compute_survey_summary(config: dict, snapshots: list) -> dict:
    """Canonical, reverse-aware report figures for a set of survey snapshots.

    For a survey declaring `scoringSections` (e.g. PILOT's BAT-4/CBI-WRB3),
    returns `sections` (see `compute_section_scores`) + `domainTotals` — there
    is no single combined totalScore/riskLevel for these, by design, since the
    two subscales are independent constructs. Every other survey keeps the
    original flat totalScore/maxScore/riskLevel/interpretation/domainTotals
    shape, using the survey config's thresholds and interpretation text
    (never hardcoded). `snapshots` are the camelCase per-question dicts
    (questionId, score, domain).
    """
    if config.get("scoringSections"):
        return {
            "sections": compute_section_scores(config, snapshots),
            "domainTotals": _domain_totals(config, snapshots),
        }

    lo, hi = get_score_bounds(config)
    total_score = sum(
        effective_score(config, s.get("questionId", ""), s.get("score", 0)) for s in snapshots
    )
    max_score = len(snapshots) * hi

    risk_level, interpretation = _band(
        total_score,
        config.get("thresholds", {"low_max": 12, "moderate_max": 22}),
        config.get("interpretation", {}),
    )

    return {
        "totalScore": total_score,
        "maxScore": max_score,
        "riskLevel": risk_level,
        "interpretation": interpretation,
        "domainTotals": _domain_totals(config, snapshots),
    }


def serialize_survey_results(snapshots: list) -> dict:
    """Canonical per-question record stored in the DB / returned to the UI.

    Always keyed by questionId with a single, stable field set, so every write
    path produces an identical shape regardless of which endpoint persists it.
    """
    return {
        s.get("questionId", ""): {
            "score": s.get("score"),
            "domain": s.get("domain"),
            "userResponse": s.get("userResponse", ""),
            "voiceSentiment": s.get("voiceSentiment", "neutral"),
            "blinkRateChange": s.get("blinkRateChange", 0),
            "leftGazePosition": s.get("leftGazePosition", "Center"),
            "rightGazePosition": s.get("rightGazePosition", "Center"),
            "responseLatencyMs": s.get("responseLatencyMs"),
        }
        for s in snapshots
    }


def blink_band(change_pct) -> str:
    """Map a baseline-relative blink-rate change (%) to a Normal/Elevated/High category.

    Normal: |Δ| ≤ 15%, Elevated: 15% < |Δ| ≤ 40%, High: |Δ| > 40%. Direction is
    retained because it changes meaning (below baseline = focus, above = fatigue/arousal).
    """
    if change_pct is None:
        return "Unknown"
    mag = abs(change_pct)
    if mag <= 15:
        return "Normal"
    level = "Elevated" if mag <= 40 else "High"
    direction = "above baseline" if change_pct > 0 else "below baseline"
    return f"{level} ({direction})"


def pupil_band(mm_change) -> str:
    """Map pupil-dilation change (mm vs baseline) to a Low/Medium/High category.

    Low: Δ ≤ +0.1 mm (includes constriction), Medium: +0.1 < Δ ≤ +0.3 mm, High: Δ > +0.3 mm.
    """
    if mm_change is None:
        return "Unknown"
    if mm_change <= 0.1:
        return "Low"
    if mm_change <= 0.3:
        return "Medium"
    return "High"
