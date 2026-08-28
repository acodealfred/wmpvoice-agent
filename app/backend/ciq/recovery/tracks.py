"""Static metadata for the four guided recovery tracks.

No LLM generation here by design — every track's copy/content is static and
pre-written, so the recommendation flow never depends on an LLM call.

Copy convention: always "guided recovery track(s)", never "treatment(s)" or
"therapy" — see ciq.recovery.guardrails' copy-audit table.
"""

TRACKS: dict[str, dict] = {
    "cbt_reframe_reset": {
        "id": "cbt_reframe_reset",
        "label": "CBT Reframe Reset",
        "description": (
            "A short cognitive-reframing exercise for when high-stakes tasks and "
            "racing thoughts are keeping your mind on edge — helps you notice and "
            "gently challenge the thought patterns driving the tension."
        ),
    },
    "mindfulness_downshift": {
        "id": "mindfulness_downshift",
        "label": "Mindfulness Downshift",
        "description": (
            "A guided breathing and body-awareness practice for when physical "
            "tension is running high — helps your nervous system downshift out of "
            "an activated state."
        ),
    },
    "act_values_recalibration": {
        "id": "act_values_recalibration",
        "label": "ACT Values Recalibration",
        "description": (
            "A reflective exercise for steady, chronic drain rather than an acute "
            "spike — reconnects your day-to-day work with what matters to you, "
            "using Acceptance and Commitment principles."
        ),
    },
    "practical_recovery_plan": {
        "id": "practical_recovery_plan",
        "label": "Practical Recovery Plan",
        "description": (
            "A structured, concrete set of recovery steps — the right fit when "
            "your signals are mixed, moderate, or when your self-reported burnout "
            "is elevated but your in-the-moment signals weren't."
        ),
    },
}

TRACK_IDS: tuple[str, ...] = tuple(TRACKS.keys())


def get_track(track_id: str) -> dict | None:
    return TRACKS.get(track_id)
