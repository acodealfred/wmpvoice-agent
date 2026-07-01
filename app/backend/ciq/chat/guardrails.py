"""Hybrid guardrails for the manager chat.

Deterministic rules here; the LLM-side guardrails live in the system prompt
(see orchestrator.SYSTEM_PROMPT). Structural PII exclusion is enforced by the
tools (they only ever return aggregates), so this module focuses on the input
red-flag filter and a light output check.

See docs/manager-chat.md § "Guardrails".
"""
import re

# Requests that try to pierce the aggregate boundary — an individual's report,
# score, transcript, biometrics or identity. Matched case-insensitively.
_BLOCK_PATTERNS = [
    r"\b(who|which)\s+(staff|employee|person|people|nurse|doctor|worker)s?\b.*\b(name|identify|is|are)\b",
    r"\b(name|identify|list)\b.*\b(the\s+)?(staff|employees|people|individuals|person)\b",
    r"\b(show|give|tell)\s+me\b.*\b(individual|specific|each)\b.*\b(report|score|result)",
    r"\b(transcript|recording|verbatim|what did .* say)\b",
    r"\bbiometric|blink rate|pupil|facial|emotion recognition\b.*\b(for|of)\s+\w+",
    r"\b(report|score|result)s?\s+(for|of)\s+(a\s+)?(specific|particular|named|individual)\b",
]
_BLOCK_RE = [re.compile(p, re.IGNORECASE) for p in _BLOCK_PATTERNS]

REFUSAL = (
    "I can only work with **aggregate, de-identified** signals — grouped counts and "
    "trends, never any individual's report, score, transcript or biometrics. "
    "Try asking about a department, shift, job title or the org-wide trend instead."
)


def check_input(message: str) -> str | None:
    """Return a refusal string if the message asks for individual-level data, else None."""
    text = message or ""
    for rx in _BLOCK_RE:
        if rx.search(text):
            return REFUSAL
    return None


EMPTY_FALLBACK = (
    "I couldn't produce a grounded answer for that. Could you rephrase, or ask about a "
    "specific department, shift, trend, or evidence-based intervention?"
)


def build_footer(citations: list) -> str:
    """Deterministic disclaimer footer appended after the streamed answer.

    The heavy lifting (no diagnosis, cite research, don't fabricate numbers) is done
    by the system prompt + structural grounding; this just frames every answer as
    aggregate, non-clinical guidance and flags when it's evidence-backed.
    """
    base = "_Aggregate, de-identified signals only — a wellbeing aid, not a clinical or diagnostic tool._"
    if citations:
        base = "_Evidence-backed by the knowledge base (see sources). " + base.lstrip("_")
    return "\n\n" + base
