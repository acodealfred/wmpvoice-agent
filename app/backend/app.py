import base64
import json
import logging
import os
from pathlib import Path

import boto3
from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import AzureDeveloperCliCredential, DefaultAzureCredential
from dotenv import load_dotenv

from biometric_interpreter import analyze_stress
from rtmt import RTMiddleTier

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
)
logger = logging.getLogger("voicerag")
logger.setLevel(logging.INFO)


async def analyze_report(request):
    """Analyze the detailed burnout report using behavioral analysis engine"""
    try:
        data = await request.json()
        snapshots = data.get("snapshots", [])

        if not snapshots:
            return web.json_response({"error": "No snapshot data provided"}, status=400)

        # Ground truth for analysis - blink rate behavioral rules
        research_rules = """
Blink Rate (BR): The blink-rate varies with emotional and physical stimulus. When humans are 
captivated, interested or otherwise curious about something in their field of view, the blink 
rate will slow and gradually decline as the interest piquies. Conversely, an increasing or 
rapid blink rate is indicative of high-stress and associated with low levels of concentration 
and interest. A rapid blinking during conversation can also be interpreted as a feeling of 
superiority and contempt.
"""

        # Build input data from snapshots - only using required fields
        input_data = []
        for s in snapshots:
            br_change = s.get("blinkRateChange", 0)
            br_stress = "High" if br_change > 30 else "Low" if br_change < -30 else "Normal"
            input_data.append({
                "question": s.get("questionId", ""),
                "domain": s.get("domain", ""),
                "score": s.get("score", 0),
                "voice_sentiment": s.get("voiceSentiment", "neutral"),
                "blink_rate_change": br_change,
                "br_stress": br_stress,
            })

        # System prompt for the analysis engine
        system_prompt = f"""You are a behavioral analysis engine.

You MUST follow these rules strictly:

GROUNDING RULES:
- Use ONLY the provided "Research Rules" and "Input Data"
- Do NOT use external knowledge, assumptions, or general psychology
- If a conclusion cannot be derived from the rules, return "insufficient_evidence"

RESEARCH RULES:
{research_rules}

INPUT DATA:
{input_data}

EVIDENCE REQUIREMENT:
- Every insight MUST include: the exact rule used, the exact data point used

OUTPUT RULES:
- Output MUST be valid JSON
- No explanations outside JSON
- No additional commentary

ANALYSIS RULES:
- Identify correlations between score and biometric change
- Highlight contradictions (e.g., high score + stress signal)
- Detect repeated patterns across questions
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

        rtmt = request.app.get("rtmt")
        if not rtmt:
            return web.json_response({"error": "Analysis service not available"}, status=503)

        # Call LLM for behavioral analysis
        analysis_result_str = await rtmt.analyze_with_prompt(system_prompt)

        # Parse analysis result
        try:
            analysis_data = json.loads(analysis_result_str)
        except json.JSONDecodeError:
            analysis_data = {"raw": analysis_result_str}

        # Compute totals and risk
        total_score = sum(s.get('score', 0) for s in snapshots)
        max_score = len(snapshots) * 5
        if total_score <= 12:
            risk_level = "Low"
            interpretation = "Low burnout risk"
        elif total_score <= 22:
            risk_level = "Moderate"
            interpretation = "Moderate burnout risk"
        else:
            risk_level = "High"
            interpretation = "High burnout risk"

        # Domain totals
        domain_totals = {}
        for s in snapshots:
            dom = s.get('domain', 'Unknown')
            domain_totals[dom] = domain_totals.get(dom, 0) + s.get('score', 0)
        domain_lines = [f"- {dom}: {score} points" for dom, score in domain_totals.items()]
        domain_summary = "\n".join(domain_lines)

        # Snapshot lines
        snapshot_lines = []
        for s in snapshots:
            snapshot_lines.append(
                f"Q{s.get('questionId','')}: score={s.get('score',0)}, domain={s.get('domain','')}, "
                f"voice_sentiment={s.get('voiceSentiment','')}, blink_change={s.get('blinkRateChange',0)}%, face_emotion={s.get('faceEmotion','')}"
            )
        snapshot_summary = "\n".join(snapshot_lines)

        # Build consultative prompt that explicitly states score/risk
        consultative_prompt = f"""You are a workplace wellbeing consultant reviewing the burnout assessment results.

