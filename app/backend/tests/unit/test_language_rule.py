"""English only, always — the LANGUAGE_RULE must reach EVERY spoken turn.

Cue turns send their own response.create instructions, which replace the session
instructions for that turn, so each cue builder has to carry the rule itself.
"""
import pytest

from ciq.prompts.builder import (
    BASELINE_CUE_NAMES,
    LANGUAGE_RULE,
    REPORT_CUE_NAMES,
    baseline_cue_instructions,
    build_session_instructions,
    report_cue_instructions,
)
from ciq.realtime.session import SessionState
from survey_loader import SURVEY_MAP, load_survey


def test_rule_is_english_only_with_no_switch_loophole():
    assert "ONLY in English" in LANGUAGE_RULE
    assert "not even if they ask you to" in LANGUAGE_RULE
    assert "UNLESS" not in LANGUAGE_RULE


@pytest.mark.parametrize("cue", sorted(BASELINE_CUE_NAMES))
def test_every_baseline_cue_carries_the_rule(cue):
    assert baseline_cue_instructions(cue).startswith(LANGUAGE_RULE)


@pytest.mark.parametrize("cue", sorted(REPORT_CUE_NAMES))
def test_every_report_cue_carries_the_rule(cue):
    report = {"sections": [{"label": "BAT-4", "interpretation": "Low."}]}
    assert report_cue_instructions(cue, report).startswith(LANGUAGE_RULE)


@pytest.mark.parametrize("survey_type", sorted(SURVEY_MAP))
@pytest.mark.parametrize("conversation_state", ["active", "report_delivered"])
def test_session_instructions_carry_the_rule(survey_type, conversation_state):
    config = load_survey(survey_type)
    sess = SessionState(session_id="s", survey_config=config)
    sess.conversation_state = conversation_state
    text = build_session_instructions(
        base_message="You are a helpful assistant.",
        sess=sess,
        survey_config=config,
        enable_meta_intent=False,
        meta_intent_config=None,
        enable_sentiment=False,
        enable_survey=True,
        biometric_guardrail_enabled=True,
    )
    assert LANGUAGE_RULE in text
