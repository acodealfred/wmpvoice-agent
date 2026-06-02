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
