"""Report prompt/context builders — pure functions shared by the deterministic report
and the two on-demand AI endpoints. No I/O; unit-testable.

Biometric band categorisation comes from ``survey_loader`` (the single source of truth),
so the agent, the report endpoints and these prompts can never categorise the same
reading differently.
"""
import json

from survey_loader import (
    blink_band,
    effective_score,
    is_reverse_item,
    pupil_band,
)

# Ground truth for analysis — biometric behavioral rules, expressed as the
# categorical (Low/Medium/High) bands from the CIQ Signal-Thresholds reference.
RESEARCH_RULES = """
Blink-rate category (relative to the person's own calibrated baseline):
- "Normal": blink rate within ±15% of baseline.
- "Elevated": a sustained 15–40% change from baseline.
- "High": a sustained change greater than 40% from baseline (treat as significant only
  if corroborated by another signal).
Direction matters and is encoded in the category:
- "below baseline" (suppression) is associated with focused visual attention / engagement.
- "above baseline" (increase) is associated with fatigue or higher arousal / non-visual load.

Pupil-dilation category (change in mm vs the person's baseline):
- "Low": ≤ +0.1 mm (includes constriction).
- "Medium": +0.1 to +0.3 mm — moderate cognitive load.
- "High": > +0.3 mm — high cognitive load.
Caveat: pupil size is dominated by the light reflex; webcam estimates are coarse.

Do NOT infer stress from any single signal — none of these has a validated stress threshold.
"""


def build_analysis_prompt(survey_config: dict, snapshots: list) -> str:
    """System prompt for the behavioral-analysis engine (used by /report/behavioral-analysis).

    Each question carries BOTH user_answer (the actual answer on that question's own
    response scale — the only number ever shown back to the user) and burnout_contribution
    (internal, reverse-aware) for reasoning.
    """
    input_data = []
    for s in snapshots:
        qid = s.get("questionId", "")
        input_data.append({
            "question": qid,
            "domain": s.get("domain", ""),
            "user_answer": s.get("score", 0),
            "positive_item": is_reverse_item(survey_config, qid),
            "burnout_contribution": effective_score(survey_config, qid, s.get("score", 0)),
            "voice_sentiment": s.get("voiceSentiment", "neutral"),
            "blink_rate_category": blink_band(s.get("blinkRateChange")),
            "pupil_dilation_category": pupil_band(s.get("pupilMmChange")),
            "gaze_position": s.get("gazePosition", "Center"),
        })

    return f"""You are a behavioral analysis engine.

You MUST follow these rules strictly:

GROUNDING RULES:
- Use ONLY the provided "Research Rules" and "Input Data"
- Do NOT use external knowledge, assumptions, or general psychology
- If a conclusion cannot be derived from the rules, return "insufficient_evidence"

RESEARCH RULES:
{RESEARCH_RULES}

INPUT DATA:
{input_data}

SCORE REPORTING (STRICT):
- "user_answer" is the user's actual answer to that question, on that question's own
  response scale (this varies by question — do not assume it is always 1-5). When you
  refer to a question's score in any insight, you MUST cite "user_answer" — never any
  other number.
- "burnout_contribution" is an INTERNAL burnout-direction value (for "positive_item": true
  questions it is reversed, so a high "user_answer" yields a low "burnout_contribution").
  Use it ONLY to reason about burnout level. NEVER present "burnout_contribution" as the
  user's score, and never tell the user a question's score that differs from "user_answer".

EVIDENCE REQUIREMENT:
- Every insight MUST include: the exact rule used, the exact data point used

OUTPUT RULES:
- Output MUST be valid JSON
- No explanations outside JSON
- No additional commentary

ANALYSIS RULES:
- Reason about burnout level using "burnout_contribution" (higher = more burnout).
- Identify correlations between burnout_contribution and biometric change.
- Highlight contradictions (e.g., high burnout_contribution + relaxed biometric signal).
- Detect repeated patterns across questions.
- When you state a question's score back, cite "user_answer" (see SCORE REPORTING).
- Be conservative: prefer "insufficient_evidence" over guessing

CONFIDENCE:
- High: clear rule match + strong signal
- Medium: partial match
- Low: weak or borderline signal

Output JSON format:
{{
  "correlations": [{{"insight": "...", "rule": "...", "dataPoint": "...", "confidence": "high|medium|low"}}],
  "contradictions": [{{"insight": "...", "rule": "...", "dataPoint": "...", "confidence": "high|medium|low"}}],
  "patterns": [{{"insight": "...", "rule": "...", "dataPoint": "...", "confidence": "high|medium|low"}}],
  "summary": "Consultative summary of findings"
}}
"""


