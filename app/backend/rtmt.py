import asyncio
import contextvars
import json
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import aiohttp
from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
)
logger = logging.getLogger("voicerag")
logger.setLevel(logging.INFO)

_SESSION_TTL_SECONDS = 4 * 3600  # sessions expire after 4 hours of inactivity

@dataclass
class SessionState:
    """All mutable state that belongs to a single user session."""
    session_id: str
    created_at: float = field(default_factory=time.time)
    last_active_at: float = field(default_factory=time.time)
    connection_count: int = 0  # incremented on every WS reconnect

    survey_results: dict = field(default_factory=dict)
    stress_state: str = "normal"
    current_sentiment: str = "neutral"
    current_blink_rate_change: float = 0.0
    current_face_emotion: str = "NEUTRAL"
    current_gaze_position: str = "Center"
    current_pupil_mm_change: float = 0.0
    blink_rate_history: list = field(default_factory=list)
    face_emotion_history: list = field(default_factory=list)

    conversation_state: str = "active"  # "active" | "report_delivered" | "qa_mode"
    report_context: str | None = None
    last_agent_response_type: str | None = None

    # Voice response latency: time between the agent finishing a turn (e.g. asking
    # a survey question) and the user starting to speak their answer.
    last_agent_turn_end_at: float | None = None
    current_response_latency_ms: float | None = None


# Per-coroutine context variable: set in _websocket_handler before any async work starts.
# asyncio.gather copies the current Context to each task it spawns, so both
# from_client_to_server and from_server_to_client tasks inherit this value automatically.
_active_session: contextvars.ContextVar["SessionState | None"] = contextvars.ContextVar(
    "active_session", default=None
)

_tool_sentiment_schema = {
    "type": "function",
    "name": "report_sentiment",
    "description": "Report the sentiment analysis result from the user's voice input. Use this tool to record the sentiment after analyzing the user's message. The sentiment should be either 'positive', 'neutral', or 'negative', along with a brief reason.",
    "parameters": {
        "type": "object",
        "properties": {
            "sentiment": {
                "type": "string",
                "enum": ["positive", "neutral", "negative"],
                "description": "The sentiment of the user's input",
            },
            "reason": {
                "type": "string",
                "description": "Brief explanation of why this sentiment was detected",
            },
        },
        "required": ["sentiment", "reason"],
        "additionalProperties": False,
    },
}

_tool_survey_schema = {
    "type": "function",
    "name": "record_survey_response",
    "description": "Record the user's response to a burnout assessment question. Use Likert scale 1-5 where 1=Never, 2=Rarely, 3=Sometimes, 4=Often, 5=Always.",
    "parameters": {
        "type": "object",
        "properties": {
            "question_id": {
                "type": "string",
                "description": "The question identifier (e.g., q1, q2, q3, q4, q5)",
            },
            "score": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5,
                "description": "Likert score: 1=Never, 2=Rarely, 3=Sometimes, 4=Often, 5=Always",
            },
            "user_verbal_response": {
                "type": "string",
                "description": "The user's natural language response",
            },
            "voice_sentiment": {
                "type": "string",
                "enum": ["positive", "neutral", "negative"],
                "description": "Sentiment detected from user's voice",
            },
            "blink_rate_change_percent": {
                "type": "number",
                "description": "Percentage change in blink rate from baseline during this answer",
            },
            "face_emotion": {
                "type": "string",
                "description": "Dominant emotion detected from face (e.g., HAPPY, SAD, ANGRY, NEUTRAL)",
            },
        },
        "required": ["question_id", "score"],
        "additionalProperties": False,
    },
}

_tool_query_survey_schema = {
    "type": "function",
    "name": "query_survey_results",
    "description": "Query the survey results to answer user questions about their burnout assessment. Use this to provide insights about burnout score, contributing domains, stress indicators, specific question responses, and biometric readings (blink-rate change, gaze position). The 'summary' query type returns the biometric readings.",
    "parameters": {
        "type": "object",
        "properties": {
            "query_type": {
                "type": "string",
                "enum": ["burnout_score", "contributing_domains", "stress_questions", "domain_scores", "summary"],
                "description": "Type of query to perform on survey results",
            },
            "domain": {
                "type": "string",
                "description": "Specific domain to query (optional, for domain-specific questions)",
            },
        },
        "required": ["query_type"],
        "additionalProperties": False,
    },
}


class ToolResultDirection(Enum):
    TO_SERVER = 1
    TO_CLIENT = 2


class ToolResult:
    text: str
    destination: ToolResultDirection

    def __init__(self, text: str, destination: ToolResultDirection):
        self.text = text
        self.destination = destination

    def to_text(self) -> str:
        if self.text is None:
            return ""
        return self.text if isinstance(self.text, str) else json.dumps(self.text)


def _blink_band(change_pct) -> str:
    """Blink-rate change (% vs baseline) → category (CIQ Signal-Thresholds bands)."""
    if change_pct is None:
        return "Unknown"
    mag = abs(change_pct)
    if mag <= 15:
        return "Normal"
    level = "Elevated" if mag <= 40 else "High"
    direction = "above baseline" if change_pct > 0 else "below baseline"
    return f"{level} ({direction})"


def _pupil_band(mm_change) -> str:
    """Pupil-dilation change (mm vs baseline) → category (CIQ Signal-Thresholds bands)."""
    if mm_change is None:
        return "Unknown"
    if mm_change <= 0.1:
        return "Low"
    if mm_change <= 0.3:
        return "Medium"
    return "High"


