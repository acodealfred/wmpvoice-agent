import json
import logging
from pathlib import Path

logger = logging.getLogger("voicerag")

SURVEY_MAP: dict[str, str] = {
    "TEST":    "surveys/test-survey.json",
    "BATFULL": "surveys/bat-full-survey.json",
    "CBTFULL": "surveys/cbt-full-survey.json",
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

def get_score_bounds(config: dict) -> tuple[int, int]:
    """Return (min, max) option values for a survey; defaults to (1, 5)."""
    vals = [o.get("value") for o in config.get("options", []) if isinstance(o.get("value"), (int, float))]
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
        lo, hi = get_score_bounds(config)
        return (lo + hi) - int(raw_score)
    return int(raw_score)


# ── Single source of truth for report figures + biometric categories ─────────
# Every consumer (the /analyze-report endpoint, the /ssot-report endpoint and the
# realtime agent's query_survey_results tool) MUST derive scores and biometric
# bands from these helpers so they can never diverge.

def compute_survey_summary(config: dict, snapshots: list) -> dict:
    """Canonical, reverse-aware report figures for a set of survey snapshots.

    Returns totalScore / maxScore / riskLevel / interpretation / domainTotals,
    using the survey config's thresholds and interpretation text (never hardcoded).
    `snapshots` are the camelCase per-question dicts (questionId, score, domain).
    """
    lo, hi = get_score_bounds(config)
    total_score = sum(
        effective_score(config, s.get("questionId", ""), s.get("score", 0)) for s in snapshots
    )
    max_score = len(snapshots) * hi

    domain_totals: dict = {}
    for s in snapshots:
        dom = s.get("domain", "Unknown")
        domain_totals[dom] = domain_totals.get(dom, 0) + effective_score(
            config, s.get("questionId", ""), s.get("score", 0)
        )

    thresholds = config.get("thresholds", {"low_max": 12, "moderate_max": 22})
    interp_map = config.get("interpretation", {})
    if total_score <= thresholds.get("low_max", 12):
        risk_level, interpretation = "Low", interp_map.get("low", "Low burnout risk")
    elif total_score <= thresholds.get("moderate_max", 22):
        risk_level, interpretation = "Moderate", interp_map.get("moderate", "Moderate burnout risk")
    else:
        risk_level, interpretation = "High", interp_map.get("high", "High burnout risk")

    return {
        "totalScore": total_score,
        "maxScore": max_score,
        "riskLevel": risk_level,
        "interpretation": interpretation,
        "domainTotals": domain_totals,
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
            "voiceSentiment": s.get("voiceSentiment", "neutral"),
            "blinkRateChange": s.get("blinkRateChange", 0),
            "gazePosition": s.get("gazePosition", "Center"),
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
