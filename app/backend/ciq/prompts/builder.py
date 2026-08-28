"""Agent instruction assembly — pure functions that turn session state + config into
the system-instruction string sent to Azure OpenAI on every ``session.update``.

Extracted from ``RTMiddleTier`` so the prompt logic is unit-testable without a
WebSocket: every function here takes its inputs explicitly and returns a string.
Behavior is preserved verbatim from the original ``_get_*_instructions`` methods,
including pre-existing whitespace/escaping quirks.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from ciq.recovery.intake_questions import INTAKE_QUESTIONS
from ciq.recovery.track_scripts import get_track_script
from survey_loader import compute_section_scores, get_score_bounds, options_for_question

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
The biometric signals are: blink-rate change, pupil dilation, left and right eye-gaze
position (tracked independently per eye), voice sentiment, and facial emotion.
- ALLOWED: factually STATE or DESCRIBE the biometric readings that were recorded
  (e.g. "your blink rate was elevated on two questions and your left and right gaze
  were both mostly centered"). Plain summaries of the recorded categories/values are fine.
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
    is_qualitative = bool(sess.survey_config.get("qualitative"))

    if sess.conversation_state == "report_delivered":
        if is_qualitative:
            instructions = """CONVERSATION STATE: REPORT JUST DELIVERED
- You have just finished delivering a warm, supportive readiness assessment summary.
- The user may have follow-up questions about the results.
- STAY IN THIS MODE until explicitly told otherwise or until a new assessment begins.

STRICT REPORT-ONLY GROUNDING (follow exactly):
- Answer ONLY from the REPORT CONTEXT below. This saved report is your single source
  of truth.
- DO NOT rely on anything said earlier in the conversation, on remembered chit-chat,
  or on general/training knowledge.
- If a question cannot be answered from the saved report, say plainly that you can
  only discuss the completed assessment report, and offer to go over the results.
- DO NOT restart, re-read, or re-run the assessment, and DO NOT ask the user to take
  it again unless they explicitly request it.
- There is no numeric per-question score to cite — this was a qualitative conversation.
  Speak in terms of themes and reflections, never a 1-5 number.

- Be prepared to explain (using only the report):
  * The assessment summary and what it reflects about their readiness
  * topic_feedback — your specific comments on what they said on each topic; if they
    ask "what did you think about what I said about X", answer from that topic's
    entry, referencing their own words
  * The actionable recommendations
  * The biometric readings that were recorded (see the BIOMETRIC GUARDRAIL above
    if present — when active, only describe them, do not interpret or advise)
- Maintain the consultative, supportive tone from the report delivery.
- Answer questions directly and informatively while staying conversational.
"""
        else:
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
        if is_qualitative:
            instructions = """CONVERSATION STATE: Q&A MODE
- You are answering user questions about their readiness assessment results.

STRICT REPORT-ONLY GROUNDING (follow exactly):
- Answer ONLY from the CURRENT REPORT CONTEXT below. This saved report is your single
  source of truth.
- DO NOT rely on anything said earlier in the conversation, on remembered chit-chat,
  or on general/training knowledge.
- If a question cannot be answered from the saved report, say plainly that you can
  only discuss the completed assessment report.
- DO NOT restart, re-read, or re-run the assessment.