def build_snapshot_summary(snapshots: list) -> str:
    """Per-question lines (raw score + biometric categories) for the report context."""
    lines = []
    for s in snapshots:
        lines.append(
            f"Q{s.get('questionId','')}: score={s.get('score',0)}, domain={s.get('domain','')}, "
            f"voice_sentiment={s.get('voiceSentiment','')}, blink_rate={blink_band(s.get('blinkRateChange'))}, "
            f"pupil_dilation={pupil_band(s.get('pupilMmChange'))}, gaze_position={s.get('gazePosition','')}"
        )
    return "\n".join(lines)


def build_biometric_facts(snapshots: list) -> str:
    """Aggregate biometric readings stated factually (no interpretation)."""
    blink_changes = [s.get("blinkRateChange") or 0 for s in snapshots]
    avg_blink_change = sum(blink_changes) / len(blink_changes) if blink_changes else 0
    pupil_changes = [s.get("pupilMmChange") or 0 for s in snapshots]
    avg_pupil_change = sum(pupil_changes) / len(pupil_changes) if pupil_changes else 0
    gaze_counts: dict = {}
    for s in snapshots:
        g = s.get("gazePosition") or "Center"
        gaze_counts[g] = gaze_counts.get(g, 0) + 1
    dominant_gaze = max(gaze_counts, key=gaze_counts.get) if gaze_counts else "Center"
    per_q_blink = ", ".join(f"{s.get('questionId','')}={blink_band(s.get('blinkRateChange'))}" for s in snapshots)
    per_q_pupil = ", ".join(f"{s.get('questionId','')}={pupil_band(s.get('pupilMmChange'))}" for s in snapshots)
    per_q_gaze = ", ".join(f"{s.get('questionId','')}={s.get('gazePosition') or 'Center'}" for s in snapshots)
    return (
        f"- Overall blink-rate category: {blink_band(avg_blink_change)}\n"
        f"- Blink-rate category per question: {per_q_blink}\n"
        f"- Overall pupil-dilation category: {pupil_band(avg_pupil_change)}\n"
        f"- Pupil-dilation category per question: {per_q_pupil}\n"
        f"- Most frequent eye-gaze position: {dominant_gaze}\n"
        f"- Eye-gaze position per question: {per_q_gaze}"
    )


def build_consultative_prompt(total_score, max_score, interpretation, biometric_facts, analysis_result_str=""):
    """Consultative spoken-summary prompt. The behavioral analysis is optional — when it
    has not been generated, the summary is built from the deterministic score/risk + biometrics."""
    analysis_block = (
        f"BEHAVIORAL ANALYSIS (for your reference):\n{analysis_result_str}\n\n"
        if analysis_result_str else ""
    )
    return f"""You are a workplace wellbeing consultant reviewing the burnout assessment results.

FACTUAL SUMMARY (START YOUR RESPONSE BY STATING THIS):
- Total Burnout Score: {total_score} out of {max_score}
- Burnout Risk Level: {interpretation}

{analysis_block}BIOMETRIC READINGS (state these as plain facts — do NOT interpret them):
{biometric_facts}

Please provide a consultative response that:
1. Begins by clearly stating the total score and burnout risk level.
2. Highlights key findings (correlations, contradictions, patterns) if a behavioral analysis is provided.
3. Explains what the score means in practical terms.
4. Offers actionable insights and next steps based on the burnout findings.
5. Maintains a warm, supportive, professional tone.
6. Ends with a SEPARATE final paragraph that begins with the word "Also" and simply
   STATES the biometric readings above (blink-rate category, pupil-dilation category and
   eye-gaze position) as plain facts.

STRICT RULES FOR THE FINAL "Also" BIOMETRIC PARAGRAPH:
- Only report the biometric values exactly as given in BIOMETRIC READINGS.
- Do NOT explain, interpret, or speculate on what the biometrics mean.
- Do NOT connect the biometrics to burnout, stress, the score, or the user's wellbeing in any way.
- Keep it to one or two short factual sentences.

SCORE RULE:
- The Total Burnout Score above already accounts for reverse-scored positive items.
- If you mention any individual question's score, use the user's actual answer, on
  that question's own response scale (this varies by question — do not assume 1–5).
  Do NOT invert or recompute it for positively-worded items (e.g. Job Satisfaction,
  Personal Accomplishment) — a high satisfaction answer stays high when stated to the user.

Keep your response conversational and audio-friendly (short paragraphs, clear points).
IMPORTANT: Speak this response aloud to the user. Do NOT include JSON or code formatting."""


