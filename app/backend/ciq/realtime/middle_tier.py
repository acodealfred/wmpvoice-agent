"""RTMiddleTier — the realtime WebSocket proxy between the browser and Azure OpenAI.

This is the transport core. It opens a WebSocket to Azure OpenAI and relays messages
both ways, intercepting function calls to run server-side tools and rewriting the
``session.update`` to inject the assembled system instructions. Prompt assembly,
session state, tool implementations and the chat-completions path now live in their
own modules; this class composes them.
"""
import asyncio
import json
import logging
import time
import uuid

import aiohttp
from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

from ciq.llm.azure_chat import AzureChatClient
from ciq.prompts.builder import build_session_instructions
from ciq.realtime.session import (
    SessionStore,
    current_session,
    reset_active_session,
    set_active_session,
)
from ciq.realtime.tools.base import RTToolCall, Tool, ToolResultDirection
from ciq.realtime.tools.handlers import query_survey_tool, sentiment_tool, survey_tool
from ciq.realtime.tools.schemas import (
    QUERY_SURVEY_SCHEMA,
    SENTIMENT_SCHEMA,
    SURVEY_SCHEMA,
)
from ciq.survey import get_question_domain

logger = logging.getLogger("voicerag")


class RTMiddleTier:
    endpoint: str
    deployment: str
    key: str | None = None

    # Tools are server-side only for now.
    tools: dict[str, Tool]

    # Server-enforced configuration; these override the client's configuration.
    model: str | None = None
    system_message: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    disable_audio: bool | None = None
    voice_choice: str | None = None
    enable_sentiment_analysis: bool = False
    enable_survey_mode: bool = False
    # Meta intent layer — provides LLM with app context, users, and limitations
    enable_meta_intent: bool = True
    meta_intent_config: dict | None = None
    api_version: str = "2024-10-01-preview"
    _token_provider = None
    # Shared survey config (same for all sessions)
    _survey_config: dict
    active_survey_type: str = "TEST"
    survey_type_overridden: bool = False
    # Descriptive-only biometric guardrail (toggled from the Admin tab).
    biometric_guardrail_enabled: bool = True

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
        self.tools = {}
        self._survey_config = {}
        # Per-session state store
        self._store = SessionStore()
        # Per-connection tool call tracking (initialized fresh in _forward_messages)
        self._tools_pending: dict = {}
        self._response_in_progress = False
        if voice_choice is not None:
            logger.info("Realtime voice choice set to %s", voice_choice)
        if isinstance(credentials, AzureKeyCredential):
            self.key = credentials.key
        else:
            self._token_provider = get_bearer_token_provider(
                credentials, "https://cognitiveservices.azure.com/.default"
            )
            self._token_provider()  # Warm up so we have a token cached for the first request
        # Report-generation LLM path (separate from the realtime proxy).
        self.chat_client = AzureChatClient(self.endpoint, key=self.key, token_provider=self._token_provider)

    # ------------------------------------------------------------------
    # Session management (public accessors used by REST handlers)
    # ------------------------------------------------------------------

    @property
    def _sess(self):
        """Return the SessionState for the current async context."""
        return current_session()

    def get_or_create_session(self, session_id: str):
        return self._store.get_or_create(session_id)

    def set_stress_state_for_session(self, session_id: str, state: str) -> None:
        self._store.get_or_create(session_id).set_stress_state(state)

    def set_conversation_state_for_session(
        self, session_id: str, state: str, report_context: str | None = None
    ) -> None:
        self._store.get_or_create(session_id).set_conversation_state(state, report_context)

    def clear_conversation_state_for_session(self, session_id: str) -> None:
        self._store.get_or_create(session_id).reset_for_new_survey()

    def unlock_survey_for_session(self, session_id: str) -> None:
        """Open the warm-up → survey gate (called when the 30s baseline completes)."""
        self._store.get_or_create(session_id).unlock_survey()

    # ------------------------------------------------------------------
    # Feature wiring
    # ------------------------------------------------------------------

    def enable_sentiment(self) -> None:
        self.enable_sentiment_analysis = True
        self.tools["report_sentiment"] = Tool(
            schema=SENTIMENT_SCHEMA,
            target=lambda args: sentiment_tool(args),
        )
        logger.info("Sentiment analysis enabled with report_sentiment tool")

    def enable_survey(self, survey_config: dict | None = None) -> None:
        """Enable survey mode for conversational surveys like burnout assessment."""
        self.enable_survey_mode = True
        self.tools["record_survey_response"] = Tool(
            schema=SURVEY_SCHEMA,
            target=lambda args: survey_tool(current_session(), self._survey_config, args),
        )
        self.tools["query_survey_results"] = Tool(
            schema=QUERY_SURVEY_SCHEMA,
            target=lambda args: query_survey_tool(current_session(), self._survey_config, args),
        )
        self._survey_config = survey_config or {}
        logger.info("Survey mode enabled with record_survey_response and query_survey_results tools")

    def set_survey_type(self, survey_type: str) -> None:
        from survey_loader import load_survey
        config = load_survey(survey_type)
        self._survey_config = config
        self.active_survey_type = survey_type
        logger.info("[RTMT] Survey type set to %s", survey_type)

    def set_biometric_guardrail(self, enabled: bool) -> None:
        self.biometric_guardrail_enabled = bool(enabled)
        logger.info("[RTMT] Biometric guardrail %s", "ENABLED" if enabled else "DISABLED")

    # ------------------------------------------------------------------
    # Report-generation LLM path (delegated to the chat client)
    # ------------------------------------------------------------------

    async def analyze_with_prompt(self, system_prompt: str) -> str:
        return await self.chat_client.analyze_with_prompt(system_prompt)

    # ------------------------------------------------------------------
    # Conversation-state detection
    # ------------------------------------------------------------------

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
                            summary = text[:300] if len(text) > 300 else text
                            sess.report_context = f"Report delivered: {summary}"
                            sess.conversation_state = "report_delivered"
                            sess.last_agent_response_type = "report_delivery"
                            logger.info("[RTMT] ★ Report delivery detected via keywords, state set to report_delivered")
                            return True

        return False

    # ------------------------------------------------------------------
    # Message relay
    # ------------------------------------------------------------------

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
                    # Hide the instructions, tools and max tokens from clients.
                    session["instructions"] = ""
                    session["tools"] = []
                    session["voice"] = self.voice_choice
                    session["tool_choice"] = "none"
                    session["max_response_output_tokens"] = None
                    updated_message = json.dumps(message)

                case "response.created":
                    # Azure has started generating a new response.
                    self._response_in_progress = True

                case "input_audio_buffer.speech_started":
                    # User started speaking — close the "voice response latency" window.
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
                    sess = self._sess
                    if (sess.conversation_state == "report_delivered" and
                        "item" in message and
                        message.get("item", {}).get("role") == "user"):
                        sess.conversation_state = "qa_mode"
                        logger.info("[RTMT] ★ User follow-up detected, conversation state advanced to 'qa_mode'")

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
                                        else sess.average_blink_rate_change()
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
                                                "domain": get_question_domain(question_id, self._survey_config),
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
                                        sess.clear_biometric_history()
                                except json.JSONDecodeError as e:
                                    logger.error(f"Failed to parse survey result: {e}")
                        updated_message = None

                case "response.done":
                    # The active response is finished — clear the flag first.
                    self._response_in_progress = False

                    # Mark the end of the agent's turn as the start of the latency window.
                    self._sess.last_agent_turn_end_at = time.time()
                    if len(self._tools_pending) > 0:
                        self._tools_pending.clear()
                        # Only request the follow-up response if nothing is already running.
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

                        # Detect and handle report delivery to maintain continuity
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

                                                # Strip the SENTIMENT tags so the AI doesn't speak them
                                                cleaned_transcript = re.sub(
                                                    r"<SENTIMENT>.*?</SENTIMENT>",
                                                    "",
                                                    transcript,
                                                    flags=re.DOTALL,
                                                ).strip()

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
                        sess = self._sess
                        session["instructions"] = build_session_instructions(
                            base_message=self.system_message,
                            sess=sess,
                            survey_config=self._survey_config,
                            enable_meta_intent=self.enable_meta_intent,
                            meta_intent_config=self.meta_intent_config,
                            enable_sentiment=self.enable_sentiment_analysis,
                            enable_survey=self.enable_survey_mode,
                            biometric_guardrail_enabled=self.biometric_guardrail_enabled,
                        )
                        logger.info(f"[RTMT] ★ Stress={sess.stress_state} Conv={sess.conversation_state} Reconnect#={sess.connection_count}")
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
                }
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
                        logger.info("[RTMT] Azure WS closed naturally")

                    # Use wait(FIRST_COMPLETED) so when either side closes, we cancel the other.
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

    async def _resolve_survey_phase(self, sess, request: web.Request) -> None:
        """Decide the starting survey phase for a fresh connection from the stored baseline.

        A valid (non-expired, TTL enforced in db.get_user_baseline) baseline means a
        returning user: skip the 30s recording and start unlocked in the "survey" phase
        with a brief welcome-back warm-up. Otherwise start gated in "warmup" so the agent
        makes small talk while a fresh baseline records. Only called on the first
        connection of a session — reconnects must keep whatever phase was reached.
        """
        auth = request.get("auth_session")
        user_id = auth.get("user_id") if auth else None
        baseline = None
        if user_id:
            try:
                from db import get_user_baseline
                baseline = await get_user_baseline(user_id)
            except Exception as e:
                logger.warning("[RTMT] Baseline lookup failed for phase resolution: %s", e)
        if baseline:
            sess.survey_phase = "survey"
            sess.is_returning_user = True
        else:
            sess.survey_phase = "warmup"
            sess.is_returning_user = False
        logger.info(
            "[RTMT] Survey phase resolved: %s (returning=%s, session=%s)",
            sess.survey_phase, sess.is_returning_user, sess.session_id,
        )

    async def _websocket_handler(self, request: web.Request):
        session_id = request.rel_url.query.get("session_id") or str(uuid.uuid4())
        sess = self._store.get_or_create(session_id)
        sess.connection_count += 1
        is_reconnect = sess.connection_count > 1
        if is_reconnect:
            logger.info("[RTMT] Session reconnected: %s (connection #%d)", session_id, sess.connection_count)
        else:
            logger.info("[RTMT] New session connected: %s", session_id)
            if self.enable_survey_mode:
                await self._resolve_survey_phase(sess, request)

        # Set context var — inherited by both gather tasks in _forward_messages
        token = set_active_session(sess)
        try:
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await self._forward_messages(ws)
        finally:
            reset_active_session(token)
        return ws

    def attach_to_app(self, app, path):
        app.router.add_get(path, self._websocket_handler)
