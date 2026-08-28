"""Deterministic safety-risk interlock for the Recovery Window intake.

Closest sibling pattern in this codebase: ciq/chat/guardrails.py — a
deterministic, rule-based check that runs before anything else and needs no
LLM. Two distinct outcomes for the safety question (spec §7/§12):

  "yes"               -> full halt ("urgent_support"): no track, stop the flow entirely.
  "prefer_not_to_say"  -> "grounding_only": a lighter path — simple grounding content
                          only, no CBT/ACT/deep-processing track — still surfaces
                          support resources and is still flagged for admin/HR review,
                          but is NOT the same alarming full-halt message as "yes".
  "no"                 -> no interlock, proceeds normally.

Both message constants below are PLACEHOLDERS and must be replaced with the
organization's real EAP/crisis-line details before this ships.

Guardrail table (spec §5) — copy-audit checklist for every message/rationale
string written in this package. Never write anything resembling the left
column; always prefer language like the right column:
  "You have burnout."                      -> "Your score suggests elevated work-related burnout risk."
  "This will treat burnout."                -> "This is a guided recovery support session, not a medical treatment."
  "You are unsafe to work."                  -> "Consider pausing or escalating according to your organisation's safety process."
  "The biometrics show you are stressed."    -> "Your current pattern shows elevated strain compared with your baseline."
  "You need therapy."                        -> "You may consider speaking with a qualified professional if this pattern continues or feels difficult to manage alone."
"""
from dataclasses import dataclass
from typing import Literal

_URGENT_ANSWERS = {"yes"}
_GROUNDING_ANSWERS = {"prefer_not_to_say"}

STATIC_CRISIS_MESSAGE = (
    "It sounds like things may be harder than usual right now, and that matters. You are "
    "more than this score, and this tool isn't equipped to support you with that directly — "
    "but you deserve real support. Please consider reaching out to a crisis line, your EAP, "
    "or someone you trust as soon as you can. If you're in immediate danger, contact local "
    "emergency services."
)

STATIC_GROUNDING_MESSAGE = (
    "Thank you for letting me know, and it's completely okay not to say more. Let's keep "
    "things simple and grounding for now rather than going deeper. If you'd find it helpful, "
    "support resources — including your EAP and a crisis line — are always available to you, "
    "any time, not just right now."
)


@dataclass(frozen=True)
class SafetyInterlockResult:
    mode: Literal["urgent_support", "grounding_only"]
    message: str


def check_safety_interlock(intake: dict) -> SafetyInterlockResult | None:
    """Return an interlock result if the intake's safety answer trips it, else None."""
    answer = intake.get("safety_risk") or intake.get("safety")
    if answer in _URGENT_ANSWERS:
        return SafetyInterlockResult(mode="urgent_support", message=STATIC_CRISIS_MESSAGE)
    if answer in _GROUNDING_ANSWERS:
        return SafetyInterlockResult(mode="grounding_only", message=STATIC_GROUNDING_MESSAGE)
    return None