async def _query_survey_tool(self: "RTMiddleTier", args: Any) -> ToolResult:
    """Tool to query survey results and provide insights.

    Must be async: the tool dispatcher awaits every tool target. A plain `def`
    here returns a ToolResult that `await` cannot handle, raising TypeError and
    silently dropping the function output (agent stalls on "gathering data…").
    """
    query_type = args.get("query_type", "summary")
    domain = args.get("domain")

    results = self._sess.survey_results
    if not results:
        # TO_SERVER so the agent actually sees this message and can tell the user.
        return ToolResult(
            json.dumps({"error": "No survey results available. Complete the survey first."}),
            ToolResultDirection.TO_SERVER,
        )
    from survey_loader import effective_score
    cfg = self._survey_config

    def _eff(qid, raw):
        return effective_score(cfg, qid, raw)

    thresholds = cfg.get("thresholds", {"low_max": 12, "moderate_max": 22})
    interp_map = cfg.get("interpretation", {})

    def _risk(total):
        if total <= thresholds.get("low_max", 12):
            return "low", interp_map.get("low", "Low burnout risk")
        if total <= thresholds.get("moderate_max", 22):
            return "moderate", interp_map.get("moderate", "Moderate burnout risk")
        return "high", interp_map.get("high", "High burnout risk")

    # All totals are reverse-aware: positive items (reverse=true) are flipped so the
    # score reflects burnout direction.
    total_score = sum(_eff(qid, r["score"]) for qid, r in results.items())
    num_questions = len(results)

    response_data = {"query_type": query_type, "has_data": True}

    if query_type == "burnout_score":
        level, interpretation = _risk(total_score)
        response_data["total_score"] = total_score
        response_data["max_score"] = num_questions * 5
        response_data["risk_level"] = level
        response_data["interpretation"] = interpretation

    elif query_type == "contributing_domains":
        domain_scores = {}
        for qid, result in results.items():
            dom = _get_question_domain(qid, self._survey_config)
            domain_scores[dom] = domain_scores.get(dom, 0) + _eff(qid, result["score"])
        response_data["domains"] = domain_scores
        if domain_scores:
            highest = max(domain_scores, key=domain_scores.get)
            response_data["highest_contributor"] = highest
            response_data["highest_score"] = domain_scores[highest]

    elif query_type == "stress_questions":
        # High-burnout questions = burnout-direction (effective) score of 4–5.
        high_stress = [
            {"question_id": qid, "score": _eff(qid, r["score"]), "domain": _get_question_domain(qid, self._survey_config)}
            for qid, r in results.items()
            if _eff(qid, r["score"]) >= 4
        ]
        response_data["high_stress_questions"] = high_stress
        response_data["count"] = len(high_stress)

    elif query_type == "domain_scores":
        if domain:
            domain_total = sum(
                _eff(qid, r["score"]) for qid, r in results.items()
                if _get_question_domain(qid, self._survey_config) == domain
            )
            response_data["domain"] = domain
            response_data["domain_score"] = domain_total
        else:
            domain_scores = {}
            for qid, result in results.items():
                dom = _get_question_domain(qid, self._survey_config)
                domain_scores[dom] = domain_scores.get(dom, 0) + _eff(qid, result["score"])
            response_data["domain_scores"] = domain_scores

    elif query_type == "summary":
        level, interpretation = _risk(total_score)
        response_data["summary"] = {
            "total_score": total_score,
            "questions_answered": num_questions,
            "average_score": total_score / num_questions if num_questions else 0,
            "risk_level": level,
            "interpretation": interpretation,
        }

        # Biometric readings as CATEGORIES so the agent can state them when asked.
        # State only — no clinical interpretation or link to burnout.
        blink_changes = [r.get("blink_rate_change_percent") or 0 for r in results.values()]
        avg_blink = sum(blink_changes) / len(blink_changes) if blink_changes else 0
        pupil_changes = [r.get("pupil_mm_change") or 0 for r in results.values()]
        avg_pupil = sum(pupil_changes) / len(pupil_changes) if pupil_changes else 0
        gaze_counts: dict = {}
        for r in results.values():
            g = r.get("gaze_position") or "Center"
            gaze_counts[g] = gaze_counts.get(g, 0) + 1
        dominant_gaze = max(gaze_counts, key=gaze_counts.get) if gaze_counts else "Center"
        response_data["biometrics"] = {
            "overall_blink_rate_category": _blink_band(avg_blink),
            "overall_pupil_dilation_category": _pupil_band(avg_pupil),
            "dominant_gaze_position": dominant_gaze,
            "per_question": [
                {
                    "question_id": qid,
                    "domain": _get_question_domain(qid, self._survey_config),
                    "voice_sentiment": r.get("voice_sentiment"),
                    "blink_rate_category": _blink_band(r.get("blink_rate_change_percent")),
                    "pupil_dilation_category": _pupil_band(r.get("pupil_mm_change")),
                    "gaze_position": r.get("gaze_position"),
                }
                for qid, r in results.items()
            ],
        }

    # CRITICAL: must be TO_SERVER so the agent receives the data and can answer
    # the user's question. TO_CLIENT would only send to the frontend and the
    # agent would get an empty function output, leading to "I'm working on it"
    # placeholder replies for every follow-up question after a report is delivered.
    return ToolResult(
        json.dumps(response_data),
        ToolResultDirection.TO_SERVER,
    )


async def _sentiment_tool(self: "RTMiddleTier", args: Any) -> ToolResult:
    sentiment = args.get("sentiment", "neutral")
    reason = args.get("reason", "")
    return ToolResult(
        json.dumps({"sentiment": sentiment, "reason": reason}),
        ToolResultDirection.TO_CLIENT,
    )


async def _survey_tool(self: "RTMiddleTier", args: Any) -> ToolResult:
    question_id = args.get("question_id")
    score = args.get("score")
    user_response = args.get("user_verbal_response", "")
    sess = self._sess

    # Idempotency guard: reject duplicate recordings for the same question so a
    # misfired tool call (e.g. called when asking rather than after answering)
    # cannot pollute the report or confuse the frontend progress counter.
    if question_id in sess.survey_results:
        logger.warning("[RTMT] Duplicate record_survey_response for %s — ignoring", question_id)
        return ToolResult(
            json.dumps({"question_id": question_id, "duplicate": True, "recorded": False,
                        "message": "Already recorded — do not call again for this question."}),
            ToolResultDirection.TO_CLIENT,
        )

    voice_sentiment = args.get("voice_sentiment") or sess.current_sentiment

    # Use aggregated values from history for accurate per-question biometrics
    provided_blink = args.get("blink_rate_change_percent")
    blink_rate_change_percent = (
        provided_blink
        if provided_blink is not None
        else self._get_average_blink_rate_change()
    )

    gaze_position = sess.current_gaze_position
    pupil_mm_change = sess.current_pupil_mm_change

    # Voice response latency captured between the agent finishing the question
    # and the user starting to speak (set in the input_audio_buffer.speech_started handler).
    response_latency_ms = sess.current_response_latency_ms
    sess.current_response_latency_ms = None

    logger.info(
        f"[RTMT] ★ Survey Tool Debug - question_id={question_id}, "
        f"provided_blink={provided_blink}, calculated_blink={blink_rate_change_percent}%, "
        f"gaze_position={gaze_position}"
    )
    logger.info(f"[RTMT] ★ Blink History: {sess.blink_rate_history[-10:]}")

    sess.survey_results[question_id] = {
        "score": score,
        "user_response": user_response,
        "voice_sentiment": voice_sentiment,
        "blink_rate_change_percent": blink_rate_change_percent,
        "pupil_mm_change": pupil_mm_change,
        "gaze_position": gaze_position,
        "response_latency_ms": response_latency_ms,
    }

    domain = _get_question_domain(question_id, self._survey_config)
    total_score = sum(r["score"] for r in sess.survey_results.values())
    completed = len(sess.survey_results)
    total = len(self._survey_config.get("questions", []))

    logger.info(
        f"Survey response recorded: {question_id} = {score}, sentiment={voice_sentiment}, blink_change={blink_rate_change_percent}%, gaze={gaze_position}"
    )

    client_message = {
        "type": "survey.biometric.update",
        "snapshot": {
            "questionId": question_id,
            "domain": domain,
            "score": score,
            "voiceSentiment": voice_sentiment,
            "blinkRateChange": blink_rate_change_percent,
            "pupilMmChange": pupil_mm_change,
            "gazePosition": gaze_position,
            "responseLatencyMs": response_latency_ms,
        },
        "totalScore": total_score,
        "completed": completed,
        "total": total,
    }

    return ToolResult(
        json.dumps(
            {
                "question_id": question_id,
                "score": score,
                "recorded": True,
                "client_message": client_message,
            }
        ),
        ToolResultDirection.TO_CLIENT,
    )


