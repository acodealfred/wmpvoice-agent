"""Agent instruction assembly — pure functions that turn session state + config into
the system-instruction string sent to Azure OpenAI on every ``session.update``.

Extracted from ``RTMiddleTier`` so the prompt logic is unit-testable without a
WebSocket: every function here takes its inputs explicitly and returns a string.
Behavior is preserved verbatim from the original ``_get_*_instructions`` methods,
including pre-existing whitespace/escaping quirks.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ciq.realtime.session import SessionState

# Appended verbatim (indentation included) when sentiment analysis is enabled.
SENTIMENT_INSTRUCTION = """ Additionally, you must analyze the sentiment of the user's input.
                        After each user message, determine if the sentiment is "positive", "neutral", or "negative".
                        IMPORTANT: You must call the 'report_sentiment' tool with the sentiment analysis results after each user message.
                        Do NOT speak or mention the sentiment analysis results out loud. The sentiment is for display purposes only."""


def meta_intent_instructions(meta_intent_config: dict | None) -> str:
    """Generate meta intent instructions from APP.md content for LLM context."""
    cfg = meta_intent_config or {}
    app_overview = cfg.get("app_overview", "")
    capabilities = cfg.get("capabilities", "")
    limitations = cfg.get("limitations", "")
    privacy = cfg.get("privacy", "")
    biometrics_note = cfg.get("biometrics_note", "")
    disclaimer = cfg.get("disclaimer", "")
    parts = []
    if app_overview:
        parts.append(f"APP OVERVIEW:\\n{app_overview}\\n")
    if capabilities:
        parts.append(f"CAPABILITIES:\\n{capabilities}\\n")
    if limitations:
        parts.append(f"LIMITATIONS:\\n{limitations}\\n")
    if privacy:
        parts.append(f"PRIVACY:\\n{privacy}\\n")
    if biometrics_note:
        parts.append(f"BIOMETRICS:\\n{biometrics_note}\\n")
    if disclaimer:
        parts.append(f"DISCLAIMER:\\n{disclaimer}\\n")
    body = "\\n".join(parts)
    return f"""APPLICATION META INTENT - CONTEXT FOR ASSISTANT:
{body}
BEHAVIORAL GUIDELINES:
- Use the above information to answer user questions about the application
- Stay within the defined scope and limitations
- If asked about medical advice, direct to the disclaimer
- Use biometrics info only as conversational context, not for diagnosis
"""


def biometric_guardrail_instructions(enabled: bool) -> str:
    """Descriptive-only guardrail for biometric signals (toggled from the Admin tab).

    When enabled, the agent may STATE recorded biometric readings but must decline
    any interpretive, causal, mechanistic, predictive, or prescriptive question.
    """
    if not enabled:
        return ""
    return """BIOMETRIC GUARDRAIL (STRICT — follow exactly):
