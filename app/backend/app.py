import base64
import json
import logging
import os
from pathlib import Path

import aiohttp
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

_APP_VERSION = "v2025-admin-routes"  # bump this string whenever you need to verify deployment
logger.info("=== CIQ backend starting — build %s ===", _APP_VERSION)


async def analyze_report(request):
    """Analyze the detailed burnout report using behavioral analysis engine"""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
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
        if session_id:
            rtmt.set_conversation_state_for_session(session_id, "report_delivered", report_context_full)
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


async def get_version(request):
    """Return build version and REAL registered routes from the live router."""
    live_routes = [str(r) for r in request.app.router.resources()]
    admin_registered = any("admin" in r for r in live_routes)
    return web.json_response({
        "version": _APP_VERSION,
        "admin_routes_registered": admin_registered,
        "all_routes": live_routes,
    })


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
        data = await request.json()
        session_id = data.get("session_id", "")
        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)
        sess = rtmt.get_or_create_session(session_id)
        sess.stress_state = "normal"
        sess.blink_rate_history.clear()
        sess.face_emotion_history.clear()
        sess.current_blink_rate_change = 0.0
        sess.current_face_emotion = "NEUTRAL"
        logger.info("[APP] ★ Stress state and biometric history cleared (session=%s)", session_id)
        return web.json_response({"success": True, "stress_state": "normal"})
    except Exception as e:
        logger.error(f"Error clearing stress state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def clear_conversation_state(request, rtmt: RTMiddleTier):
    """Reset conversation state when starting a fresh interaction"""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)
        rtmt.clear_conversation_state_for_session(session_id)
        logger.info("[APP] ★ Conversation state cleared (session=%s)", session_id)
        return web.json_response({"success": True, "state": "active"})
    except Exception as e:
        logger.error(f"Error clearing conversation state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def update_biometrics(request, rtmt: RTMiddleTier):
    """Update current biometric data for survey response capture"""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        sentiment = data.get("sentiment", "neutral")
        blink_rate_change = data.get("blink_rate_change_percent", 0.0)
        face_emotion = data.get("face_emotion", "NEUTRAL")

        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)

        sess = rtmt.get_or_create_session(session_id)
        sess.current_sentiment = sentiment
        sess.current_blink_rate_change = blink_rate_change
        sess.current_face_emotion = face_emotion
        rtmt._update_biometric_history_for_session(sess, blink_rate_change, face_emotion)

        logger.info(
            f"[APP] ★ Biometrics updated: sentiment={sentiment}, blink_change={blink_rate_change}%, emotion={face_emotion} (session={session_id})"
        )
        logger.info(
            f"[APP] ★ History Debug - blink_history length: {len(sess.blink_rate_history)}, "
            f"emotion_history length: {len(sess.face_emotion_history)}, "
            f"emotion history: {sess.face_emotion_history[-5:] if sess.face_emotion_history else 'empty'}"
        )

        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error updating biometrics: {e}")
        return web.json_response({"error": str(e)}, status=500)


def _mithra_headers() -> dict:
    """Auth header for all Mithra API calls.
    Azure Container Apps: create secret named 'mithra-app-token', then map it to
    env var MITHRA_APP_TOKEN in the container's environment variable configuration.
    os.environ reads env vars (not secrets directly); hyphens in env var names are
    non-standard, so always use MITHRA_APP_TOKEN as the mapped env var name.
    """
    token = os.environ.get("MITHRA_APP_TOKEN", "")
    return {"Authorization": f"Bearer {token}"}


def _mithra_base_url() -> str:
    return os.environ.get("MITHRA_API_BASE_URL", "https://api.dev.mithra.shelterzoom.com")


def _mithra_session() -> aiohttp.ClientSession:
    """ClientSession with SSL verification disabled for the Mithra dev server.
    The dev certificate hostname doesn't match api.dev.mithra.shelterzoom.com, so we
    skip verification. Remove ssl=False once a valid cert is in place.
    """
    connector = aiohttp.TCPConnector(ssl=False)
    return aiohttp.ClientSession(connector=connector)


async def _mithra_response(resp) -> web.Response:
    """Convert a Mithra API response to an aiohttp response.
    Handles both JSON and non-JSON bodies (e.g. HTML error pages from the gateway)
    so a parsing failure never surfaces as a misleading 500.
    """
    raw = await resp.text()
    try:
        import json as _json
        body = _json.loads(raw)
        return web.json_response(body, status=resp.status)
    except Exception:
        # Non-JSON body (HTML error page, plain text, etc.)
        return web.Response(
            text=raw,
            status=resp.status,
            content_type="text/plain",
        )


async def _mithra_exc_response(handler_name: str, exc: Exception) -> web.Response:
    import traceback
    detail = traceback.format_exc()
    logger.error("[%s] %s\n%s", handler_name, exc, detail)
    return web.json_response({"error": str(exc), "detail": detail}, status=500)


async def admin_kb_upload(request):
    """Proxy: POST /admin/kb/upload → Mithra POST /gateway/v2/papers/fromFile"""
    try:
        reader = await request.multipart()
        title = ""
        classification_ids = []
        file_data = None
        file_name = "upload"
        file_content_type = "application/octet-stream"

        async for part in reader:
            if part.name == "title":
                title = await part.read(decode=True)
                title = title.decode("utf-8")
            elif part.name == "classificationIds":
                val = await part.read(decode=True)
                classification_ids.append(val.decode("utf-8"))
            elif part.name == "file":
                file_data = await part.read(decode=False)
                file_name = part.filename or "upload"
                file_content_type = part.headers.get("Content-Type", "application/octet-stream")

        if not title or file_data is None:
            return web.json_response({"error": "title and file are required"}, status=400)

        # Build multipart — file MUST be last (Mithra gateway requirement)
        form = aiohttp.FormData()
        form.add_field("title", title)
        for cid in classification_ids:
            form.add_field("classificationIds", cid)
        form.add_field("file", file_data, filename=file_name, content_type=file_content_type)

        async with _mithra_session() as session:
            async with session.post(
                f"{_mithra_base_url()}/gateway/v2/papers/fromFile",
                data=form,
                headers=_mithra_headers(),
            ) as resp:
                return await _mithra_response(resp)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_upload", e)