FACTUAL SUMMARY (START YOUR RESPONSE BY STATING THIS):
- Total Burnout Score: {total_score} out of {max_score}
- Burnout Risk Level: {interpretation}

BEHAVIORAL ANALYSIS (for your reference):
{analysis_result_str}

Please provide a consultative response that:
1. Begins by clearly stating the total score and burnout risk level.
2. Highlights key findings from the analysis (correlations, contradictions, patterns).
3. Explains what the score means in practical terms.
4. Offers actionable insights and next steps based on the biometric data.
5. Maintains a warm, supportive, professional tone.

Keep your response conversational and audio-friendly (short paragraphs, clear points).
IMPORTANT: Speak this response aloud to the user. Do NOT include JSON or code formatting."""

        response_text = await rtmt.analyze_with_prompt(consultative_prompt)

        # Build comprehensive report context for follow-up Q&A
        analysis_block = json.dumps(analysis_data, indent=2) if isinstance(analysis_data, dict) else str(analysis_data)
        report_context_full = f"""=== BURNOUT ASSESSMENT REPORT (COMPLETE) ===
TOTAL SCORE: {total_score}/{max_score}
RISK LEVEL: {risk_level} ({interpretation})

=== DOMAIN TOTALS ===
{domain_summary}

=== QUESTION DETAILS ===
{snapshot_summary}

=== AGENT CONSULTATIVE RESPONSE (spoken to user) ===
{response_text}

