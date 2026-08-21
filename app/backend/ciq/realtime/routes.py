"""Control-plane REST endpoints for the realtime middle tier.

These configure or read per-session state on the running ``RTMiddleTier`` (stress,
conversation state, biometrics, survey type, guardrail). Each fetches the shared
instance from ``request.app["rtmt"]``.
"""
import logging

from aiohttp import web

logger = logging.getLogger("voicerag")


async def set_survey_type(request):
    """POST /survey-type — bind ONE session to a survey type (blocked when overridden by ENV).

    Per-session, not global: this only affects the given session_id's SessionState
    (see RTMiddleTier.set_survey_type_for_session), so concurrent sessions/tabs
    running different survey types never race or bleed into each other.
    """
    rtmt = request.app.get("rtmt")
    if not rtmt:
        return web.json_response({"error": "Service not available"}, status=503)
    if rtmt.survey_type_overridden:
        return web.json_response({"error": "Survey type is locked by environment configuration"}, status=403)
    data = await request.json()
    session_id = data.get("session_id", "")
    if not session_id:
        return web.json_response({"error": "session_id is required"}, status=400)
    survey_type = data.get("surveyType", "READINESS").upper()
    resolved_type = rtmt.set_survey_type_for_session(session_id, survey_type)
    return web.json_response({"activeSurveyType": resolved_type, "sessionId": session_id})


async def set_biometric_guardrail(request):
    """POST /admin/biometric-guardrail — toggle the descriptive-only biometric guardrail.

    POC NOTE: gated only by auth_middleware (any logged-in user), NOT by an admin role.
    Takes effect on the next conversation turn / new session.
    """
    rtmt = request.app.get("rtmt")
    if not rtmt:
        return web.json_response({"error": "Service not available"}, status=503)
    data = await request.json()
    enabled = bool(data.get("enabled", True))
    rtmt.set_biometric_guardrail(enabled)
    return web.json_response({"biometricGuardrailEnabled": rtmt.biometric_guardrail_enabled})


async def update_stress_state(request):
    """POST /update-stress — update the stress state for adaptive communication."""
    try:
        rtmt = request.app.get("rtmt")
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


async def clear_stress_state(request):
    """POST /clear-stress — clear the stress state after survey completion."""
    try:
        rtmt = request.app.get("rtmt")
        data = await request.json()
        session_id = data.get("session_id", "")
        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)
        sess = rtmt.get_or_create_session(session_id)
        sess.stress_state = "normal"
        sess.blink_rate_history.clear()
        sess.face_emotion_history.clear()
        sess.current_blink_rate_change = 0.0
        sess.current_blink_rate_bpm = 0.0
        sess.current_face_emotion = "NEUTRAL"
        sess.current_left_gaze_position = "Center"
        sess.current_right_gaze_position = "Center"
        logger.info("[APP] ★ Stress state and biometric history cleared (session=%s)", session_id)
        return web.json_response({"success": True, "stress_state": "normal"})
    except Exception as e:
        logger.error(f"Error clearing stress state: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def clear_conversation_state(request):
    """POST /clear-conversation — reset conversation state when starting a fresh interaction."""
    try:
        rtmt = request.app.get("rtmt")
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


async def set_survey_phase(request):
    """POST /survey-phase — open the warm-up → survey gate for a session.

    Called by the frontend the moment the 30s biometric baseline finishes recording, so
    the agent stops making small talk, delivers its bridge line and begins the questions.
    The frontend follows this with a session.update so the new instructions take effect.
    """
    try:
        rtmt = request.app.get("rtmt")
        if not rtmt:
            return web.json_response({"error": "Service not available"}, status=503)
        data = await request.json()
        session_id = data.get("session_id", "")
        phase = data.get("phase", "survey")
        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)
        if phase != "survey":
            return web.json_response({"error": "Only phase 'survey' may be set"}, status=400)
        rtmt.unlock_survey_for_session(session_id)
        return web.json_response({"success": True, "survey_phase": "survey"})
    except Exception as e:
        logger.error(f"Error setting survey phase: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def update_biometrics(request):
    """POST /biometrics — update current biometric data for survey response capture."""
    try:
        rtmt = request.app.get("rtmt")
        data = await request.json()
        session_id = data.get("session_id", "")
        sentiment = data.get("sentiment", "neutral")
        blink_rate_change = data.get("blink_rate_change_percent", 0.0)
        blink_rate_bpm = data.get("blink_rate_bpm", 0.0)
        face_emotion = data.get("face_emotion", "NEUTRAL")
        left_gaze_position = data.get("left_gaze_position", "Center")
        right_gaze_position = data.get("right_gaze_position", "Center")
        pupil_mm_change = data.get("pupil_mm_change", 0.0)

        if not session_id:
            return web.json_response({"error": "session_id is required"}, status=400)

        sess = rtmt.get_or_create_session(session_id)
        sess.current_sentiment = sentiment
        sess.current_blink_rate_change = blink_rate_change
        sess.current_blink_rate_bpm = blink_rate_bpm
        sess.current_face_emotion = face_emotion
        sess.current_left_gaze_position = left_gaze_position
        sess.current_right_gaze_position = right_gaze_position
        sess.current_pupil_mm_change = pupil_mm_change
        sess.update_biometric_history(blink_rate_change, face_emotion)

        logger.info(
            f"[APP] ★ Biometrics updated: sentiment={sentiment}, blink_change={blink_rate_change}%, "
            f"emotion={face_emotion}, gaze_left={left_gaze_position}, gaze_right={right_gaze_position} (session={session_id})"
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


async def get_session(request):
    """GET /session — return persisted session state so the frontend can restore UI on reconnect."""
    rtmt = request.app.get("rtmt")
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