async def admin_kb_delete(request):
    """Proxy: DELETE /admin/kb/documents/{paperId} → Mithra DELETE /gateway/v2/papers/{paperId}"""
    try:
        paper_id = request.match_info["paperId"]
        async with _mithra_session() as session:
            async with session.delete(
                f"{_mithra_base_url()}/gateway/v2/papers/{paper_id}",
                headers=_mithra_headers(),
            ) as resp:
                if resp.status == 204:
                    return web.Response(status=204)
                return await _mithra_response(resp)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_delete", e)


async def admin_kb_get_settings(request):
    """Proxy: GET /admin/kb/settings → Mithra GET /gateway/v1/knowledgeBase/settings"""
    try:
        async with _mithra_session() as session:
            async with session.get(
                f"{_mithra_base_url()}/gateway/v1/knowledgeBase/settings",
                headers=_mithra_headers(),
            ) as resp:
                return await _mithra_response(resp)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_get_settings", e)


async def admin_kb_patch_settings(request):
    """Proxy: PATCH /admin/kb/settings → Mithra PATCH /gateway/v1/knowledgeBase/settings"""
    try:
        data = await request.json()
        min_citations = data.get("minCitationsCount", 1)
        async with _mithra_session() as session:
            async with session.patch(
                f"{_mithra_base_url()}/gateway/v1/knowledgeBase/settings",
                json={"minCitationsCount": min_citations},
                headers={**_mithra_headers(), "Content-Type": "application/json"},
            ) as resp:
                return await _mithra_response(resp)
    except Exception as e:
        return await _mithra_exc_response("admin_kb_patch_settings", e)


async def admin_kb_debug(request):
    """Diagnostics: checks token config + outbound connectivity to Mithra.
    Returns a JSON report — never crashes, always explains what is wrong.
    """
    import traceback

    token_raw = os.environ.get("MITHRA_APP_TOKEN", "")
    base_url = _mithra_base_url()

    result = {
        "token_configured": bool(token_raw),
        "token_preview": (token_raw[:8] + "…") if token_raw else "(empty — MITHRA_APP_TOKEN not set)",
        "mithra_base_url": base_url,
        "connectivity": None,
        "connectivity_error": None,
        "settings_status": None,
        "settings_body": None,
        "settings_error": None,
    }

    # 1. Basic connectivity probe (HEAD to base URL)
    try:
        async with _mithra_session() as session:
            async with session.head(base_url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                result["connectivity"] = resp.status
    except Exception:
        result["connectivity_error"] = traceback.format_exc()

    # 2. Try the actual settings endpoint
    try:
        async with _mithra_session() as session:
            async with session.get(
                f"{base_url}/gateway/v1/knowledgeBase/settings",
                headers=_mithra_headers(),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                result["settings_status"] = resp.status
                result["settings_body"] = await resp.text()
    except Exception:
        result["settings_error"] = traceback.format_exc()

    return web.json_response(result)


async def get_session(request, rtmt: RTMiddleTier):
    """Return persisted session state so the frontend can restore UI on reconnect."""
    session_id = request.rel_url.query.get("session_id", "")
    if not session_id:
        return web.json_response({"error": "session_id is required"}, status=400)
    sess = rtmt.get_or_create_session(session_id)
    return web.json_response({
        "session_id": session_id,
        "conversation_state": sess.conversation_state,
        "survey_results": sess.survey_results,
        "stress_state": sess.stress_state,
        "connection_count": sess.connection_count,
        "has_report": sess.report_context is not None,
    })


async def update_stress_state(request, rtmt: RTMiddleTier):
    """Update the stress state for adaptive communication"""
    try:
        data = await request.json()
        session_id = data.get("session_id", "")
        stress_state = data.get("stress_state", "normal")
        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)
        valid_states = ["stressed", "relaxed", "normal"]
        if stress_state not in valid_states:
            return web.json_response({"error": f"Invalid stress state. Must be one of: {valid_states}"}, status=400)
        rtmt.set_stress_state_for_session(session_id, stress_state)
        return web.json_response({"success": True, "stress_state": stress_state})
    except Exception as e:
        logger.error(f"Error updating stress state: {e}")
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
    app.router.add_post("/update-stress", lambda request: update_stress_state(request, rtmt))
    app.router.add_get("/session", lambda request: get_session(request, rtmt))

    # Mithra Knowledge Base admin proxy routes
    app.router.add_post("/admin/kb/upload", admin_kb_upload)
    app.router.add_delete("/admin/kb/documents/{paperId}", admin_kb_delete)
    app.router.add_get("/admin/kb/settings", admin_kb_get_settings)
    app.router.add_patch("/admin/kb/settings", admin_kb_patch_settings)
    app.router.add_get("/admin/kb/debug", admin_kb_debug)
    app.router.add_get("/version", get_version)

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

    # Log every registered route so we can verify deployment in container log stream
    logger.info("=== REGISTERED ROUTES ===")
    for resource in app.router.resources():
        logger.info("  %s", resource)
    logger.info("=========================")

    return app


if __name__ == "__main__":
    host = "localhost"
    port = 8765
    web.run_app(create_app(), host=host, port=port)