def build_consultative_prompt_sections(sections, biometric_facts, analysis_result_str=""):
    """Section-aware sibling of `build_consultative_prompt`, for surveys whose config
    declares `scoringSections` (e.g. PILOT's independent BAT-4 / CBI-WRB3 subscales —
    there is no single combined score to state for these)."""
    analysis_block = (
        f"BEHAVIORAL ANALYSIS (for your reference):\n{analysis_result_str}\n\n"
        if analysis_result_str else ""
    )
    scores_summary = "\n".join(
        f"- {s['label']} Score: {s['score']} (range {s['scoreRange'][0]}-{s['scoreRange'][1]}) — {s['interpretation']}"
        for s in sections
    )
    return f"""You are a workplace wellbeing consultant reviewing the burnout assessment results.

FACTUAL SUMMARY (START YOUR RESPONSE BY STATING EACH OF THESE, THEY ARE INDEPENDENT MEASURES):
{scores_summary}

{analysis_block}BIOMETRIC READINGS (state these as plain facts — do NOT interpret them):
{biometric_facts}

Please provide a consultative response that:
1. Begins by clearly stating EACH subscale's score and its own risk level — do NOT blend
   them into one combined number, they measure different things.
2. Highlights key findings (correlations, contradictions, patterns) if a behavioral analysis is provided.
3. Explains what each score means in practical terms.
4. Offers actionable insights and next steps based on the burnout findings.
5. Maintains a warm, supportive, professional tone.
6. Ends with a SEPARATE final paragraph that begins with the word "Also" and simply
   STATES the biometric readings above (blink-rate category, pupil-dilation category and
   eye-gaze position) as plain facts.

STRICT RULES FOR THE FINAL "Also" BIOMETRIC PARAGRAPH:
- Only report the biometric values exactly as given in BIOMETRIC READINGS.
- Do NOT explain, interpret, or speculate on what the biometrics mean.
- Do NOT connect the biometrics to burnout, stress, the score, or the user's wellbeing in any way.
- Keep it to one or two short factual sentences.

SCORE RULE:
- Each subscale score above already accounts for reverse-scored positive items.
- If you mention any individual question's score, use the user's actual answer, on
  that question's own response scale (this varies by question — do not assume 1–5).
  Do NOT invert or recompute it for positively-worded items — a high answer on a positive
  item stays high when stated to the user.

Keep your response conversational and audio-friendly (short paragraphs, clear points).
IMPORTANT: Speak this response aloud to the user. Do NOT include JSON or code formatting."""


def build_report_context(summary, snapshots, response_text="", analysis_data=None):
    """Full report context injected for the agent's follow-up Q&A. The consultative
    response and behavioral analysis are optional (filled in only once generated)."""
    domain_summary = "\n".join(f"- {dom}: {score} points" for dom, score in summary["domainTotals"].items())
    analysis_block = (
        json.dumps(analysis_data, indent=2) if isinstance(analysis_data, dict) and analysis_data else "(not generated yet)"
    )
    if "sections" in summary:
        scores_block = "\n".join(
            f"{s['label']} SCORE: {s['score']} (range {s['scoreRange'][0]}-{s['scoreRange'][1]}) — "
            f"{s['riskLevel']} ({s['interpretation']})"
            for s in summary["sections"]
        )
    else:
        scores_block = (
            f"TOTAL SCORE: {summary['totalScore']}/{summary['maxScore']}\n"
            f"RISK LEVEL: {summary['riskLevel']} ({summary['interpretation']})"
        )
    return f"""=== BURNOUT ASSESSMENT REPORT (COMPLETE) ===
{scores_block}

=== DOMAIN TOTALS ===
{domain_summary}

=== QUESTION DETAILS ===
(The "score" for each question below is the user's ACTUAL answer, on that question's own
response scale — this varies by question, do not assume 1–5. When the user asks about a
specific question's score, ALWAYS use this number. Positively-worded items such as Job
Satisfaction and Personal Accomplishment are reverse-scored ONLY inside the total burnout
score above — never invert an individual question's score when answering.)
{build_snapshot_summary(snapshots)}

=== AGENT CONSULTATIVE RESPONSE (spoken to user) ===
{response_text or "(not generated yet)"}

=== BEHAVIORAL ANALYSIS (JSON) ===
{analysis_block}
=== END REPORT ===
"""
