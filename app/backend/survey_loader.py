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