def _get_question_domain(question_id: str, survey_config: dict | None = None) -> str:
    """Get the domain name for a question ID from the survey config."""
    if survey_config:
        for q in survey_config.get("questions", []):
            if q["id"] == question_id:
                return q.get("domain", q.get("text", "Unknown"))
    return "Unknown"


class Tool:
    target: Callable[..., ToolResult]
    schema: Any

    def __init__(self, target: Any, schema: Any):
        self.target = target
        self.schema = schema


class RTToolCall:
    tool_call_id: str
    previous_id: str

    def __init__(self, tool_call_id: str, previous_id: str):
        self.tool_call_id = tool_call_id
        self.previous_id = previous_id


class RTMiddleTier:
    endpoint: str
    deployment: str
    key: str | None = None

    # Tools are server-side only for now, though the case could be made for client-side tools
    # in addition to server-side tools that are invisible to the client
    tools: dict[str, Tool] = {}

    # Server-enforced configuration, if set, these will override the client's configuration
    # Typically at least the model name and system message will be set by the server
    model: str | None = None
    system_message: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    disable_audio: bool | None = None
    voice_choice: str | None = None
    enable_sentiment_analysis: bool = False
    enable_survey_mode: bool = False
    # Meta intent layer - provides LLM with app context, users, and limitations
    enable_meta_intent: bool = True
    meta_intent_config: dict | None = None
    api_version: str = "2024-10-01-preview"
    _token_provider = None
    # Shared survey config (same for all sessions)
    _survey_config: dict = {}
    active_survey_type: str = "TEST"
    survey_type_overridden: bool = False
    _MAX_HISTORY_SIZE = 50

    def __init__(
        self,
        endpoint: str,
        deployment: str,
        credentials: AzureKeyCredential | DefaultAzureCredential,
        voice_choice: str | None = None,
    ):
        self.endpoint = endpoint
        self.deployment = deployment
        self.voice_choice = voice_choice
        # Per-session state store
        self._sessions: dict[str, SessionState] = {}
        # Per-connection tool call tracking (initialized fresh in _forward_messages)
        self._tools_pending: dict = {}
        if voice_choice is not None:
            logger.info("Realtime voice choice set to %s", voice_choice)
        if isinstance(credentials, AzureKeyCredential):
            self.key = credentials.key
        else:
            self._token_provider = get_bearer_token_provider(
                credentials, "https://cognitiveservices.azure.com/.default"
            )
            self._token_provider()  # Warm up during startup so we have a token cached when the first request arrives

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    @property
    def _sess(self) -> SessionState:
        """Return the SessionState for the current async context."""
        sess = _active_session.get()
        if sess is None:
            raise RuntimeError("No active session in context — was session_id set?")
        return sess

    def _get_or_create_session(self, session_id: str) -> SessionState:
        self._evict_expired_sessions()
        if session_id not in self._sessions:
            self._sessions[session_id] = SessionState(session_id=session_id)
            logger.info("[RTMT] New session created: %s", session_id)
        sess = self._sessions[session_id]
        sess.last_active_at = time.time()
        return sess

    def get_or_create_session(self, session_id: str) -> SessionState:
        """Public accessor used by REST handlers (outside WebSocket context)."""
        return self._get_or_create_session(session_id)

    def _evict_expired_sessions(self) -> None:
        now = time.time()
        expired = [sid for sid, s in self._sessions.items()
                   if now - s.last_active_at > _SESSION_TTL_SECONDS]
        for sid in expired:
            del self._sessions[sid]
            logger.info("[RTMT] Session expired and evicted: %s", sid)

    def enable_sentiment(self) -> None:
        self.enable_sentiment_analysis = True
        self.tools["report_sentiment"] = Tool(
            schema=_tool_sentiment_schema,
            target=lambda args: _sentiment_tool(self, args),
        )
        logger.info("Sentiment analysis enabled with report_sentiment tool")

    def enable_survey(self, survey_config: dict | None = None) -> None:
        """Enable survey mode for conversational surveys like burnout assessment."""
        self.enable_survey_mode = True
        self.tools["record_survey_response"] = Tool(
            schema=_tool_survey_schema, target=lambda args: _survey_tool(self, args)
        )
        self.tools["query_survey_results"] = Tool(
            schema=_tool_query_survey_schema, target=lambda args: _query_survey_tool(self, args)
        )

        self._survey_config = survey_config or {}
        logger.info("Survey mode enabled with record_survey_response and query_survey_results tools")

    def set_survey_type(self, survey_type: str) -> None:
        from survey_loader import load_survey
        config = load_survey(survey_type)
        self._survey_config = config
        self.active_survey_type = survey_type
        logger.info("[RTMT] Survey type set to %s", survey_type)

    def set_stress_state_for_session(self, session_id: str, state: str) -> None:
        valid_states = ["stressed", "relaxed", "normal"]
        if state not in valid_states:
            logger.warning(f"Invalid stress state: {state}, defaulting to normal")
            state = "normal"
        self.get_or_create_session(session_id).stress_state = state
        logger.info(f"[RTMT] ★ Stress state set to: {state} (session={session_id})")

    def set_conversation_state_for_session(
        self, session_id: str, state: str, report_context: str | None = None
    ) -> None:
        valid_states = ["active", "report_delivered", "qa_mode"]
        if state not in valid_states:
            logger.warning(f"Invalid conversation state: {state}, defaulting to active")
            state = "active"
        sess = self.get_or_create_session(session_id)
        sess.conversation_state = state
        if report_context is not None:
            sess.report_context = report_context
        logger.info(f"[RTMT] ★ Conversation state set to: {state} (session={session_id})")

    def clear_conversation_state_for_session(self, session_id: str) -> None:
        """Fully reset a session so a brand-new survey can run on the same session_id.

        Clears not just the conversation state but also survey_results (otherwise the
        record_survey_response idempotency guard rejects re-scoring q1..q5) and the
        reconnect counter (otherwise the 'this is a reconnect — don't start a survey'
        instructions keep firing). This is what makes retaking a survey deterministic
        without minting a new session_id.
        """
        sess = self.get_or_create_session(session_id)
        sess.conversation_state = "active"
        sess.report_context = None
        sess.last_agent_response_type = None
        sess.survey_results.clear()
        sess.blink_rate_history.clear()
        sess.face_emotion_history.clear()
        sess.current_blink_rate_change = 0.0
        sess.current_face_emotion = "NEUTRAL"
        sess.current_gaze_position = "Center"
        sess.stress_state = "normal"
        sess.connection_count = 0
        logger.info("[RTMT] ★ Session fully reset for new survey (session=%s)", session_id)

    # Keep backward-compatible wrappers that operate on the current WS session
    def set_stress_state(self, state: str) -> None:
        valid_states = ["stressed", "relaxed", "normal"]
        if state not in valid_states:
            state = "normal"
        self._sess.stress_state = state
        logger.info(f"[RTMT] ★ Stress state set to: {state}")

    def set_conversation_state(self, state: str, report_context: str | None = None) -> None:
        valid_states = ["active", "report_delivered", "qa_mode"]
        if state not in valid_states:
            state = "active"
        self._sess.conversation_state = state
        if report_context is not None:
            self._sess.report_context = report_context
        logger.info(f"[RTMT] ★ Conversation state set to: {state}")

    def get_conversation_state(self) -> str:
        return self._sess.conversation_state

    def clear_conversation_state(self) -> None:
        self._sess.conversation_state = "active"
        self._sess.report_context = None
        self._sess.last_agent_response_type = None
        logger.info("[RTMT] ★ Conversation state cleared (reset to active)")

    async def analyze_with_prompt(self, system_prompt: str) -> str:
        """Send system_prompt to Azure OpenAI chat completions and return the text response."""
        import traceback as _tb
        try:
            # ── Step 1: build auth headers ──────────────────────────────────
            api_key = getattr(self, "key", None)
            logger.info("[LLM] analyze_with_prompt: api_key_present=%s", bool(api_key))
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["api-key"] = api_key
            else:
                logger.info("[LLM] No API key — using token provider")
                auth_token = self._token_provider()
                headers["Authorization"] = f"Bearer {auth_token}"

            # ── Step 2: build URL ────────────────────────────────────────────
            # Use a dedicated chat-completions deployment (not the realtime model).
            # Operators set AZURE_OPENAI_CHAT_DEPLOYMENT; default is gpt-4o.
            import os as _os
            chat_deployment = _os.environ.get("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-4o")
            endpoint = self.endpoint.rstrip("/")
            api_url = (
                f"{endpoint}/openai/deployments/{chat_deployment}"
                f"/chat/completions?api-version=2024-02-15-preview"
            )
            logger.info("[LLM] POST %s  (prompt_len=%d)", api_url, len(system_prompt))

            # ── Step 3: serialize payload explicitly ─────────────────────────
            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": "Write the consultative report now."},
                ],
                "max_tokens": 4000,
                "temperature": 0.4,
            }
            try:
                payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                logger.info("[LLM] payload serialized OK (%d bytes)", len(payload_bytes))
            except Exception as ser_err:
                logger.error("[LLM] payload serialization failed: %s\n%s", ser_err, _tb.format_exc())
                return json.dumps({"error": f"Payload serialization failed: {ser_err}"})

            # ── Step 4: call Azure OpenAI ────────────────────────────────────
            async with aiohttp.ClientSession() as session:
                async with session.post(api_url, data=payload_bytes, headers=headers) as response:
                    logger.info("[LLM] response status: %s", response.status)
                    if response.status != 200:
                        error_text = await response.text()
                        logger.error("[LLM] API error %s: %s", response.status, error_text[:400])
                        return json.dumps({"error": f"API error: {response.status} — {error_text[:200]}"})

                    # ── Step 5: parse response ───────────────────────────────
                    try:
                        result = await response.json(content_type=None)
                    except Exception as parse_err:
                        raw = await response.text()
                        logger.error("[LLM] Failed to parse response JSON: %s\nRaw: %s", parse_err, raw[:400])
                        return json.dumps({"error": f"Response parse error: {parse_err}"})

                    content = (
                        result.get("choices", [{}])[0]
                        .get("message", {})
                        .get("content") or ""
                    )
                    logger.info("[LLM] response content length: %d chars", len(content))
                    return content

        except Exception as e:
            logger.error("[LLM] analyze_with_prompt unhandled exception: %s\n%s", e, _tb.format_exc())
            return json.dumps({"error": str(e)})

    def _update_biometric_history(self, blink_change: float, face_emotion: str):
        """Update the rolling history buffers with new biometric readings."""
        sess = self._sess
        sess.blink_rate_history.append(blink_change)
        sess.face_emotion_history.append(face_emotion)
        if len(sess.blink_rate_history) > self._MAX_HISTORY_SIZE:
            sess.blink_rate_history.pop(0)
        if len(sess.face_emotion_history) > self._MAX_HISTORY_SIZE:
            sess.face_emotion_history.pop(0)

    def _update_biometric_history_for_session(
        self, sess: SessionState, blink_change: float, face_emotion: str
    ) -> None:
        """Update biometric history directly on a SessionState (used by REST handlers)."""
        sess.blink_rate_history.append(blink_change)
        sess.face_emotion_history.append(face_emotion)
        if len(sess.blink_rate_history) > self._MAX_HISTORY_SIZE:
            sess.blink_rate_history.pop(0)
        if len(sess.face_emotion_history) > self._MAX_HISTORY_SIZE:
            sess.face_emotion_history.pop(0)

    def clear_biometric_history(self):
        """Clear all biometric history buffers for the current session."""
        sess = self._sess
        sess.blink_rate_history.clear()
        sess.face_emotion_history.clear()
        sess.current_blink_rate_change = 0.0
        sess.current_face_emotion = "NEUTRAL"
        sess.current_gaze_position = "Center"
        logger.info("[RTMT] ★ Biometric history cleared")

    def _get_average_blink_rate_change(self) -> float:
        """Get average blink rate change from history, excluding zero values."""
        history = self._sess.blink_rate_history
        valid_changes = [c for c in history if c != 0]
        if not valid_changes:
            logger.warning("[RTMT] ★ _get_average_blink_rate_change: no valid changes, history: %s", history[-10:])
            return 0.0
        avg = sum(valid_changes) / len(valid_changes)
        logger.info("[RTMT] ★ _get_average_blink_rate_change: %s%% (from %d valid readings)", avg, len(valid_changes))
        return avg

    def _get_dominant_emotion(self) -> str:
        """Get the most frequently detected emotion from history."""
        history = self._sess.face_emotion_history
        if not history:
            logger.warning("[RTMT] ★ _get_dominant_emotion: history is empty, returning NEUTRAL")
            return "NEUTRAL"
        valid_emotions = [
            e for e in history
            if e and e not in ("NEUTRAL", "No face detected", "No emotion detected", "UNKNOWN", "multiple_faces_detected")
        ]
        if not valid_emotions:
            logger.warning("[RTMT] ★ _get_dominant_emotion: no valid emotions in history: %s", history[-10:])
            return history[-1] if history else "NEUTRAL"
        emotion_counts: dict = {}
        for emotion in valid_emotions:
            emotion_counts[emotion] = emotion_counts.get(emotion, 0) + 1
        dominant = max(emotion_counts, key=emotion_counts.get)
        logger.info("[RTMT] ★ _get_dominant_emotion: %s (counts: %s)", dominant, emotion_counts)
        return dominant

    def _detect_and_handle_report_delivery(self, message: dict) -> bool:
        """Detect if the agent's response contains a report delivery and update conversation state.
        Returns True if report delivery was detected."""
        if "response" not in message:
            return False

        sess = self._sess
        # If we already set context via explicit API, don't override
        if sess.conversation_state in ("report_delivered", "qa_mode"):
            return False

        response = message["response"]
        if "output" not in response:
            return False

        # Look for text/audio content that indicates report delivery
        report_keywords = [
            "burnout assessment",
            "assessment results",
            "your score",
            "total score",
            "burnout risk",
            "correlations",
            "contradictions",
            "behavioral analysis",
            "consultative response",
            "comprehensive report",
        ]

        for output in response.get("output", []):
            if output.get("type") == "message":
                for content in output.get("content", []):
                    text = content.get("text", "") or content.get("transcript", "")
                    text_lower = text.lower()
                    for keyword in report_keywords:
                        if keyword in text_lower:
                            # Minimal context for detection-only scenarios
                            summary = text[:300] if len(text) > 300 else text
                            sess.report_context = f"Report delivered: {summary}"
                            sess.conversation_state = "report_delivered"
                            sess.last_agent_response_type = "report_delivery"
                            logger.info("[RTMT] ★ Report delivery detected via keywords, state set to report_delivered")
                            return True

        return False

    def _get_meta_intent_instructions(self) -> str:
        """Generate meta intent instructions from APP.md for LLM context."""
        if not self.enable_meta_intent:
            return ""
        cfg = self.meta_intent_config or {}
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

    def _get_stress_instructions(self) -> str:
        """Generate instructions based on user's stress state."""
        stress = self._sess.stress_state
        logger.info("[RTMT] ★ Generating stress instructions for state: %s", stress)
        if stress == "stressed":
            return """EMOTIONAL ADAPTATION - USER APPEARS STRESSED:
- Speak slowly and gently
- Reassure the user that it's okay to take their time
- Offer short breaks if needed
- Keep explanations simple and not overwhelming
- Be patient and empathetic
- Acknowledge their stress: "I can see this might be a bit overwhelming. Let's take it one step at a time." """
        elif stress == "relaxed":
            return """EMOTIONAL ADAPTATION - USER APPEARS RELAXED:
- Proceed at a normal pace
- Maintain a calm, friendly tone
- The user seems comfortable, so continue normally """
        else:
            return """EMOTIONAL ADAPTATION - USER STATE IS NORMAL:
- Proceed with normal conversation
- Maintain a helpful, friendly tone """

    def _get_conversation_state_instructions(self) -> str:
        """Generate instructions based on current conversation state to maintain continuity."""
        sess = self._sess
        _MAX_CTX = 2500  # chars; keeps combined instructions well inside Azure limits

        if sess.conversation_state == "report_delivered":
            instructions = """CONVERSATION STATE: REPORT JUST DELIVERED
- You have just finished delivering a comprehensive burnout assessment report with analysis.
- The user may have follow-up questions about the results.
- STAY IN THIS MODE until explicitly told otherwise or until a new assessment begins.
- Be prepared to explain:
  * What the correlations/contradictions mean
  * How to interpret the biometric data
  * Actionable recommendations based on the findings
  * Any aspect of the burnout assessment results
- Maintain the consultative, supportive tone from the report delivery.
- DO NOT restart the assessment or ask if they want to take it again unless asked.
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
- Reference the specific data from their survey and biometric analysis.
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

    def _get_reconnect_instructions(self) -> str:
        """Build a context block injected on reconnect so the agent resumes naturally."""
        sess = self._sess
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

        questions = self._survey_config.get("questions", [])
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
                # (Full report context is already injected by _get_conversation_state_instructions)
            )

        parts.append("\n=== END RECONNECT CONTEXT ===")
        return "\n".join(parts)

    def _get_survey_instructions(self) -> str:
        config = self._survey_config
        questions = config.get("questions", [])
        interp = config.get("interpretation", {})

        # Each question on its own line: question text first, then the ID for the tool call on a
        # SEPARATE line so the agent cannot confuse "ask this text" with "call tool now".
        question_blocks = []
        for i, q in enumerate(questions):
            question_blocks.append(
                f'Step {i + 1}/{len(questions)}: Say — "{q["prompt"]}\n'
                f'  Then WAIT for the user to answer. Once they answer, call record_survey_response with question_id="{q["id"]}".'
            )
        questions_script = "\n\n".join(question_blocks)

        return f"""SURVEY SCRIPT — FOLLOW THIS EXACTLY

