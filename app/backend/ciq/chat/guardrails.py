"""Hybrid, scope-aware deterministic guardrails for the chat surfaces.

LLM-side guardrails live in the system prompts (ciq/chat/prompts.py); structural
data isolation is enforced by the tools + RBAC (ciq/chat/rbac.py). This module
adds the input red-flag filter (different per surface) and the output footer.

See docs/manager-chat.md § "Guardrails".
"""
import re

# ── Manager surface: block requests that pierce the aggregate boundary ──
_MANAGER_BLOCK = [
    r"\b(who|which)\s+(staff|employee|person|people|nurse|doctor|worker)s?\b.*\b(name|identify|is|are)\b",
    r"\b(name|identify|list)\b.*\b(the\s+)?(staff|employees|people|individuals|person)\b",
    r"\b(show|give|tell)\s+me\b.*\b(individual|specific|each)\b.*\b(report|score|result)",
    r"\b(transcript|recording|verbatim|what did .* say)\b",
    r"\bbiometric|blink rate|pupil|facial|emotion recognition\b.*\b(for|of)\s+\w+",
    r"\b(report|score|result)s?\s+(for|of)\s+(a\s+)?(specific|particular|named|individual)\b",
]

# ── Personal surface: block requests for OTHER people or org-wide data ──
_PERSONAL_BLOCK = [
    r"\b(other|others|another|someone else|somebody else|colleague|coworker|co-worker|teammate)s?\b",
    r"\b(team|department|org|organi[sz]ation|company|everyone|everybody|staff|employees|workforce)\b",
    r"\b(compare|versus|vs\.?|against)\b.*\b(others|team|department|colleagues|coworkers|company)\b",
    r"\b(average|aggregate|company-wide|org-wide|overall)\b.*\b(score|burnout|risk)\b",
]

_MANAGER_RE = [re.compile(p, re.IGNORECASE) for p in _MANAGER_BLOCK]
_PERSONAL_RE = [re.compile(p, re.IGNORECASE) for p in _PERSONAL_BLOCK]

_MANAGER_REFUSAL = (
    "I can only work with **aggregate, de-identified** signals — grouped counts and trends, "
    "never any individual's report, score, transcript or biometrics. Try asking about a "
    "department, shift, job title or the org-wide trend instead."
)
_PERSONAL_REFUSAL = (
    "I can only speak to **your own** assessments and wellbeing — I have no access to other "
    "people, teams or organisation-wide figures. For team or org views, that's the manager "
    "dashboard. Ask me about your own scores, trend, or coping strategies."
)


def check_input(message: str, scope: str = "manager") -> str | None:
    """Return a refusal string if the message crosses this surface's boundary, else None."""
    text = message or ""
    rules, refusal = (
        (_PERSONAL_RE, _PERSONAL_REFUSAL) if scope == "personal" else (_MANAGER_RE, _MANAGER_REFUSAL)
    )
    for rx in rules:
        if rx.search(text):
            return refusal
    return None


EMPTY_FALLBACK = (
    "I couldn't produce a grounded answer for that. Could you rephrase, or ask about your "
    "scores, your trend over time, or an evidence-based coping strategy?"
)


def build_footer(citations: list, scope: str = "manager") -> str:
    """Deterministic disclaimer footer appended after the streamed answer."""
    if scope == "personal":
        base = "_Based on your own assessments — a wellbeing aid, not a clinical or diagnostic tool._"
    else:
        base = "_Aggregate, de-identified signals only — a wellbeing aid, not a clinical or diagnostic tool._"
    if citations:
        base = "_Evidence-backed by the knowledge base (see sources). " + base.lstrip("_")
    return "\n\n" + base