- Be precise, helpful, and supportive.
- If the question is unrelated to their results, gently steer back to their wellbeing.
- Continue in this mode until the conversation ends or a new assessment starts.
"""
        else:
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
    is_qualitative = bool(survey_config.get("qualitative"))

    if sess.survey_results:
        answered_ids = list(sess.survey_results.keys())
        remaining_ids = [q["id"] for q in questions if q["id"] not in answered_ids]

        status_noun = "topics discussed" if is_qualitative else "questions answered"
        parts.append(f"\nSURVEY STATUS: {len(answered_ids)}/{total_questions} {status_noun}.")

        score_lines = []
        for q in questions:
            qid = q["id"]
            if qid in sess.survey_results:
                if is_qualitative:
                    score_lines.append(f"  {q['text']} ({qid}): discussed")
                else:
                    r = sess.survey_results[qid]
                    _, hi = get_score_bounds(survey_config, qid)
                    score_lines.append(f"  {q['text']} ({qid}): {r['score']}/{hi}")
        if score_lines:
            lines_label = "Topics discussed so far" if is_qualitative else "Scores recorded so far"
            parts.append(f"{lines_label}:\n" + "\n".join(score_lines))

        if not remaining_ids:
            if is_qualitative:
                parts.append(f"\nAll {total_questions} topics discussed.")
            elif survey_config.get("scoringSections"):
                # Independent subscales (e.g. PILOT's BAT-4 / CBI-WRB3) — never blend
                # into one combined total, same canonical helper query_survey_tool uses.
                snaps = [{"questionId": qid, "score": r["score"]} for qid, r in sess.survey_results.items()]
                sections = compute_section_scores(survey_config, snaps)
                section_lines = "\n".join(
                    f"  {s['label']}: {s['score']}/{s['scoreRange'][1]} — {s['interpretation']}"
                    for s in sections
                )
                parts.append(
                    f"\nAll {total_questions} questions answered. Independent subscale results:\n{section_lines}"
                )
            else:
                total_score = sum(r["score"] for r in sess.survey_results.values())
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
        report_noun = "readiness assessment report" if is_qualitative else "burnout report"
        parts.append(
            f"\nCONVERSATION STATE: The {report_noun} was already delivered and spoken to the user. "
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


def readiness_conversation_instructions(questions: list, is_returning_user: bool = False) -> str:
    """Build the natural-conversation script for a qualitative survey (e.g. READINESS).

    Deliberately NOT a numbered step script — this is a topic guide the agent weaves
    into a genuine back-and-forth conversation, in its own words, in whatever order
    feels natural, with real follow-up questions. Contrast with the rigid, verbatim
    numbered SURVEY STEPS script used for numeric surveys (survey_instructions below).
    """
    topics = "\n".join(f'- {q.get("domain", q["id"])}: "{q["prompt"]}" (question_id: {q["id"]})' for q in questions)

    if is_returning_user:
        opening = """OPENING (returning user — skipped recording):
1. Greet warmly: "Hello, welcome back!"
2. Ask ONE short, neutral small-talk question (weather, weekend, coffee/tea, surroundings —
   never work, stress, mood, or health) and acknowledge their reply in one sentence.
3. Then give a short, warm bridge line inviting them into the conversation, e.g. "lovely —
   if you're up for it, I'd love to hear how work's been feeling lately. Shall we chat?"
   Then STOP and WAIT for their reply — that reply is a CONFIRMATION, not an answer to any
   topic, so never call record_survey_response for it."""
    else:
        opening = """OPENING (you have just been making small talk with the user):
1. Do NOT greet the user again as if meeting them for the first time — you were just chatting.
2. Give ONE short, warm bridge line inviting them into the conversation, e.g. "nice chatting
   — if you're up for it, I'd love to hear how work's been feeling lately. Shall we chat?"
   Then STOP and WAIT for their reply — that reply is a CONFIRMATION, not an answer to any
   topic, so never call record_survey_response for it."""

    return f"""NATURAL CONVERSATION — FOLLOW THIS SPIRIT, NOT A SCRIPT

Your job is to have a genuine, flowing conversation that naturally covers every topic
below, then close warmly. This is NOT a scripted interview — do not read topics verbatim,
do not announce step numbers or "next question", and do not make it feel like a checklist.

{opening}

TOPICS TO EXPLORE (a guide, not a script — cover all of them by the end, in whatever
order the conversation naturally goes):
{topics}

HOW TO RUN THIS CONVERSATION:
- Use each topic's prompt as inspiration for what to explore, not text to recite. Ask
  about it in your own warm, natural words, phrased however fits the moment.
- Actually engage with what the user says: reflect it back briefly, and ask a genuine
  follow-up question when something is interesting, unclear, or worth digging into —
  one or two natural follow-ups per topic is normal conversation, not an interrogation.