Your only job is to deliver this {len(questions)}-question check-in, then share the result.

OPENING:
1. Greet the user in one short sentence.
2. Say: "I'd like to run a quick {len(questions)}-question wellbeing check-in. Shall we start?"
3. Wait for confirmation. If yes → go to Step 1. If no → ask once more, then respect refusal.

SURVEY STEPS (do these in order, one at a time):

{questions_script}

STRICT RULES:
- Speak ONLY the question text shown in each step. Do NOT add words, rephrase, or ask follow-up questions.
- Do NOT call record_survey_response when ASKING a question — only call it AFTER the user has ANSWERED.
- Do NOT use any burnout knowledge from your training. Use ONLY the questions listed above.
- If the user goes off-topic, say: "Let's finish the check-in first." and repeat the current step's question.

AFTER ALL {len(questions)} ANSWERS:
- Do NOT calculate the score yourself. Call query_survey_results with query_type="burnout_score".
- Tell the user the "interpretation" text it returns, word for word. Do not show numbers.
- This is the authoritative result — it applies reverse-scoring and the correct thresholds,
  so never override it with your own estimate.

TOOL RULES (silent, never tell the user):
- record_survey_response: call ONLY after the user has answered that step's question.
  Required fields: question_id (as shown per step), score 1–5, voice_sentiment, blink_rate_change_percent, face_emotion.
