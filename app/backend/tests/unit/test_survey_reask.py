"""Survey answers are recorded only on an exact scale label — never a guessed/closest one."""
from ciq.prompts.builder import survey_instructions
from survey_loader import load_survey, options_for_question

PILOT = load_survey("PILOT")


def _labels(qid):
    return [o["label"] for o in options_for_question(PILOT, qid) if o.get("label")]


def test_each_step_lists_its_own_valid_labels():
    script = survey_instructions(PILOT)
    # BAT and CBI items have different scales — each step must carry its own.
    for qid in ("bat_q1", "cbi_q1"):
        assert f'Valid answers: {", ".join(_labels(qid))}.' in script


def test_off_scale_answers_are_reasked_with_all_labels_never_guessed():
    script = survey_instructions(PILOT)
    assert "Record an answer ONLY when the user says one of the current step's" in script
    assert "Keep re-asking this way until the user says one of the labels" in script
    bat = _labels("bat_q1")
    assert f'would you say {", ".join(bat[:-1])}, or {bat[-1]}?' in script
    # The old behaviour (pick the closest option / cap follow-ups) must be gone.
    assert "record the option closest" not in script
    assert "AT MOST ONE short clarifying follow-up" not in script