The biometric signals are: blink-rate change, pupil dilation, eye-gaze position,
voice sentiment, and facial emotion.
- ALLOWED: factually STATE or DESCRIBE the biometric readings that were recorded
  (e.g. "your blink rate was elevated on two questions and your gaze was mostly
  centered"). Plain summaries of the recorded categories/values are fine.
- NOT ALLOWED for biometrics: interpreting what a reading MEANS, explaining WHY a
  reading occurred, describing HOW a biometric works or behaves in any state, or
  PREDICTING or RECOMMENDING anything based on a biometric.
- If the user asks anything interpretive, causal, mechanistic, predictive, or
  prescriptive about the biometrics, DO NOT answer it. Decline gracefully with
  exactly this sentence: "Currently not enough verified data to answer your request."
  You may then offer to simply state the recorded readings instead.
- This guardrail applies ONLY to the biometric signals above. You may still fully
  explain the burnout score, what it means, and wellbeing recommendations as usual.
"""


def stress_instructions(stress_state: str) -> str:
    """Generate instructions based on user's stress state."""
    if stress_state == "stressed":
        return """EMOTIONAL ADAPTATION - USER APPEARS STRESSED:
- Speak slowly and gently
- Reassure the user that it's okay to take their time
- Offer short breaks if needed
- Keep explanations simple and not overwhelming
- Be patient and empathetic
- Acknowledge their stress: "I can see this might be a bit overwhelming. Let's take it one step at a time." """
    elif stress_state == "relaxed":
        return """EMOTIONAL ADAPTATION - USER APPEARS RELAXED:
- Proceed at a normal pace
- Maintain a calm, friendly tone
- The user seems comfortable, so continue normally """
    else:
        return """EMOTIONAL ADAPTATION - USER STATE IS NORMAL:
- Proceed with normal conversation
- Maintain a helpful, friendly tone """


def conversation_state_instructions(sess: "SessionState") -> str:
    """Generate instructions based on current conversation state to maintain continuity."""
    _MAX_CTX = 2500  # chars; keeps combined instructions well inside Azure limits

    if sess.conversation_state == "report_delivered":
        instructions = """CONVERSATION STATE: REPORT JUST DELIVERED
- You have just finished delivering a comprehensive burnout assessment report with analysis.
- The user may have follow-up questions about the results.
- STAY IN THIS MODE until explicitly told otherwise or until a new assessment begins.

STRICT REPORT-ONLY GROUNDING (follow exactly):
- Answer ONLY from the REPORT CONTEXT below and the data returned by the
  query_survey_results tool. This saved report is your single source of truth.
- DO NOT rely on anything said earlier in the conversation, on remembered chit-chat,
  or on general/training knowledge about burnout.
- If a question cannot be answered from the saved report, say plainly that you can
  only discuss the completed assessment report, and offer to go over the results.
- DO NOT restart, re-read, or re-run the survey, and DO NOT ask the user to take it
  again unless they explicitly request it.
- INDIVIDUAL QUESTION SCORES: when the user asks about a single question's score (e.g.
  job satisfaction, personal accomplishment), give their ACTUAL answer (1–5) from the
  report's QUESTION DETAILS. The query_survey_results totals/domain figures are
  burnout-direction (positive items reversed) and are ONLY for overall risk and
  domain-contribution context — never quote them as an individual question's score.

- Be prepared to explain (using only the report):
  * What the correlations/contradictions mean
  * Actionable recommendations based on the burnout findings
  * Any aspect of the burnout assessment results
  * The biometric readings that were recorded (see the BIOMETRIC GUARDRAIL above
    if present — when active, only describe them, do not interpret or advise)
- Maintain the consultative, supportive tone from the report delivery.
- Answer questions directly and informatively while staying conversational.
"""
        if sess.report_context:
            ctx = sess.report_context[:_MAX_CTX]
            if len(sess.report_context) > _MAX_CTX:
                ctx += "\n[...truncated for brevity...]"
            instructions += f"\nREPORT CONTEXT (for Q&A):\n{ctx}\n"
        return instructions
    elif sess.conversation_state == "qa_mode":
        instructions = """CONVERSATION STATE: Q&A MODE
- You are answering user questions about their burnout assessment results.

STRICT REPORT-ONLY GROUNDING (follow exactly):
- Answer ONLY from the CURRENT REPORT CONTEXT below and the data returned by the
  query_survey_results tool. This saved report is your single source of truth.
- DO NOT rely on anything said earlier in the conversation, on remembered chit-chat,
  or on general/training knowledge about burnout.
- If a question cannot be answered from the saved report, say plainly that you can
  only discuss the completed assessment report.
- DO NOT restart, re-read, or re-run the survey.

- Be precise, helpful, and supportive.
- If the question is unrelated to their results, gently steer back to their wellbeing.
- Continue in this mode until the conversation ends or a new assessment starts.
"""
        if sess.report_context:
            ctx = sess.report_context[:_MAX_CTX]
            if len(sess.report_context) > _MAX_CTX:
                ctx += "\n[...truncated for brevity...]"
            instructions += f"\nCURRENT REPORT CONTEXT:\n{ctx}\n"
        return instructions
    return ""


def reconnect_instructions(sess: "SessionState", survey_config: dict) -> str:
    """Build a context block injected on reconnect so the agent resumes naturally."""
    if sess.connection_count <= 1:
        return ""

    parts = ["\n\n=== RECONNECT — CRITICAL CONTEXT ==="]
    parts.append(
        "IMPORTANT: The user's connection dropped and has just reconnected. "
        "This is NOT a new conversation. DO NOT re-introduce yourself. "
        "DO NOT greet the user as if you are meeting them for the first time. "
        "DO NOT suggest starting a survey. Just say something brief like "
        "\"Welcome back — shall we continue?\" and wait for their response."
    )

    questions = survey_config.get("questions", [])
    total_questions = len(questions)

    if sess.survey_results:
        answered_ids = list(sess.survey_results.keys())
        total_score = sum(r["score"] for r in sess.survey_results.values())
        remaining_ids = [q["id"] for q in questions if q["id"] not in answered_ids]

        parts.append(f"\nSURVEY STATUS: {len(answered_ids)}/{total_questions} questions answered.")

        score_lines = []
        for q in questions:
            qid = q["id"]
            if qid in sess.survey_results:
                r = sess.survey_results[qid]
                score_lines.append(f"  {q['text']} ({qid}): {r['score']}/5")
        if score_lines:
            parts.append("Scores recorded so far:\n" + "\n".join(score_lines))

        if not remaining_ids:
            # Survey complete — compute risk level
            if total_score <= 12:
                risk = "Low burnout risk"
            elif total_score <= 22:
                risk = "Moderate burnout risk"
            else:
                risk = "High burnout risk"
            parts.append(
                f"\nAll {total_questions} questions answered. "
                f"Total score: {total_score}/{total_questions * 5} — {risk}."
            )
        else:
            next_q_id = remaining_ids[0]
            next_q = next((q for q in questions if q["id"] == next_q_id), None)
            if next_q:
                parts.append(f"\nNext unanswered question: '{next_q['prompt']}' (id: {next_q_id}).")

    if sess.conversation_state in ("report_delivered", "qa_mode"):
        parts.append(
            "\nCONVERSATION STATE: The burnout report was already delivered and spoken to the user. "
            "You MUST stay in Q&A mode. DO NOT re-read the full report. DO NOT re-run the survey. "
            "Answer specific questions the user asks about their results."
        )

    parts.append("\n=== END RECONNECT CONTEXT ===")
    return "\n".join(parts)


def warmup_instructions() -> str:
    """Warm-up phase script: neutral small talk while the 30s baseline records.

    Injected ONLY while ``survey_phase == "warmup"`` (a fresh / expired baseline). The
    survey questions are deliberately withheld here — the agent has no questions to ask
    and must NOT start the assessment. The warm-up → survey transition is NOT the agent's
    decision; it fires when the 30s baseline completes (frontend unlocks the phase and
    re-sends session.update), after which survey_instructions takes over.
    """
    return """WARM-UP PHASE — light small talk only (follow exactly):
- We are quietly getting set up in the background. Your ONLY job right now is to keep the
  user relaxed and naturally talking with brief, friendly small talk.
- Open with a short, warm greeting and ONE easy small-talk question.
- Stay on neutral, low-effort topics ONLY: the weather, their weekend or plans, coffee or
  tea, their surroundings or where they're sitting — something light and pleasant.
- STRICTLY AVOID anything about work, their job, stress, pressure, mood, feelings, energy,
  sleep, health, or how they're coping. Those topics must wait until later.
- Keep it to one short exchange at a time: warmly acknowledge what they say, then ask
  another light question if the conversation lulls. Keep your turns to one or two sentences.
- Do NOT mention surveys, questions, assessments, scoring, burnout, or that anything is
  being recorded or calibrated.
- Do NOT start the assessment or ask any assessment question yet — you do not have those
  questions available. Simply keep the friendly chat going until you are told to continue."""


def survey_instructions(survey_config: dict, is_returning_user: bool = False) -> str:
    """Build the survey script the agent must follow exactly.

    The OPENING is phase-aware: by the time this is injected the warm-up has already
    happened, so the agent transitions in with a short bridge line rather than a fresh
    greeting. A returning user (skipped the 30s recording) gets a brief inline welcome +
    one small-talk question first; a first-time user (just finished warm-up) only bridges.
    """
    config = survey_config
    questions = config.get("questions", [])

    if is_returning_user:
        opening = f"""OPENING (returning user — skipped recording):
1. Greet warmly: "Hello, welcome back!"
2. Ask ONE short, neutral small-talk question (weather, weekend, coffee/tea, surroundings —
   never work, stress, mood, or health) and acknowledge their reply in one sentence.
3. Then give a short bridge line, e.g. "lovely — if you're ready, I'd like to ask a few quick
   questions about how work's been feeling." Then go to Step 1."""
    else:
        opening = f"""OPENING (you have just been making small talk with the user):
1. Do NOT greet the user again as if meeting them for the first time — you were just chatting.
2. Give ONE short, warm bridge line, e.g. "nice chatting — if you're ready, I'd like to ask a
   few quick questions about how work's been feeling." Then go to Step 1."""

    # Each question on its own line: question text first, then the ID for the tool call on a
    # SEPARATE line so the agent cannot confuse "ask this text" with "call tool now".
    question_blocks = []
    for i, q in enumerate(questions):
        question_blocks.append(
            f'Step {i + 1}/{len(questions)}: Ask the question — "{q["prompt"]}\n'
            f'  Then WAIT for the user to answer. Once they answer, call record_survey_response with question_id="{q["id"]}".'
        )
    questions_script = "\n\n".join(question_blocks)

    return f"""SURVEY SCRIPT — FOLLOW THIS EXACTLY

Your only job is to deliver this {len(questions)}-question check-in, then share the result.

{opening}

SURVEY STEPS (do these in order, one at a time):

{questions_script}

HOW TO ASK EACH QUESTION (conversational, not an interrogation):
- Briefly and neutrally acknowledge the user's previous answer in a few words ("thanks for
  sharing that", "got it"). Do NOT evaluate, heap praise, or interpret what they said.
- Optionally add ONE short bridge sentence connecting to the next topic.
- Ask the CURRENT step's question. You may phrase it naturally and warmly, but you MUST keep
  its original meaning and MUST NOT change what it is measuring.
- If the answer is vague or doesn't map to a score, ask AT MOST ONE short clarifying follow-up,
  then record it and move on. Never ask more than one follow-up for a question.

STRICT RULES:
- Work through the questions in the given order, ONE at a time. Only ever handle the CURRENT
  step's question — never skip ahead, reorder, combine, or invent questions.
- Use ONLY the questions listed above. Do NOT use any burnout knowledge from your training to
  add, substitute, or expand the questions.
- Do NOT call record_survey_response when ASKING — only AFTER the user has answered (and after
  your single optional clarifying follow-up, if you used one).
- Do NOT call record_survey_response for a question_id you have already recorded.
- If the user goes off-topic, gently steer back: "Let's stay with this one for a moment —" and
  re-ask the current step's question.

AFTER ALL {len(questions)} ANSWERS:
- Do NOT calculate the score yourself. Call query_survey_results with query_type="burnout_score".
- The result contains either one "interpretation", or a "sections" list with one
  "interpretation" per section (e.g. two independent measures). Tell the user EVERY
  interpretation it returns, word for word, one at a time if there is more than one —
  they are independent results, never blend or average them together. Do not show numbers.
- This is the authoritative result — it applies reverse-scoring and the correct thresholds,
  so never override it with your own estimate.

TOOL RULES (silent, never tell the user):
- record_survey_response: call ONLY after the user has answered that step's question.
  Required fields: question_id (as shown per step), score 1–5, voice_sentiment, blink_rate_change_percent, face_emotion.
- DO NOT call record_survey_response for a question_id that you have already recorded.
- query_survey_results: call with "burnout_score" to deliver the final result, and use it
  again for any follow-up questions after the survey is complete."""


def build_session_instructions(
    *,
    base_message: str | None,
    sess: "SessionState",
    survey_config: dict,
    enable_meta_intent: bool,
    meta_intent_config: dict | None,
    enable_sentiment: bool,
    enable_survey: bool,
    biometric_guardrail_enabled: bool,
) -> str:
    """Assemble the full system-instruction string for a ``session.update``.

    Mirrors the original ``RTMiddleTier._process_message_to_server`` assembly order:
    base persona → meta intent → biometric guardrail → sentiment → survey script
    (only while active) → conversation-state grounding → reconnect → stress adaptation.
    """
    base_instructions = base_message or ""
    # Force English. The agent opens the conversation proactively (response.create) before
    # the user has said anything, so it has no language cue to anchor on and may otherwise
    # greet in another language. Pin it up front so it applies to every phase.
    extra = (
        "\n\nLANGUAGE: Speak and respond in English (US) by default, including your very "
        "first greeting. Even if the user speaks in another language, keep replying in "
        "English UNLESS they explicitly ask you to switch languages — only then switch.\n"
    )

    if enable_meta_intent:
        extra += meta_intent_instructions(meta_intent_config)

    guardrail = biometric_guardrail_instructions(biometric_guardrail_enabled)
    if guardrail:
        extra += "\n\n" + guardrail

    if enable_sentiment:
        extra += SENTIMENT_INSTRUCTION

    # Inject the survey script ONLY while actively running a survey. Once a report
    # has been delivered the session moves to report_delivered/qa_mode and must NOT
    # see the survey steps again. While still in the warm-up phase the questions are
    # gated out entirely — the agent gets the small-talk script instead, until the
    # 30s baseline completes and unlocks survey_phase.
    if enable_survey and sess.conversation_state == "active":
        if sess.survey_phase == "warmup":
            extra += "\n\n" + warmup_instructions()
        else:
            extra += "\n\n" + survey_instructions(survey_config, sess.is_returning_user)

    state_instructions = conversation_state_instructions(sess)
    if state_instructions:
        extra += "\n\n" + state_instructions

    reconnect = reconnect_instructions(sess, survey_config)
    if reconnect:
        extra += reconnect

    extra += "\n\n" + stress_instructions(sess.stress_state)

    return base_instructions + extra