=== BEHAVIORAL ANALYSIS (JSON) ===
{analysis_block}
=== END REPORT ===
"""
        rtmt.set_conversation_state("report_delivered", report_context_full)
        logger.info("[APP] ★ Report delivered, state=report_delivered with full context including burnout state")

        return web.json_response({"analysis": analysis_data, "agentResponse": response_text})

    except Exception as e:
        logger.error(f"Report analysis error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def analyze_face(request, rtmt: RTMiddleTier):
    """Analyze face from image data using AWS Rekognition"""
    try:
        data = await request.json()
        image_data = data.get("image", "")

        if not image_data:
            return web.json_response({"error": "No image data provided"}, status=400)

        aws_region = os.environ.get("AWS_REGION", "us-east-1")
        aws_access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
        aws_secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "")

        client_kwargs = {"region_name": aws_region}
        if (
            aws_access_key
            and aws_secret_key
            and not aws_secret_key.startswith("secretref:")
        ):
            client_kwargs["aws_access_key_id"] = aws_access_key
            client_kwargs["aws_secret_access_key"] = aws_secret_key

        rekognition = boto3.client("rekognition", **client_kwargs)

        image_bytes = base64.b64decode(image_data.split(",")[1])

        response = rekognition.detect_faces(
            Image={"Bytes": image_bytes}, Attributes=["ALL"]
        )

        face_details = response.get("FaceDetails", [])

        if not face_details:
            return web.json_response({"emotion": "No face detected", "confidence": 0})

        if len(face_details) > 1:
            return web.json_response(
                {"emotion": "multiple_faces_detected", "confidence": 100}
            )

        emotions = face_details[0].get("Emotions", [])
        if not emotions:
            return web.json_response(
                {"emotion": "No emotion detected", "confidence": 0}
            )

        top_emotion = max(emotions, key=lambda x: x.get("Confidence", 0))

        return web.json_response(
            {
                "emotion": top_emotion.get("Type", "UNKNOWN"),
                "confidence": top_emotion.get("Confidence", 0),
                "allEmotions": [
                    {"type": e["Type"], "confidence": e["Confidence"]} for e in emotions
                ],
            }
        )

    except Exception as e:
        logger.error(f"Face analysis error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def get_config(request):
    """Return current feature configuration to frontend"""
    return web.json_response(
        {
            "enableSentimentAnalysis": os.environ.get(
                "ENABLE_SENTIMENT_ANALYSIS", "false"
            ).lower()
            == "true",
            "enableSurveyMode": os.environ.get("ENABLE_SURVEY_MODE", "false").lower()
            == "true",
        }
    )


async def update_stress_state(request, rtmt: RTMiddleTier):
    """Update the stress state for adaptive communication"""
    try:
        data = await request.json()
        stress_state = data.get("stress_state", "normal")

        valid_states = ["stressed", "relaxed", "normal"]
        if stress_state not in valid_states:
            return web.json_response(
                {"error": f"Invalid stress state. Must be one of: {valid_states}"},
                status=400,
            )

        logger.info(f"[APP] ★ Received stress state update request: {stress_state}")
        rtmt.set_stress_state(stress_state)
        logger.info(f"[APP] ★ Stress state updated to: {stress_state}")

        return web.json_response({"success": True, "stress_state": stress_state})
    except Exception as e:
        logger.error(f"Error updating stress state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def clear_stress_state(request, rtmt: RTMiddleTier):
    """Clear the stress state after survey completion"""
    try:
        rtmt.set_stress_state("normal")

        # Clear biometric history buffers for fresh start on next survey
        rtmt._blink_rate_history.clear()
        rtmt._face_emotion_history.clear()
        rtmt._current_blink_rate_change = 0.0
        rtmt._current_face_emotion = "NEUTRAL"

        logger.info("[APP] ★ Stress state cleared (reset to normal)")
        logger.info("[APP] ★ Biometric history buffers cleared for new session")
        return web.json_response({"success": True, "stress_state": "normal"})
    except Exception as e:
        logger.error(f"Error clearing stress state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def clear_conversation_state(request, rtmt: RTMiddleTier):
    """Reset conversation state when starting a fresh interaction"""
    try:
        rtmt.clear_conversation_state()
        logger.info("[APP] ★ Conversation state cleared (ready for new session)")
        return web.json_response({"success": True, "state": "active"})
    except Exception as e:
        logger.error(f"Error clearing conversation state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def update_biometrics(request, rtmt: RTMiddleTier):
    """Update current biometric data for survey response capture"""
    try:
        data = await request.json()
        sentiment = data.get("sentiment", "neutral")
        blink_rate_change = data.get("blink_rate_change_percent", 0.0)
        face_emotion = data.get("face_emotion", "NEUTRAL")

        rtmt._current_sentiment = sentiment
        rtmt._current_blink_rate_change = blink_rate_change
        rtmt._current_face_emotion = face_emotion

        # Update history buffers for rolling averages
        rtmt._update_biometric_history(blink_rate_change, face_emotion)

        logger.info(
            f"[APP] ★ Biometrics updated: sentiment={sentiment}, blink_change={blink_rate_change}%, emotion={face_emotion}"
        )

        # Log history buffer status for debugging
        logger.info(
            f"[APP] ★ History Debug - blink_history length: {len(rtmt._blink_rate_history)}, "
            f"emotion_history length: {len(rtmt._face_emotion_history)}, "
            f"emotion history: {rtmt._face_emotion_history[-5:] if rtmt._face_emotion_history else 'empty'}"
        )

        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error updating biometrics: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def create_app():
    if not os.environ.get("RUNNING_IN_PRODUCTION"):
        logger.info("Running in development mode, loading from .env file")
        load_dotenv()

    llm_key = os.environ.get("AZURE_OPENAI_API_KEY")

    credential = None
    if not llm_key:
        if tenant_id := os.environ.get("AZURE_TENANT_ID"):
            logger.info(
                "Using AzureDeveloperCliCredential with tenant_id %s", tenant_id
            )
            credential = AzureDeveloperCliCredential(
                tenant_id=tenant_id, process_timeout=60
            )
        else:
            logger.info("Using DefaultAzureCredential")
            credential = DefaultAzureCredential()
    llm_credential = AzureKeyCredential(llm_key) if llm_key else credential

    app = web.Application()

    # Create RTMiddleTier instance first
    rtmt = RTMiddleTier(
        credentials=llm_credential,
        endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
        deployment=os.environ["AZURE_OPENAI_REALTIME_DEPLOYMENT"],
        voice_choice=os.environ.get("AZURE_OPENAI_REALTIME_VOICE_CHOICE") or "alloy",
    )

    # Enable sentiment analysis based on environment variable
    enable_sentiment = (
        os.environ.get("ENABLE_SENTIMENT_ANALYSIS", "false").lower() == "true"
    )
    if enable_sentiment:
        rtmt.enable_sentiment()
        logger.info("Sentiment analysis is enabled")

    # Enable survey mode based on environment variable
    enable_survey = os.environ.get("ENABLE_SURVEY_MODE", "false").lower() == "true"
    if enable_survey:
        rtmt.enable_survey()
        logger.info("Survey mode is enabled")

    # Set system message - burnout specialist when survey mode is enabled
    if enable_survey:
        # Configure meta intent layer with APP.md content
        rtmt.meta_intent_config = {
            "app_overview": "CIQ is a web application designed to support individuals in identifying and understanding personal burnout. The application evaluates burnout levels using established and validated methodologies, currently leveraging the BAT (Burnout Assessment Tool) survey. It provides both detailed technical results and a comprehensive report with actionable insights.\n\nA key feature of CIQ is its interactive, speech-enabled interface, allowing users to engage naturally with minimal reliance on manual inputs. In addition to survey-based evaluation, the application can optionally capture user biometrics through the device camera. This includes facial movements and expressions, which are processed using application logic and machine learning techniques.\n\nBiometric data is used to enhance technical insights but is not included in the comprehensive report. The report itself is generated using a combination of generative AI and a carefully curated, domain-specific knowledge base focused on burnout research.\n\nCIQ is not a medical device or a clinical diagnostic tool. It is intended solely to help users gain awareness of their burnout levels and behavioral patterns.",
            "capabilities": "Speech-enabled survey interaction and evaluation; generation of detailed technical burnout analysis; ability to explain results interactively; creation of comprehensive reports using curated domain knowledge and generative AI; optional capture and analysis of facial biometrics; detection of voice-based emotional signals and adaptive system responses.",
            "limitations": "Generative AI is used selectively and only where necessary. Speech functionality is supported by AI-based models. Final report generation combines generative AI with a curated, domain-specific knowledge base. This application does not provide medical advice and is not a substitute for professional healthcare consultation.",
            "privacy": "This early version of the application does not store biometric data, survey responses, location data, or personally identifiable information in persistent databases. Camera feeds, survey inputs, and derived biometrics are processed temporarily in memory or short-lived files and are not retained.",
            "biometrics_note": "The application can capture and analyze selected biometric indicators, including pupil size and eye blink rate. Additional derived metrics may include head posture, eye openness, and stress indicators inferred from blink patterns.",
            "disclaimer": "This product is designed as a general wellness and performance-reflection tool. It provides cognitive feedback, stress-awareness cues, and behavioral pattern insights. It does not diagnose, treat, prevent, or prescribe for any medical or mental health condition and should not replace professional healthcare advice."
}

        rtmt.system_message = """
            You are a burnout prevention specialist and workplace wellbeing coach. Your role is to have friendly, supportive conversations with users about their work wellbeing. After a few conversational exchanges, proactively propose a short burnout assessment to help them reflect on how they're feeling. Be empathetic, warm, and professional.
        """.strip()
    else:
        # Configure meta intent layer with APP.md content (basic/help mode)
        rtmt.meta_intent_config = {
            "app_overview": "CIQ is a web application designed to support individuals in identifying and understanding personal burnout. The application evaluates burnout levels using established and validated methodologies, currently leveraging the BAT (Burnout Assessment Tool) survey. It provides both detailed technical results and a comprehensive report with actionable insights.\n\nA key feature of CIQ is its interactive, speech-enabled interface, allowing users to engage naturally with minimal reliance on manual inputs. In addition to survey-based evaluation, the application can optionally capture user biometrics through the device camera. This includes facial movements and expressions, which are processed using application logic and machine learning techniques.\n\nBiometric data is used to enhance technical insights but is not included in the comprehensive report. The report itself is generated using a combination of generative AI and a carefully curated, domain-specific knowledge base focused on burnout research.\n\nCIQ is not a medical device or a clinical diagnostic tool. It is intended solely to help users gain awareness of their burnout levels and behavioral patterns.",
            "capabilities": "Speech-enabled survey interaction and evaluation; generation of detailed technical burnout analysis; ability to explain results interactively; creation of comprehensive reports using curated domain knowledge and generative AI; optional capture and analysis of facial biometrics; detection of voice-based emotional signals and adaptive system responses.",
            "limitations": "Generative AI is used selectively and only where necessary. Speech functionality is supported by AI-based models. Final report generation combines generative AI with a curated, domain-specific knowledge base. This application does not provide medical advice and is not a substitute for professional healthcare consultation.",
            "privacy": "This early version of the application does not store biometric data, survey responses, location data, or personally identifiable information in persistent databases. Camera feeds, survey inputs, and derived biometrics are processed temporarily in memory or short-lived files and are not retained.",
            "biometrics_note": "The application can capture and analyze selected biometric indicators, including pupil size and eye blink rate. Additional derived metrics may include head posture, eye openness, and stress indicators inferred from blink patterns.",
            "disclaimer": "This product is designed as a general wellness and performance-reflection tool. It provides cognitive feedback, stress-awareness cues, and behavioral pattern insights. It does not diagnose, treat, prevent, or prescribe for any medical or mental health condition and should not replace professional healthcare advice."
        }

        rtmt.system_message = """
            You are a helpful voice assistant. Provide clear, concise answers to the user's questions.
            Keep responses short since the user is listening to audio.
        """.strip()

    # Store rtmt in app for access by request handlers
    app["rtmt"] = rtmt

    app.router.add_post("/biometrics", lambda request: update_biometrics(request, rtmt))
    app.router.add_post("/analyze-report", analyze_report)
    app.router.add_post("/analyze", lambda request: analyze_face(request, rtmt))
    app.router.add_post("/analyze-stress", analyze_stress)
    app.router.add_get("/config", get_config)
    app.router.add_post("/clear-conversation", lambda request: clear_conversation_state(request, rtmt))

    # RAG tools disabled - kept for future extensibility
    # attach_rag_tools(rtmt,
    #     credentials=search_credential,
    #     search_endpoint=os.environ.get("AZURE_SEARCH_ENDPOINT"),
    #     search_index=os.environ.get("AZURE_SEARCH_INDEX"),
    #     semantic_configuration=os.environ.get("AZURE_SEARCH_SEMANTIC_CONFIGURATION") or None,
    #     identifier_field=os.environ.get("AZURE_SEARCH_IDENTIFIER_FIELD") or "chunk_id",
    #     content_field=os.environ.get("AZURE_SEARCH_CONTENT_FIELD") or "chunk",
    #     embedding_field=os.environ.get("AZURE_SEARCH_EMBEDDING_FIELD") or "text_vector",
    #     title_field=os.environ.get("AZURE_SEARCH_TITLE_FIELD") or "title",
    #     use_vector_query=(os.getenv("AZURE_SEARCH_USE_VECTOR_QUERY", "true") == "true")
    # )

    rtmt.attach_to_app(app, "/realtime")

    current_directory = Path(__file__).parent
    app.add_routes(
        [
            web.get(
                "/", lambda _: web.FileResponse(current_directory / "static/index.html")
            )
        ]
    )
    app.router.add_static("/", path=current_directory / "static", name="static")

    return app


if __name__ == "__main__":
    host = "localhost"
    port = 8765
    web.run_app(create_app(), host=host, port=port)
