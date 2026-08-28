"""Function-call JSON schemas for the 6 Recovery Window voice tools.

Same shape as ciq.realtime.tools.schemas — kept in a separate module purely
for readability (this feature's schemas are numerous), imported into
middle_tier.py alongside the others.
"""

RECOVERY_INTAKE_ANSWER_SCHEMA = {
    "type": "function",
    "name": "record_recovery_intake_answer",
    "description": (
        "Record the user's answer to one Recovery Window intake question. Do NOT use this "
        "for the safety question ('safety') — that has its own dedicated tool, "
        "record_recovery_safety_answer; calling this tool with question_id='safety' will "
        "be rejected."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question_id": {
                "type": "string",
                "enum": [
                    "sleep_hours", "sleep_quality", "mental_drain", "emotional_heaviness",
                    "physical_tension", "high_stakes_task", "current_need", "duration",
                ],
                "description": "The intake question identifier.",
            },
            "answer_value": {
                "type": "string",
                "description": (
                    "The recorded answer, as a string. For 1-5 scale questions, the digit "
                    "1-5. For sleep_hours, the number of hours. For high_stakes_task, "
                    "'yes' or 'no'. For current_need, one of: thoughts_overloaded, "
                    "body_tense, emotionally_drained, disconnected, unknown, practical_plan. "
                    "For duration, one of: 3_min, 7_min, 12_min."
                ),
            },
            "high_stakes_task_window": {
                "type": "string",
                "enum": ["within_1_hour", "today", "this_week", "none"],
                "description": (
                    "Only relevant when question_id is 'high_stakes_task' and the answer is "
                    "'yes' — roughly when the high-stakes task/meeting/decision is."
                ),
            },
            "user_verbal_response": {
                "type": "string",
                "description": "The user's natural language response",
            },
        },
        "required": ["question_id", "answer_value"],
        "additionalProperties": False,
    },
}

RECOVERY_SAFETY_ANSWER_SCHEMA = {
    "type": "function",
    "name": "record_recovery_safety_answer",
    "description": (
        "Record the user's answer to the Recovery Window's safety question ONLY: "
        "'Are you feeling at risk of harming yourself or someone else?'. This is the ONLY "
        "tool that may be used for that question — never record_recovery_intake_answer. "
        "If this tool's result contains a message, you MUST speak that message to the user "
        "VERBATIM, word for word, and then STOP — do not continue the intake or ask further "
        "questions."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "answer": {
                "type": "string",
                "enum": ["no", "yes", "prefer_not_to_say"],
                "description": "The user's answer to the safety question.",
            },
        },
        "required": ["answer"],
        "additionalProperties": False,
    },
}

RECOVERY_RECOMMENDATION_SCHEMA = {
    "type": "function",
    "name": "get_recovery_recommendation_tool",
    "description": (
        "Compute a Recovery Window track recommendation. Call with stage='preliminary' "
        "once, right at the start of the flow (before any intake question), to narrate an "
        "initial suggestion. Call with stage='final' once, after all 8 non-safety intake "
        "questions have been answered and the safety question came back 'no', to get the "
        "confirmed recommendation to narrate and offer alongside its alternatives."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "stage": {
                "type": "string",
                "enum": ["preliminary", "final"],
                "description": "Which recommendation stage to compute.",
            },
        },
        "required": ["stage"],
        "additionalProperties": False,
    },
}

RECOVERY_SELECT_TRACK_SCHEMA = {
    "type": "function",
    "name": "select_recovery_track",
    "description": (
        "Record the user's final track choice — call this once after narrating the final "
        "recommendation and its alternatives, whether the user confirmed the recommended "
        "track or chose a different one."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "track_id": {
                "type": "string",
                "enum": [
                    "cbt_reframe_reset", "mindfulness_downshift",
                    "act_values_recalibration", "practical_recovery_plan",
                ],
                "description": "The track the user is proceeding with.",
            },
            "is_override": {
                "type": "boolean",
                "description": "True if this differs from the recommended track.",
            },
        },
        "required": ["track_id", "is_override"],
        "additionalProperties": False,
    },
}

RECOVERY_ADVANCE_STEP_SCHEMA = {
    "type": "function",
    "name": "advance_recovery_track_step",
    "description": (
        "Advance the guided track to the next step. Call this ONLY after you have spoken "
        "the current step's text and the user has acknowledged/responded — never before."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "step_index": {
                "type": "integer",
                "description": "The index (0-based) of the step you just delivered.",
            },
            "user_acknowledged": {
                "type": "boolean",
                "description": "True if the user responded/acknowledged the step.",
            },
        },
        "required": ["step_index", "user_acknowledged"],
        "additionalProperties": False,
    },
}

RECOVERY_REFLECTION_SCHEMA = {
    "type": "function",
    "name": "record_recovery_reflection",
    "description": (
        "Record the short post-session reflection after the guided track's final step. "
        "Call this once, after asking the user how they feel."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "feels_more_settled": {
                "type": "integer",
                "enum": [1, 2, 3, 4, 5],
                "description": "1 = not at all more settled, 5 = much more settled.",
            },
            "perceived_helpfulness": {
                "type": "integer",
                "enum": [1, 2, 3, 4, 5],
                "description": "1 = not helpful, 5 = very helpful.",
            },
            "next_step_chosen": {
                "type": "string",
                "description": "In the user's own words, what they'll do next.",
            },
            "wants_follow_up": {
                "type": "boolean",
                "description": "Whether the user would like a future follow-up.",
            },
        },
        "required": ["feels_more_settled", "perceived_helpfulness", "next_step_chosen", "wants_follow_up"],
        "additionalProperties": False,
    },
}