- Let one topic flow into the next based on what the user just said, rather than
  abruptly switching subjects. You may cover two related topics in one exchange, or
  circle back to something they mentioned earlier, if that's how the conversation goes.
- You do not have to cover topics in the listed order if the conversation naturally
  leads somewhere else first — just make sure every topic ends up genuinely explored.
- If the user goes somewhere completely unrelated to work/readiness, gently and warmly
  steer back rather than abruptly redirecting.
- Never ask for a number, rating, or scale — this is about how they actually feel, in
  their own words.

WHEN TO RECORD (silent, never tell the user — the user never hears a number or scale):
- Once you've genuinely explored a topic (including any follow-up) and have a real,
  substantive sense of the user's answer, call record_survey_response with that topic's
  question_id — this can be after the follow-up exchange, not necessarily right after
  your first question on it.
- Silently classify how they came across on that topic as Low, Medium, or High (e.g. for
  workload: Low = feeling overloaded/struggling, Medium = manageable but some strain,
  High = comfortable/well-paced; adapt the same Low/Medium/High judgment call to each
  topic's own meaning), and pass it as score using 1 for Low, 3 for Medium, 5 for High.
  This is YOUR internal judgment call, made silently — NEVER mention Low/Medium/High,
  a number, or any scale to the user; they simply had a natural conversation.
- Also capture their natural-language answer via user_verbal_response, and include
  voice_sentiment, blink_rate_change_percent, and face_emotion when available.
- Do NOT call record_survey_response twice for the same question_id.

AFTER ALL {len(questions)} TOPICS HAVE BEEN GENUINELY EXPLORED:
- Do NOT calculate or state any score, rating, or number OUT LOUD — this is a qualitative
  conversation and the Low/Medium/High classifications above are for the written report
  only, never spoken.
- Give the user a genuine SPOKEN SUMMARY of the conversation before signing off — this is
  required, not optional. Briefly reflect back, in your own words, the key things you
  heard across the topics you covered (e.g. how they described their workload, energy,
  support, confidence, and overall readiness) so they know they were heard. Reference
  what they actually said — never a generic "thanks for sharing" with no substance.
  Keep it to a few warm, natural sentences, not a bullet-by-bullet recap.
- Still do NOT turn this into a score, rating, evaluation, or diagnosis — it's a
  reflection of what was discussed, not a verdict.
- After the summary, warmly and explicitly acknowledge that you've covered everything,
  and thank the user sincerely for their time and openness.
- Deliver a short, genuine, encouraging closing note — never abrupt. Make sure the
  conversation has a clear, positive close before you stop, e.g. "So it sounds like
  things have been busy but manageable, you're recharging okay, and you're feeling
  fairly confident about what's ahead — thank you so much for sharing all of that with
  me, I really appreciate your openness. That's everything I needed for now. Take care
  of yourself out there."
- Do NOT call query_survey_results — there is no numeric result to report for this
  conversation. This spoken summary is separate from, and does not replace, the
  detailed written report generated afterward."""


def survey_instructions(survey_config: dict, is_returning_user: bool = False) -> str:
    """Build the survey script the agent must follow exactly.

    The OPENING is phase-aware: by the time this is injected the warm-up has already
    happened, so the agent transitions in with a short bridge line rather than a fresh
    greeting. A returning user (skipped the 30s recording) gets a brief inline welcome +
    one small-talk question first; a first-time user (just finished warm-up) only bridges.

    Qualitative surveys (e.g. READINESS, ``config.get("qualitative")``) do NOT use this
    rigid numbered-step script at all — see readiness_conversation_instructions instead,
    which reads the same questions as a loose topic guide for a natural conversation.
    """
    config = survey_config
    questions = config.get("questions", [])
    if config.get("qualitative"):
        return readiness_conversation_instructions(questions, is_returning_user)

    # Each question can mark itself "statement" (a first-person claim the user rates
    # agreement with, e.g. BAT-4's "At work, I feel mentally exhausted.") or "question"
    # (a direct question, e.g. CBI's "Is your work emotionally exhausting?"). Surveys
    # that don't set it (test/full surveys, all phrased as literal questions) default
    # to "question" — only the pilot survey's BAT-4 items opt into "statement".
    def _item_style(q: dict) -> str:
        return q.get("style", "question")

    # Explain the response scale ONCE, right before Step 1, so the user knows how to
    # answer before the first item is read out — derived from the CURRENT question's
    # own scale (via `options_for_question`, section-aware for surveys like PILOT
    # where BAT-4 and CBI-WRB3 each have their own scale) rather than a single
    # survey-wide list, so it stays correct for any survey's label set.
    def _labels_for(q: dict) -> list[str]:
        return [o["label"] for o in options_for_question(config, q.get("id")) if o.get("label")]

    def _scale_intro(style: str, labels: list[str]) -> str:
        verb = "read out a statement" if style == "statement" else "ask a question"
        noun = "statement" if style == "statement" else "question"
        if len(labels) >= 2:
            return (
                f'Explain the response scale ONCE — e.g. "First, I\'ll {verb}, and you '
                f'can tell me how much it applies to you: {", ".join(labels[:-1])}, or '
                f'{labels[-1]}." Then ask Step 1\'s {noun}.'
            )
        return f"Then ask Step 1's {noun}."

    first_style = _item_style(questions[0]) if questions else "question"
    first_labels = _labels_for(questions[0]) if questions else []
    scale_step = _scale_intro(first_style, first_labels)

    if is_returning_user:
        opening = f"""OPENING (returning user — skipped recording):
1. Greet warmly: "Hello, welcome back!"
2. Ask ONE short, neutral small-talk question (weather, weekend, coffee/tea, surroundings —
   never work, stress, mood, or health) and acknowledge their reply in one sentence.
3. Then give a short bridge line asking permission to start, e.g. "lovely — if you're ready,
   I'd like to ask a few quick questions about how work's been feeling. Shall we start?" Then
   STOP and WAIT for the user's reply — do NOT ask Step 1's question in the same turn.
4. The user's reply to that permission question (e.g. "ok", "sure", "yes", "go ahead") is a
   CONFIRMATION, not a survey answer. Never call record_survey_response for it and never treat
   it as the answer to Step 1. Once they've confirmed, {scale_step} THEN wait for the actual
   answer to that question."""
    else:
        opening = f"""OPENING (you have just been making small talk with the user):
1. Do NOT greet the user again as if meeting them for the first time — you were just chatting.
2. Give ONE short, warm bridge line asking permission to start, e.g. "nice chatting — if you're
   ready, I'd like to ask a few quick questions about how work's been feeling. Shall we start?"
   Then STOP and WAIT for the user's reply — do NOT ask Step 1's question in the same turn.
3. The user's reply to that permission question (e.g. "ok", "sure", "yes", "go ahead") is a
   CONFIRMATION, not a survey answer. Never call record_survey_response for it and never treat
   it as the answer to Step 1. Once they've confirmed, {scale_step} THEN wait for the actual
   answer to that question."""

    # Each question on its own line: question text first, then the ID for the tool call on a
    # SEPARATE line so the agent cannot confuse "ask this text" with "call tool now".
    # When a survey mixes item styles (e.g. the pilot survey's BAT-4 statements followed
    # by CBI questions), a TRANSITION line is inserted right before the step where the
    # style changes so the agent announces the shift instead of silently switching tone.
    question_blocks = []
    prev_style = first_style
    for i, q in enumerate(questions):
        style = _item_style(q)
        noun = "statement" if style == "statement" else "question"
        labels = _labels_for(q)
        block = ""
        if i > 0 and style != prev_style:
            verb = "read a statement" if style == "statement" else "ask a question"
            # Always restate the scale here (never claim "the same scale" as before) —
            # a style change (e.g. BAT-4 -> CBI-WRB3) may also mean a different scale.
            if len(labels) >= 2:
                block += (
                    f'TRANSITION before Step {i + 1}: Briefly tell the user you\'re moving to a new '
                    f'set of items before asking, e.g. "Great, now I\'ll {verb} — you can answer using: '
                    f'{", ".join(labels[:-1])}, or {labels[-1]}." Then continue.\n\n'
                )
            else:
                block += (
                    f'TRANSITION before Step {i + 1}: Briefly tell the user you\'re moving to a new '
                    f'set of items before asking, e.g. "Great, now I\'ll {verb}." Then continue.\n\n'
                )
        block += (
            f'Step {i + 1}/{len(questions)}: Ask the {noun} — "{q["prompt"]}"\n'
            f'  Then WAIT for the user to answer. Once they answer, call record_survey_response with question_id="{q["id"]}".'
        )
        question_blocks.append(block)
        prev_style = style
    questions_script = "\n\n".join(question_blocks)

    after_all_answers = f"""AFTER ALL {len(questions)} ANSWERS:
- Do NOT calculate the score yourself. Call query_survey_results with query_type="burnout_score".
- The result contains either one "interpretation", or a "sections" list with one
  "interpretation" per section (e.g. two independent measures). Tell the user EVERY
  interpretation it returns, word for word, one at a time if there is more than one —
  they are independent results, never blend or average them together. Do not show numbers.
- This is the authoritative result — it applies reverse-scoring and the correct thresholds,
  so never override it with your own estimate."""
    tool_rules = """TOOL RULES (silent, never tell the user):
- record_survey_response: call ONLY after the user has answered that step's question.
  Required fields: question_id (as shown per step), score (matching the scale explained
  for that step — see the tool's own description for the exact value mapping),
  voice_sentiment, blink_rate_change_percent, face_emotion.
- DO NOT call record_survey_response for a question_id that you have already recorded.
- query_survey_results: call with "burnout_score" to deliver the final result, and use it
  again for any follow-up questions after the survey is complete."""

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
- The OPENING's permission question ("shall we start?") and Step 1's question are TWO SEPARATE
  turns. Never ask them together, and never treat the user's "ok"/"yes"/"sure" reply to the
  permission question as an answer to Step 1 — that reply only unlocks moving to Step 1, it does
  not answer it.
- Work through the questions in the given order, ONE at a time. Only ever handle the CURRENT
  step's question — never skip ahead, reorder, combine, or invent questions.
- Use ONLY the questions listed above. Do NOT use any burnout knowledge from your training to
  add, substitute, or expand the questions.
- Do NOT call record_survey_response when ASKING — only AFTER the user has answered (and after
  your single optional clarifying follow-up, if you used one).
- Do NOT call record_survey_response for a question_id you have already recorded.
- If the user goes off-topic, gently steer back: "Let's stay with this one for a moment —" and
  re-ask the current step's question.

{after_all_answers}

{tool_rules}"""


def recovery_meta_intent_instructions() -> str:
    """The CIQ Ethos layer (spec §2), formatted like meta_intent_instructions() but
    injected as its own APPLICATION META INTENT block (never replacing the main one),
    only while a recovery-window flow is active."""
    from ciq.prompts.personas import RECOVERY_META_INTENT

    cfg = RECOVERY_META_INTENT
    parts = [
        f"APP OVERVIEW:\\n{cfg['app_overview']}\\n",
        f"CAPABILITIES:\\n{cfg['capabilities']}\\n",
        f"LIMITATIONS:\\n{cfg['limitations']}\\n",
        f"PRIVACY:\\n{cfg['privacy']}\\n",
        f"DISCLAIMER:\\n{cfg['disclaimer']}\\n",
    ]
    body = "\\n".join(parts)
    return f"""RECOVERY WINDOW — APPLICATION META INTENT:
{body}
BEHAVIORAL GUIDELINES:
- Speak as a supportive guide, not an evaluator — never sound like you are judging,
  diagnosing, policing, or converting the person into a productivity metric.
- Use "suggests", "may indicate", and "based on your pattern" instead of hard labels.
- Never use the words "treatment" or "therapy" — always say "guided recovery track"
  or "recovery support".
"""


def recovery_window_instructions(sess: "SessionState") -> str:
    """The 9-question intake script + opening/recommendation narration (spec §7/§11).

    Driven entirely by `sess.recovery_intake_answers` — the agent is told exactly
    which question to ask next, so it can never re-ask an already-answered one, and
    this function is safe to call fresh on every session.update (idempotent framing).
    """
    answered = sess.recovery_intake_answers
    remaining = [q for q in INTAKE_QUESTIONS if q["id"] not in answered]

    just_starting = len(answered) == 0
    opening = ""
    if just_starting:
        opening = """Do NOT open by recapping the biometric/report results or asking whether they
want to "dive in" or continue — the user already opted in by starting the Recovery Window, so
that check-in question is redundant here and only delays the flow. Go straight into the OPENING
below, then the first question.

OPENING (say this before the first question, in your own natural words —
keep the meaning, not necessarily the exact wording):
"Before we begin, I want to make sure this feels respectful, useful, and safe for you.
You are more than this score, and this session is here to support you — not judge you."
Then briefly explain: "I'll ask a few quick questions because trust and context matter
before meaningful insight can be gained. Your individual answers are for your own
support — human data should never be used as a tool for fear, punishment, or
exploitation."
If you have NOT already called get_recovery_recommendation_tool with stage="preliminary"
this session, call it now (silently — do not narrate the tool call itself) and briefly
share its "rationale" in your own words, framed as preliminary: "Based on your recent
pattern, [rationale] — but let's check in with a few quick questions first before
confirming anything."
"""

    if not remaining:
        # All 9 questions answered — hand off to the final recommendation + track choice.
        return f"""{recovery_meta_intent_instructions()}

CONVERSATION STATE: RECOVERY WINDOW — ALL INTAKE QUESTIONS ANSWERED
Call get_recovery_recommendation_tool with stage="final" (silently). If its status is
"urgent_support" or "grounding_only", speak its "message" to the user VERBATIM, word for
word, and then STOP — do not continue, do not offer a track, do not ask further questions.
Otherwise, narrate the "rationale" in your own words using the CIQ Ethos framing:
"Based on your recent pattern and the closest evidence-informed options available, this
guided [track] track may help you recalibrate. You can choose another path if this
doesn't feel right." Briefly mention the alternatives by name. Then ask which track they'd
like — once they answer, call select_recovery_track with their choice (is_override=true
if it differs from the recommended track). Never call select_recovery_track before the
user has stated a preference."""

    next_question = remaining[0]
    if next_question["id"] == "safety":
        question_block = f"""NEXT QUESTION (the safety question — handle with care):
Ask, gently and without alarm: "{next_question['prompt']}"
Then WAIT for the answer, then call record_recovery_safety_answer (NEVER
record_recovery_intake_answer) with the answer mapped to "no", "yes", or
"prefer_not_to_say". If the tool's result contains a "message", you MUST speak that
message to the user VERBATIM, word for word, and then STOP — do not continue the intake
or ask further questions."""
    else:
        question_block = f"""NEXT QUESTION:
Ask, in your own natural words (keep the meaning unchanged): "{next_question['prompt']}"
(input format: {next_question['input']})
Then WAIT for the user's answer. Once they answer, call record_recovery_intake_answer
with question_id="{next_question['id']}" and the answer mapped to the format above.
{"For high_stakes_task, if the answer is yes, also ask roughly when and pass it as high_stakes_task_window (within_1_hour / today / this_week / none)." if next_question["id"] == "high_stakes_task" else ""}"""

    return f"""{recovery_meta_intent_instructions()}

CONVERSATION STATE: RECOVERY WINDOW — INTAKE ({len(answered)}/9 answered)
{opening}
{question_block}

STRICT RULES:
- Ask ONE question at a time, in the order given — never skip ahead or combine questions.
- Do NOT call any recording tool while ASKING — only AFTER the user has answered.
- Do NOT call a recording tool for a question_id already recorded.
- If the user goes off-topic, gently steer back and re-ask the current question."""


def recovery_track_instructions(sess: "SessionState") -> str:
    """Step-by-step guided-track delivery (spec §6/§11), once a track is selected."""
    duration = sess.recovery_intake_answers.get("duration")
    script = get_track_script(sess.recovery_selected_track or "", duration)
    step_index = sess.recovery_track_step_index
    total = len(script)

    if step_index >= total or not script:
        return f"""{recovery_meta_intent_instructions()}

CONVERSATION STATE: RECOVERY WINDOW — GUIDED TRACK COMPLETE
The guided track's steps are all delivered. Warmly close this part: "The goal here isn't
to prove anything — it's to protect your recovery and support you well." Then move into
the reflection questions (a separate instruction set will guide that next)."""

    step = script[step_index]
    return f"""{recovery_meta_intent_instructions()}

CONVERSATION STATE: RECOVERY WINDOW — GUIDED TRACK "{sess.recovery_selected_track}", step
{step_index + 1} of {total}. This is recovery support, not medical treatment.

Speak this step's text now, naturally (keep the meaning unchanged): "{step['text']}"
Then WAIT for the user's response/acknowledgment. Once they respond, call
advance_recovery_track_step with step_index={step_index} and user_acknowledged=true.
Do NOT call it before they've responded, and do NOT skip ahead to a later step."""


def recovery_reflection_instructions() -> str:
    """Post-session reflection (spec's step 8): 4 short questions, then record and close."""
    return f"""{recovery_meta_intent_instructions()}

CONVERSATION STATE: RECOVERY WINDOW — POST-SESSION REFLECTION
Ask these, one at a time, in your own natural words:
1. On a scale of 1-5, how much more settled do you feel right now than before we started?
2. On a scale of 1-5, how helpful did this feel?
3. In your own words, what's one next step you'll take?
4. Would you like a future follow-up on this?

Once you have all four answers, call record_recovery_reflection with
feels_more_settled (1-5), perceived_helpfulness (1-5), next_step_chosen (their words),
and wants_follow_up (true/false). Then close warmly: "Thank you for taking this time for
yourself. You are more than a score, and this was here to support you." Do not continue
the recovery flow after this — a new one only starts if the user asks for it."""


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
    enable_recovery_window: bool = False,
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

    # Skip the report-only Q&A grounding while a recovery flow is actively running: it
    # tells the agent to refuse anything not answerable from the saved report ("STRICT
    # REPORT-ONLY GROUNDING... say plainly that you can only discuss the completed
    # assessment report"), which directly contradicts the recovery instructions below
    # and was silently preventing the agent from ever starting the intake/track/
    # reflection conversation — the two blocks were being concatenated into one prompt
    # with opposite directives.
    recovery_flow_active = enable_recovery_window and sess.recovery_flow_state is not None
    state_instructions = conversation_state_instructions(sess) if not recovery_flow_active else ""
    if state_instructions:
        extra += "\n\n" + state_instructions

    # Recovery Window — a distinct post-survey flow, gated independent of
    # conversation_state/survey_phase (a session can be report_delivered/qa_mode AND
    # recovery_flow_state == "intake" at the same time, the natural real flow: report
    # delivered, then recovery starts).
    if enable_recovery_window and sess.recovery_flow_state == "intake":
        extra += "\n\n" + recovery_window_instructions(sess)
    elif enable_recovery_window and sess.recovery_flow_state == "track_running":
        extra += "\n\n" + recovery_track_instructions(sess)
    elif enable_recovery_window and sess.recovery_flow_state == "reflection":
        extra += "\n\n" + recovery_reflection_instructions()

    reconnect = reconnect_instructions(sess, survey_config)
    if reconnect:
        extra += reconnect

    extra += "\n\n" + stress_instructions(sess.stress_state)

    return base_instructions + extra
