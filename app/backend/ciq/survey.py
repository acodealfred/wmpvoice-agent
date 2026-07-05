"""Small survey-config helpers used across tools and report code.

Scoring (effective_score, reverse handling) and the canonical summary live in the
existing ``survey_loader`` module; this only adds the question→domain lookup that
the realtime tools and report builders share.
"""


def get_question_domain(question_id: str, survey_config: dict | None = None) -> str:
    """Get the domain name for a question ID from the survey config."""
    if survey_config:
        for q in survey_config.get("questions", []):
            if q["id"] == question_id:
                return q.get("domain", q.get("text", "Unknown"))
    return "Unknown"
