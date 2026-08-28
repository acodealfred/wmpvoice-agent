"""The 9-question Recovery Window intake — canonical list (spec §7).

Single source of truth for both the voice-agent script (embedded into
ciq.prompts.builder.recovery_window_instructions) and the tool-call contract
(ciq.realtime.tools.recovery_schemas) — so the two can never drift apart.
`input` is a human-readable hint only (not machine-validated here);
`answer_values` lists the valid wire values for choice/enum questions (None
for free-form numeric ones).
"""

INTAKE_QUESTIONS: list[dict] = [
    {
        "id": "sleep_hours",
        "theme": "sleep",
        "prompt": "How many hours did you sleep in the last 24 hours?",
        "input": "number, 0-14",
        "answer_values": None,
    },
    {
        "id": "sleep_quality",
        "theme": "sleep",
        "prompt": "How would you rate the quality of that sleep?",
        "input": "scale 1-5 (1 = very poor, 5 = very good)",
        "answer_values": ["1", "2", "3", "4", "5"],
    },
    {
        "id": "mental_drain",
        "theme": "drain",
        "prompt": "How mentally drained do you feel right now?",
        "input": "scale 1-5 (1 = not at all, 5 = completely)",
        "answer_values": ["1", "2", "3", "4", "5"],
    },
    {
        "id": "emotional_heaviness",
        "theme": "emotion",
        "prompt": "How emotionally heavy does today feel?",
        "input": "scale 1-5 (1 = not at all, 5 = very heavy)",
        "answer_values": ["1", "2", "3", "4", "5"],
    },
    {
        "id": "physical_tension",
        "theme": "tension",
        "prompt": "How physically tense or restless do you feel?",
        "input": "scale 1-5 (1 = none, 5 = a great deal)",
        "answer_values": ["1", "2", "3", "4", "5"],
    },
    {
        "id": "high_stakes_task",
        "theme": "high_stakes",
        "prompt": "Do you have a high-stakes task, meeting, shift, or decision coming up soon?",
        "input": "yes/no, plus roughly when (within_1_hour / today / this_week / none)",
        "answer_values": ["yes", "no"],
    },
    {
        "id": "current_need",
        "theme": "current_need",
        "prompt": "What feels most true right now?",
        "input": "thoughts overloaded / body tense / emotionally drained / disconnected / unknown / practical plan",
        "answer_values": [
            "thoughts_overloaded", "body_tense", "emotionally_drained",
            "disconnected", "unknown", "practical_plan",
        ],
    },
    {
        "id": "duration",
        "theme": "duration_preference",
        "prompt": "Would you prefer a 3-minute reset, 7-minute guided session, or 12-minute deeper session?",
        "input": "3_min / 7_min / 12_min",
        "answer_values": ["3_min", "7_min", "12_min"],
    },
    {
        "id": "safety",
        "theme": "safety_risk",
        "prompt": "Are you feeling at risk of harming yourself or someone else?",
        "input": "no / yes / prefer_not_to_say",
        "answer_values": ["no", "yes", "prefer_not_to_say"],
    },
]

# Convenience lookups.
INTAKE_QUESTION_IDS: list[str] = [q["id"] for q in INTAKE_QUESTIONS]
INTAKE_THEME_BY_ID: dict[str, str] = {q["id"]: q["theme"] for q in INTAKE_QUESTIONS}


def get_intake_question(question_id: str) -> dict | None:
    return next((q for q in INTAKE_QUESTIONS if q["id"] == question_id), None)