- DO NOT call record_survey_response for a question_id that you have already recorded.
- query_survey_results: call with "burnout_score" to deliver the final result, and use it
  again for any follow-up questions after the survey is complete."""

    async def _process_message_to_client(
        self,
        msg: str,
        client_ws: web.WebSocketResponse,
        server_ws: web.WebSocketResponse,
    ) -> str | None:
        import re

        message = json.loads(msg.data)
        updated_message = msg.data
        if message is not None:
            match message["type"]:
                case "session.created":
                    session = message["session"]
                    # Hide the instructions, tools and max tokens from clients, if we ever allow client-side
                    # tools, this will need updating
                    session["instructions"] = ""
                    session["tools"] = []
                    session["voice"] = self.voice_choice
                    session["tool_choice"] = "none"
                    session["max_response_output_tokens"] = None
                    updated_message = json.dumps(message)

                case "response.created":
                    # Azure has started generating a new response.
                    # Track this so we never send response.create over an active one.
                    self._response_in_progress = True

                case "input_audio_buffer.speech_started":
                    # User started speaking — if the agent had just finished a turn
                    # (e.g. asking a survey question), this marks the end of the
                    # "voice response latency" window for that turn.
                    sess = self._sess
                    if sess.last_agent_turn_end_at is not None:
                        latency_ms = (time.time() - sess.last_agent_turn_end_at) * 1000
                        sess.current_response_latency_ms = max(0.0, latency_ms)
                        sess.last_agent_turn_end_at = None
                        logger.info(f"[RTMT] Voice response latency: {sess.current_response_latency_ms:.0f}ms")

                case "response.output_item.added":
                    if "item" in message and message["item"]["type"] == "function_call":
                        updated_message = None

                case "conversation.item.created":
                    # Transition to qa_mode if user sends a follow-up message after report
                    sess = self._sess
                    if (sess.conversation_state == "report_delivered" and
                        "item" in message and
                        message.get("item", {}).get("role") == "user"):
                        sess.conversation_state = "qa_mode"
                        logger.info("[RTMT] ★ User follow-up detected, conversation state advanced to 'qa_mode'")

                    # Check for user input audio transcription for sentiment analysis
                    if self.enable_sentiment_analysis and "item" in message:
                        item = message.get("item", {})
                        if item.get("type") == "message" and item.get("role") == "user":
                            for content in item.get("content", []):
                                content_type = content.get("type")
                                if content_type == "audio_transcript":
                                    transcript = content.get("transcript", "")
                                    logger.info(
                                        f"User transcript for sentiment: {transcript[:100]}..."
                                    )
                                    # Look for <SENTIMENT> tags in the user's transcript
                                    sentiment_match = re.search(
                                        r"<SENTIMENT>(.*?)</SENTIMENT>",
                                        transcript,
                                        re.DOTALL,
                                    )
                                    if sentiment_match:
                                        try:
                                            sentiment_data = json.loads(
                                                sentiment_match.group(1)
                                            )
                                            await client_ws.send_json(
                                                {
                                                    "type": "sentiment.update",
                                                    "sentiment": sentiment_data.get(
                                                        "sentiment", "neutral"
                                                    ),
                                                    "reason": sentiment_data.get(
                                                        "reason", ""
                                                    ),
                                                }
                                            )
                                            logger.info(
                                                f"User sentiment detected: {sentiment_data.get('sentiment')} - {sentiment_data.get('reason')}"
                                            )
                                        except json.JSONDecodeError as e:
                                            logger.error(
                                                f"Failed to parse sentiment JSON: {e}"
                                            )
                                elif content_type == "input_audio":
                                    logger.debug(
                                        "User input is audio, checking for transcription..."
                                    )

                    if "item" in message and message["item"]["type"] == "function_call":
                        item = message["item"]
                        if item["call_id"] not in self._tools_pending:
                            self._tools_pending[item["call_id"]] = RTToolCall(
                                item["call_id"], message["previous_item_id"]
                            )
                        updated_message = None
                    elif (
                        "item" in message
                        and message["item"]["type"] == "function_call_output"
                    ):
                        updated_message = None

                case "response.function_call_arguments.delta":
                    updated_message = None

                case "response.function_call_arguments.done":
                    updated_message = None

                case "response.output_item.done":
                    if "item" in message and message["item"]["type"] == "function_call":
                        item = message["item"]
                        tool_call = self._tools_pending[message["item"]["call_id"]]
                        tool = self.tools[item["name"]]
                        args = item["arguments"]
                        result = await tool.target(json.loads(args))
                        await server_ws.send_json(
                            {
                                "type": "conversation.item.create",
                                "item": {
                                    "type": "function_call_output",
                                    "call_id": item["call_id"],
                                    "output": result.to_text()
                                    if result.destination
                                    == ToolResultDirection.TO_SERVER
                                    else "",
                                },
                            }
                        )
                        if result.destination == ToolResultDirection.TO_CLIENT:
                            # TODO: this will break clients that don't know about this extra message, rewrite
                            # this to be a regular text message with a special marker of some sort
                            await client_ws.send_json(
                                {
                                    "type": "extension.middle_tier_tool_response",
                                    "previous_item_id": tool_call.previous_id,
                                    "tool_name": item["name"],
                                    "tool_result": result.to_text(),
                                }
                            )

                            logger.info(
                                f"[RTMT] ★ Tool called: {item['name']} with args: {args}"
                            )
                            logger.info(
                                f"[RTMT] ★ Tool result: {result.to_text()[:200]}"
                            )

                            # Handle sentiment tool response
                            if item["name"] == "report_sentiment":
                                try:
                                    sentiment_result = json.loads(result.to_text())
                                    await client_ws.send_json(
                                        {
                                            "type": "sentiment.update",
                                            "sentiment": sentiment_result.get(
                                                "sentiment", "neutral"
                                            ),
                                            "reason": sentiment_result.get(
                                                "reason", ""
                                            ),
                                        }
                                    )
                                    logger.info(
                                        f"Sentiment from tool: {sentiment_result.get('sentiment')} - {sentiment_result.get('reason')}"
                                    )
                                except json.JSONDecodeError as e:
                                    logger.error(
                                        f"Failed to parse sentiment from tool: {e}"
                                    )

                            # Handle survey tool response
                            if item["name"] == "record_survey_response":
                                try:
                                    survey_result = json.loads(result.to_text())
                                    question_id = survey_result.get("question_id")
                                    score = survey_result.get("score")
                                    sess = self._sess

                                    total_questions = len(self._survey_config.get("questions", []))
                                    completed = len(sess.survey_results)

                                    question_text = next(
                                        (
                                            q.get("prompt", q.get("text", ""))
                                            for q in self._survey_config.get("questions", [])
                                            if q.get("id") == question_id
                                        ),
                                        "",
                                    )
                                    survey_options = self._survey_config.get("options", [])
                                    await client_ws.send_json(
                                        {
                                            "type": "survey.update",
                                            "question_id": question_id,
                                            "question_text": question_text,
                                            "options": survey_options,
                                            "score": score,
                                            "completed": completed,
                                            "total": total_questions,
                                        }
                                    )

                                    survey_result_data = sess.survey_results.get(question_id, {})
                                    voice_sentiment = (
                                        survey_result_data.get("voice_sentiment") or sess.current_sentiment
                                        if survey_result_data else sess.current_sentiment
                                    )
                                    blink_change = (
                                        survey_result_data.get("blink_rate_change_percent")
                                        if survey_result_data and survey_result_data.get("blink_rate_change_percent") is not None
                                        else self._get_average_blink_rate_change()
                                    )
                                    gaze_position = (
                                        survey_result_data.get("gaze_position")
                                        if survey_result_data and survey_result_data.get("gaze_position")
                                        else sess.current_gaze_position
                                    )
                                    pupil_mm_change = (
                                        survey_result_data.get("pupil_mm_change")
                                        if survey_result_data and survey_result_data.get("pupil_mm_change") is not None
                                        else sess.current_pupil_mm_change
                                    )

                                    await client_ws.send_json(
                                        {
                                            "type": "survey.biometric.update",
                                            "snapshot": {
                                                "questionId": question_id,
                                                "domain": _get_question_domain(question_id, self._survey_config),
                                                "score": score,
                                                "voiceSentiment": voice_sentiment,
                                                "blinkRateChange": blink_change,
                                                "pupilMmChange": pupil_mm_change,
                                                "gazePosition": gaze_position,
                                                "responseLatencyMs": survey_result_data.get("response_latency_ms"),
                                            },
                                            "totalScore": sum(r["score"] for r in sess.survey_results.values()),
                                            "completed": completed,
                                            "total": total_questions,
                                        }
                                    )
                                    logger.info(
                                        f"Survey biometric update sent: {question_id}, sentiment={voice_sentiment}, blink_change={blink_change}, gaze={gaze_position}"
                                    )

                                    # Clear biometric history if survey is complete for next round
                                    if completed == total_questions:
                                        self.clear_biometric_history()
                                except json.JSONDecodeError as e:
                                    logger.error(f"Failed to parse survey result: {e}")
                        updated_message = None

                case "response.done":
                    # The active response is finished — clear the flag first so any
                    # guard below can safely decide whether to start a follow-up.
                    self._response_in_progress = False

                    # Mark the end of the agent's turn as the start of the latency
                    # window — the next time the user starts speaking, the elapsed
                    # time is recorded as their voice response latency.
                    self._sess.last_agent_turn_end_at = time.time()
                    if len(self._tools_pending) > 0:
                        self._tools_pending.clear()
                        # Only request the follow-up response if nothing is already running.
                        # Without this guard we hit "conversation_already_has_active_response"
                        # when the spoken summary response fires response.done while the
                        # agent is still producing audio from a parallel output item.
                        if not self._response_in_progress:
                            logger.info("[RTMT] Tool response complete — sending response.create")
                            await server_ws.send_json({"type": "response.create"})
                            self._response_in_progress = True
                    if "response" in message:
                        replace = False
                        for i, output in enumerate(
                            reversed(message["response"]["output"])
                        ):
                            if output["type"] == "function_call":
                                message["response"]["output"].pop(i)
                                replace = True
                        if replace:
                            updated_message = json.dumps(message)

                        # Detect and handle report delivery to maintain conversation continuity
                        self._detect_and_handle_report_delivery(message)

                    # Extract sentiment from response content if sentiment analysis is enabled
                    if self.enable_sentiment_analysis and "response" in message:
                        logger.info(
                            f"Checking for sentiment in response, output count: {len(message['response'].get('output', []))}"
                        )
                        for output in message["response"]["output"]:
                            logger.debug(f"Output type: {output.get('type')}")
                            if output.get("type") == "message" and "content" in output:
                                for content in output["content"]:
                                    logger.info(f"Content type: {content.get('type')}")
                                    # Look for sentiment in the assistant's audio transcript or text response
                                    transcript = None
                                    content_type = content.get("type")
                                    if content_type in (
                                        "audio_transcript",
                                        "text",
                                        "audio",
                                        "output_audio",
                                    ):
                                        transcript = content.get(
                                            "transcript"
                                        ) or content.get("text")

                                    if transcript:
                                        logger.info(
                                            f"Found transcript for sentiment analysis: {transcript[:100]}..."
                                        )
                                        # Look for <SENTIMENT> tags in the transcript
                                        sentiment_match = re.search(
                                            r"<SENTIMENT>(.*?)</SENTIMENT>",
                                            transcript,
                                            re.DOTALL,
                                        )
                                        if sentiment_match:
                                            try:
                                                sentiment_data = json.loads(
                                                    sentiment_match.group(1)
                                                )
                                                await client_ws.send_json(
                                                    {
                                                        "type": "sentiment.update",
                                                        "sentiment": sentiment_data.get(
                                                            "sentiment", "neutral"
                                                        ),
                                                        "reason": sentiment_data.get(
                                                            "reason", ""
                                                        ),
                                                    }
                                                )
                                                logger.info(
                                                    f"Sentiment detected: {sentiment_data.get('sentiment')} - {sentiment_data.get('reason')}"
                                                )

                                                # Strip the SENTIMENT tags from the transcript so AI doesn't speak them
                                                # This ensures the sentiment is only displayed as text in the UI
                                                cleaned_transcript = re.sub(
                                                    r"<SENTIMENT>.*?</SENTIMENT>",
                                                    "",
                                                    transcript,
                                                    flags=re.DOTALL,
                                                ).strip()

                                                # Update ALL possible text fields that may contain the source text for audio generation
                                                transcript_fields = [
                                                    "transcript",
                                                    "text",
                                                    "input_text",
                                                    "content",
                                                    "assistant",
                                                ]
                                                for field in transcript_fields:
                                                    if field in content and isinstance(
                                                        content[field], str
                                                    ):
                                                        if (
                                                            "<SENTIMENT>"
                                                            in content[field]
                                                        ):
                                                            original_text = content[
                                                                field
                                                            ][:200]
                                                            content[field] = re.sub(
                                                                r"<SENTIMENT>.*?</SENTIMENT>",
                                                                "",
                                                                content[field],
                                                                flags=re.DOTALL,
                                                            ).strip()
                                                            logger.info(
                                                                f"DEBUG: Cleaned field '{field}': {original_text} -> {content[field][:200]}"
                                                            )
                                                logger.info(
                                                    f"Cleaned transcript: {cleaned_transcript[:100]}..."
                                                )
                                                updated_message = json.dumps(message)
                                            except json.JSONDecodeError as e:
                                                logger.error(
                                                    f"Failed to parse sentiment JSON: {e}"
                                                )
                                        else:
                                            logger.warning(
                                                f"No <SENTIMENT> tags found in transcript: {transcript[:100]}..."
                                            )

        return updated_message

    async def _process_message_to_server(
        self, msg: str, ws: web.WebSocketResponse
    ) -> str | None:
        message = json.loads(msg.data)
        updated_message = msg.data
        logger.info(
            f"[RTMT] ★ Message received from client: {message.get('type', 'unknown')}"
        )
        if message is not None:
            match message["type"]:
                case "session.update":
                    logger.info("[RTMT] ★★★ Processing session.update!")
                    session = message["session"]
                    try:
                        base_instructions = self.system_message or ""

                        extra_instructions = ""
                        if self.enable_meta_intent:
                            extra_instructions += self._get_meta_intent_instructions()
                        if self.enable_sentiment_analysis:
                            extra_instructions += """ Additionally, you must analyze the sentiment of the user's input.
                        After each user message, determine if the sentiment is "positive", "neutral", or "negative".
                        IMPORTANT: You must call the 'report_sentiment' tool with the sentiment analysis results after each user message.
                        Do NOT speak or mention the sentiment analysis results out loud. The sentiment is for display purposes only."""
                        if self.enable_survey_mode:
                            extra_instructions += "\n\n" + self._get_survey_instructions()

                        state_instructions = self._get_conversation_state_instructions()
                        if state_instructions:
                            extra_instructions += "\n\n" + state_instructions

                        reconnect_instructions = self._get_reconnect_instructions()
                        if reconnect_instructions:
                            extra_instructions += reconnect_instructions

                        extra_instructions += "\n\n" + self._get_stress_instructions()

                        session["instructions"] = base_instructions + extra_instructions

                        try:
                            sess = self._sess
                            logger.info(f"[RTMT] ★ Stress={sess.stress_state} Conv={sess.conversation_state} Reconnect#={sess.connection_count}")
                        except Exception:
                            pass  # context var not set in this path — non-fatal

                        logger.info(f"[RTMT] ★ Instructions length: {len(session['instructions'])} chars")
                    except Exception as e:
                        logger.error("[RTMT] Failed to build session instructions: %s", e, exc_info=True)
                        session["instructions"] = self.system_message or ""

                    if self.temperature is not None:
                        session["temperature"] = self.temperature
                    if self.max_tokens is not None:
                        session["max_response_output_tokens"] = self.max_tokens
                    if self.disable_audio is not None:
                        session["disable_audio"] = self.disable_audio
                    if self.voice_choice is not None:
                        session["voice"] = self.voice_choice
                    session["tool_choice"] = "auto" if len(self.tools) > 0 else "none"
                    session["tools"] = [tool.schema for tool in self.tools.values()]
                    updated_message = json.dumps(message)

        return updated_message

    async def _forward_messages(self, ws: web.WebSocketResponse):
        # Per-connection state: reset on every new WS connection.
        # _response_in_progress prevents sending response.create while Azure is
        # already generating a response (would cause conversation_already_has_active_response).
        self._tools_pending = {}
        self._response_in_progress = False
        async with aiohttp.ClientSession(base_url=self.endpoint) as session:
            params = {"api-version": self.api_version, "deployment": self.deployment}
            headers = {}
            if "x-ms-client-request-id" in ws.headers:
                headers["x-ms-client-request-id"] = ws.headers["x-ms-client-request-id"]
            if self.key is not None:
                headers = {"api-key": self.key}
            else:
                headers = {
                    "Authorization": f"Bearer {self._token_provider()}"
                }  # NOTE: no async version of token provider, maybe refresh token on a timer?
            try:
                async with session.ws_connect(
                    "/openai/realtime", headers=headers, params=params
                ) as target_ws:

                    async def from_client_to_server():
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                try:
                                    new_msg = await self._process_message_to_server(msg, ws)
                                except Exception as e:
                                    logger.error("[RTMT] Error processing client message: %s", e, exc_info=True)
                                    continue  # skip this message, keep connection alive
                                if new_msg is not None:
                                    try:
                                        await target_ws.send_str(new_msg)
                                    except Exception as e:
                                        logger.warning("[RTMT] Azure WS closed mid-forward: %s", e)
                                        return
                            else:
                                logger.debug("Unexpected client message type: %s", msg.type)

                        # Frontend gracefully closed — close Azure too
                        if not target_ws.closed:
                            logger.info("[RTMT] Client disconnected, closing Azure WS")
                            await target_ws.close()

                    async def from_server_to_client():
                        async for msg in target_ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                try:
                                    new_msg = await self._process_message_to_client(
                                        msg, ws, target_ws
                                    )
                                except Exception as e:
                                    logger.error("[RTMT] Error processing server message: %s", e, exc_info=True)
                                    continue
                                if new_msg is not None:
                                    try:
                                        await ws.send_str(new_msg)
                                    except Exception as e:
                                        logger.warning("[RTMT] Frontend WS closed mid-forward: %s", e)
                                        return
                            else:
                                logger.debug("Unexpected Azure message type: %s", msg.type)
                        # Azure closed naturally — log and let _forward_messages return cleanly.
                        # Do NOT call ws.close() here: that would trigger an immediate reconnect
                        # which tries session.update again before the user has a chance to speak.
                        logger.info("[RTMT] Azure WS closed naturally")

                    # Use wait(FIRST_COMPLETED) so when either side closes, we cancel the other
                    # and exit cleanly. asyncio.gather does NOT cancel siblings on completion.
                    client_task = asyncio.ensure_future(from_client_to_server())
                    server_task = asyncio.ensure_future(from_server_to_client())
                    try:
                        done, pending = await asyncio.wait(
                            [client_task, server_task],
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        for t in pending:
                            t.cancel()
                            try:
                                await t
                            except (asyncio.CancelledError, Exception):
                                pass
                        for t in done:
                            if not t.cancelled() and t.exception():
                                exc = t.exception()
                                if not isinstance(exc, ConnectionResetError):
                                    logger.warning("[RTMT] Relay task ended with: %s", exc)
                    except (ConnectionResetError, Exception) as e:
                        if not isinstance(e, ConnectionResetError):
                            logger.warning("[RTMT] Forward-messages error: %s", e)
                        for t in [client_task, server_task]:
                            if not t.done():
                                t.cancel()
            except aiohttp.client.WSServerHandshakeError as e:
                logger.error(
                    "WebSocket handshake failed: %s. This may be due to an invalid or non-realtime deployment. Please verify your AZURE_OPENAI_REALTIME_DEPLOYMENT is correctly configured for the Realtime API.",
                    str(e),
                )
                await ws.close(
                    code=1011,
                    message=b"Realtime API connection failed - check deployment configuration",
                )
            except Exception as e:
                logger.error("Error connecting to realtime endpoint: %s", str(e))
                await ws.close(
                    code=1011, message=b"Failed to connect to realtime endpoint"
                )

    async def _websocket_handler(self, request: web.Request):
        session_id = request.rel_url.query.get("session_id") or str(uuid.uuid4())
        sess = self._get_or_create_session(session_id)
        sess.connection_count += 1
        is_reconnect = sess.connection_count > 1
        if is_reconnect:
            logger.info("[RTMT] Session reconnected: %s (connection #%d)", session_id, sess.connection_count)
        else:
            logger.info("[RTMT] New session connected: %s", session_id)

        # Set context var — inherited by both gather tasks in _forward_messages
        token = _active_session.set(sess)
        try:
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await self._forward_messages(ws)
        finally:
            _active_session.reset(token)
        return ws

    def attach_to_app(self, app, path):
        app.router.add_get(path, self._websocket_handler)
