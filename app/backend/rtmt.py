import asyncio
import json
import logging
from collections.abc import Callable
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
    "description": "Query the survey results to answer user questions about their burnout assessment. Use this to provide insights about burnout score, contributing domains, stress indicators, and specific question responses.",
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


def _query_survey_tool(self: "RTMiddleTier", args: Any) -> ToolResult:
    """Tool to query survey results and provide insights."""
    query_type = args.get("query_type", "summary")
    domain = args.get("domain")

    if not hasattr(self, "_survey_results") or not self._survey_results:
        return ToolResult(
            json.dumps({"error": "No survey results available. Complete the survey first."}),
            ToolResultDirection.TO_CLIENT,
        )

    results = self._survey_results
    total_score = sum(r["score"] for r in results.values())
    num_questions = len(results)

    response_data = {"query_type": query_type, "has_data": True}

    if query_type == "burnout_score":
        response_data["total_score"] = total_score
        response_data["max_score"] = num_questions * 5
        if total_score <= 12:
            level = "low"
            interpretation = "Low burnout risk"
        elif total_score <= 22:
            level = "moderate"
            interpretation = "Moderate burnout risk"
        else:
            level = "high"
            interpretation = "High burnout risk"
        response_data["risk_level"] = level
        response_data["interpretation"] = interpretation

    elif query_type == "contributing_domains":
        domain_scores = {}
        for qid, result in results.items():
            dom = _get_question_domain(qid)
            domain_scores[dom] = domain_scores.get(dom, 0) + result["score"]
        response_data["domains"] = domain_scores
        # Identify highest contributing domain (highest score indicates more burnout in that domain)
        if domain_scores:
            highest = max(domain_scores, key=domain_scores.get)
            response_data["highest_contributor"] = highest
            response_data["highest_score"] = domain_scores[highest]

    elif query_type == "stress_questions":
        # Identify questions where score indicates high stress (4-5)
        high_stress = [
            {"question_id": qid, "score": r["score"], "domain": _get_question_domain(qid)}
            for qid, r in results.items()
            if r["score"] >= 4
        ]
        response_data["high_stress_questions"] = high_stress
        response_data["count"] = len(high_stress)

    elif query_type == "domain_scores":
        if domain:
            domain_total = sum(
                r["score"] for qid, r in results.items()
                if _get_question_domain(qid) == domain
            )
            response_data["domain"] = domain
            response_data["domain_score"] = domain_total
        else:
            domain_scores = {}
            for qid, result in results.items():
                dom = _get_question_domain(qid)
                domain_scores[dom] = domain_scores.get(dom, 0) + result["score"]
            response_data["domain_scores"] = domain_scores

    elif query_type == "summary":
        response_data["summary"] = {
            "total_score": total_score,
            "questions_answered": num_questions,
            "average_score": total_score / num_questions if num_questions else 0,
            "risk_level": (
                "low" if total_score <= 12 else "moderate" if total_score <= 22 else "high"
            ),
        }

    return ToolResult(
        json.dumps(response_data),
        ToolResultDirection.TO_CLIENT,
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
    voice_sentiment = args.get("voice_sentiment") or self._current_sentiment

    # Use aggregated values from history for accurate per-question biometrics
    provided_blink = args.get("blink_rate_change_percent")
    blink_rate_change_percent = (
        provided_blink
        if provided_blink is not None
        else self._get_average_blink_rate_change()
    )

    provided_emotion = args.get("face_emotion")
    face_emotion = (
        provided_emotion if provided_emotion else self._get_dominant_emotion()
    )

    # Debug logging
    logger.info(
        f"[RTMT] ★ Survey Tool Debug - question_id={question_id}, "
        f"provided_blink={provided_blink}, calculated_blink={blink_rate_change_percent}%, "
        f"provided_emotion={provided_emotion}, calculated_emotion={face_emotion}"
    )
    logger.info(
        f"[RTMT] ★ Blink History: {self._blink_rate_history[-10:]}, "
        f"Emotion History: {self._face_emotion_history[-10:]}"
    )

    provided_emotion = args.get("face_emotion")
    face_emotion = (
        provided_emotion if provided_emotion else self._get_dominant_emotion()
    )

    if not hasattr(self, "_survey_results"):
        self._survey_results = {}

    self._survey_results[question_id] = {
        "score": score,
        "user_response": user_response,
        "voice_sentiment": voice_sentiment,
        "blink_rate_change_percent": blink_rate_change_percent,
        "face_emotion": face_emotion,
    }

    domain = _get_question_domain(question_id)
    total_score = sum(r["score"] for r in self._survey_results.values())
    completed = len(self._survey_results)
    total = len(self._survey_config.get("questions", []))

    logger.info(
        f"Survey response recorded: {question_id} = {score}, sentiment={voice_sentiment}, blink_change={blink_rate_change_percent}%, emotion={face_emotion}"
    )

    client_message = {
        "type": "survey.biometric.update",
        "snapshot": {
            "questionId": question_id,
            "domain": domain,
            "score": score,
            "voiceSentiment": voice_sentiment,
            "blinkRateChange": blink_rate_change_percent,
            "faceEmotion": face_emotion,
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


def _get_question_domain(question_id: str) -> str:
    """Get the domain name for a question ID."""
    domain_map = {
        "q1": "Emotional Exhaustion",
        "q2": "Depersonalization",
        "q3": "Personal Accomplishment",
        "q4": "Physical Exhaustion",
        "q5": "Job Satisfaction",
    }
    return domain_map.get(question_id, "Unknown")


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
    _tools_pending = {}
    _token_provider = None
    _survey_results: dict = {}
    _survey_config: dict = {}
    _stress_state: str = "normal"
    _current_sentiment: str = "neutral"
    _current_blink_rate_change: float = 0.0
    _current_face_emotion: str = "NEUTRAL"
    _blink_rate_history: list = []
    _face_emotion_history: list = []
    _MAX_HISTORY_SIZE = 50
    # Conversation state management for post-report Q&A continuity
    _conversation_state: str = "active"  # "active", "report_delivered", "qa_mode"
    _report_context: str | None = None
    _last_agent_response_type: str | None = None

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
        if voice_choice is not None:
            logger.info("Realtime voice choice set to %s", voice_choice)
        if isinstance(credentials, AzureKeyCredential):
            self.key = credentials.key
        else:
            self._token_provider = get_bearer_token_provider(
                credentials, "https://cognitiveservices.azure.com/.default"
            )
            self._token_provider()  # Warm up during startup so we have a token cached when the first request arrives

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

        self._survey_config = survey_config or {
            "name": "Burnout Assessment",
            "options": [
                {"value": 1, "label": "Never"},
                {"value": 2, "label": "Rarely"},
                {"value": 3, "label": "Sometimes"},
                {"value": 4, "label": "Often"},
                {"value": 5, "label": "Always"},
            ],
            "questions": [
                {
                    "id": "q1",
                    "text": "Emotional Exhaustion",
                    "prompt": "How often do you feel emotionally exhausted at the end of a work day?",
                },
                {
                    "id": "q2",
                    "text": "Depersonalization",
                    "prompt": "How often do you feel detached or cynical about your job?",
                },
                {
                    "id": "q3",
                    "text": "Personal Accomplishment",
                    "prompt": "How confident do you feel about your work?",
                },
                {
                    "id": "q4",
                    "text": "Physical Exhaustion",
                    "prompt": "How often do you feel physically tired?",
                },
                {
                    "id": "q5",
                    "text": "Job Satisfaction",
                    "prompt": "How often do you feel positive about your job?",
                },
            ],
            "interpretation": {
                "low": "Low burnout risk - Keep up the great work!",
                "moderate": "Moderate burnout risk - Consider taking regular breaks and self-care.",
                "high": "High burnout risk - Please consider reaching out to HR or a mental health professional.",
            },
        }
        logger.info("Survey mode enabled with record_survey_response and query_survey_results tools")

    def set_stress_state(self, state: str) -> None:
        """Set the user's stress state for adaptive communication."""
        valid_states = ["stressed", "relaxed", "normal"]
        if state not in valid_states:
            logger.warning(f"Invalid stress state: {state}, defaulting to normal")
            state = "normal"
        self._stress_state = state
        logger.info(f"[RTMT] ★ Stress state set to: {state}")

    def set_conversation_state(self, state: str, report_context: str | None = None) -> None:
        """Set the conversation state and optionally store report context for Q&A."""
        valid_states = ["active", "report_delivered", "qa_mode"]
        if state not in valid_states:
            logger.warning(f"Invalid conversation state: {state}, defaulting to active")
            state = "active"
        self._conversation_state = state
        if report_context is not None:
            self._report_context = report_context
        logger.info(f"[RTMT] ★ Conversation state set to: {state}")

    def get_conversation_state(self) -> str:
        """Get current conversation state."""
        return self._conversation_state

    def clear_conversation_state(self) -> None:
        """Reset conversation state to active and clear report context."""
        self._conversation_state = "active"
        self._report_context = None
        self._last_agent_response_type = None
        logger.info("[RTMT] ★ Conversation state cleared (reset to active)")

    async def analyze_with_prompt(self, system_prompt: str) -> str:
        """Analyze report data using chat completions API with provided prompt."""
        try:
            headers = {
                "Content-Type": "application/json",
            }
            if hasattr(self, "key"):
                headers["api-key"] = self.key
            else:
                auth_token = self._token_provider()
                headers["Authorization"] = f"Bearer {auth_token}"

            api_url = f"{self.endpoint}/openai/deployments/{self.deployment}/chat/completions?api-version=2024-02-15-preview"

            payload = {
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": "Please analyze the provided data and return JSON results.",
                    },
                ],
                "max_tokens": 2000,
                "temperature": 0.3,
            }

            async with aiohttp.ClientSession() as session:
                async with session.post(
                    api_url, json=payload, headers=headers
                ) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        logger.error(
                            f"Analysis API error: {response.status} - {error_text}"
                        )
                        return json.dumps({"error": f"API error: {response.status}"})

                    result = await response.json()
                    content = (
                        result.get("choices", [{}])[0]
                        .get("message", {})
                        .get("content", "{}")
                    )
                    return content

        except Exception as e:
            logger.error(f"Analysis error: {e}")
            return json.dumps({"error": str(e)})

    def _update_biometric_history(self, blink_change: float, face_emotion: str):
        """Update the rolling history buffers with new biometric readings."""
        self._blink_rate_history.append(blink_change)
        self._face_emotion_history.append(face_emotion)

        if len(self._blink_rate_history) > self._MAX_HISTORY_SIZE:
            self._blink_rate_history.pop(0)
        if len(self._face_emotion_history) > self._MAX_HISTORY_SIZE:
            self._face_emotion_history.pop(0)

    def clear_biometric_history(self):
        """Clear all biometric history buffers."""
        self._blink_rate_history.clear()
        self._face_emotion_history.clear()
        self._current_blink_rate_change = 0.0
        self._current_face_emotion = "NEUTRAL"
        logger.info("[RTMT] ★ Biometric history cleared")

    def _get_average_blink_rate_change(self) -> float:
        """Get average blink rate change from history, excluding zero values."""
        valid_changes = [c for c in self._blink_rate_history if c != 0]

        if not valid_changes:
            logger.warning(
                f"[RTMT] ★ _get_average_blink_rate_change: no valid changes, history: {self._blink_rate_history[-10:]}"
            )
            return 0.0

        avg = sum(valid_changes) / len(valid_changes)
        logger.info(
            f"[RTMT] ★ _get_average_blink_rate_change: {avg}% (from {len(valid_changes)} valid readings)"
        )
        return avg

    def _get_dominant_emotion(self) -> str:
        """Get the most frequently detected emotion from history."""
        if not self._face_emotion_history:
            logger.warning(
                "[RTMT] ★ _get_dominant_emotion: history is empty, returning NEUTRAL"
            )
            return "NEUTRAL"

        # Filter out invalid emotions
        valid_emotions = [
            e
            for e in self._face_emotion_history
            if e
            and e
            not in (
                "NEUTRAL",
                "No face detected",
                "No emotion detected",
                "UNKNOWN",
                "multiple_faces_detected",
            )
        ]

        if not valid_emotions:
            logger.warning(
                f"[RTMT] ★ _get_dominant_emotion: no valid emotions in history: {self._face_emotion_history[-10:]}"
            )
            # Return the last emotion if available, even if it's NEUTRAL
            return (
                self._face_emotion_history[-1]
                if self._face_emotion_history
                else "NEUTRAL"
            )

        emotion_counts: dict = {}
        for emotion in valid_emotions:
            emotion_counts[emotion] = emotion_counts.get(emotion, 0) + 1

        dominant = max(emotion_counts, key=emotion_counts.get)
        logger.info(
            f"[RTMT] ★ _get_dominant_emotion: {dominant} (counts: {emotion_counts})"
        )
        return dominant

    def _detect_and_handle_report_delivery(self, message: dict) -> bool:
        """Detect if the agent's response contains a report delivery and update conversation state.
        Returns True if report delivery was detected."""
        if "response" not in message:
            return False

        # If we already set context via explicit API, don't override
        if self._conversation_state in ("report_delivered", "qa_mode"):
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
                            self._report_context = f"Report delivered: {summary}"
                            self._conversation_state = "report_delivered"
                            self._last_agent_response_type = "report_delivery"
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
        logger.info(
            f"[RTMT] ★ Generating stress instructions for state: {self._stress_state}"
        )
        if self._stress_state == "stressed":
            return """EMOTIONAL ADAPTATION - USER APPEARS STRESSED:
- Speak slowly and gently
- Reassure the user that it's okay to take their time
- Offer short breaks if needed
- Keep explanations simple and not overwhelming
- Be patient and empathetic
- Acknowledge their stress: "I can see this might be a bit overwhelming. Let's take it one step at a time." """
        elif self._stress_state == "relaxed":
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
        if self._conversation_state == "report_delivered":
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
            if self._report_context:
                instructions += f"\nREPORT CONTEXT (for Q&A):\n{self._report_context}\n"
            return instructions
        elif self._conversation_state == "qa_mode":
            instructions = """CONVERSATION STATE: Q&A MODE
- You are answering user questions about their burnout assessment results.
- Reference the specific data from their survey and biometric analysis.
- Be precise, helpful, and supportive.
- If the question is unrelated to their results, gently steer back to their wellbeing.
- Continue in this mode until the conversation ends or a new assessment starts.
"""
            if self._report_context:
                instructions += f"\nCURRENT REPORT CONTEXT:\n{self._report_context}\n"
            return instructions
        return ""

    def _get_survey_instructions(self) -> str:
        config = self._survey_config
        questions_text = "\n".join(
            [
                f"{i + 1}. {q['text']} ({q['id']}): {q['prompt']}"
                for i, q in enumerate(config.get("questions", []))
            ]
        )
        interp = config.get("interpretation", {})

        return f"""You are a supportive conversational assistant focused on workplace wellbeing and burnout prevention.

CONVERSATION RULES:
- Be friendly and empathetic
- Keep responses brief and conversational
- STAY ON TOPIC: Focus only on work, job satisfaction, stress, wellbeing, and burnout
- If user goes off-topic (e.g., sports, movies, politics), politely redirect: "I'd love to chat about that, but let's focus on your work wellbeing for now. How are you feeling about your job lately?"
- AVOID: Long discussions about unrelated topics, personal life matters outside work, or general small talk not related to workplace wellbeing

SURVEY PROPOSAL:
- After 2-3 conversational exchanges maximum, propose the burnout assessment
- Do NOT wait for the user to bring it up - YOU must suggest it proactively
- Say something like: "I'd love to help you check in with yourself. Would you like to take a short, 5-question burnout assessment? It only takes a couple of minutes."
- If user declines, try once more after 1-2 more turns, then accept their decision gracefully
- If user agrees, proceed to assessment

ASSESSMENT PHASE (when user agrees):
- Ask about each topic in a friendly, conversational way (DO NOT read questions verbatim)

Questions:
{questions_text}

After all 5 responses, calculate total score:
- 5-12: {interp.get("low", "Low burnout risk")}
- 13-22: {interp.get("moderate", "Moderate burnout risk")}
- 23-25: {interp.get("high", "High burnout risk")}

BIOMETRIC DATA:
- The system automatically captures biometric data during the conversation
- When calling record_survey_response, include available biometric data:
  - voice_sentiment: current voice sentiment (positive/neutral/negative)
  - blink_rate_change_percent: current blink rate change from baseline
  - face_emotion: current face emotion (HAPPY, SAD, ANGRY, NEUTRAL, etc.)
- If you don't have access to specific values, the system will use defaults

CRITICAL RULES:
1. Call record_survey_response tool AFTER each user answer with the inferred score (1-5)
2. Include biometric parameters in the tool call when available
3. NEVER mention scores or the tool to the user
4. After all 5 questions, share the interpretation based on total score
5. If user goes off-topic during assessment, gently redirect back to the question
6. End the conversation professionally after the survey is complete

QUERYING SURVEY RESULTS:
- After the survey is complete, you can answer user questions about their results using the query_survey_results tool
- Use this tool to provide insights about their burnout score, contributing domains, and stress indicators
- Always base your answers on the survey data and biometric information collected
- When the user asks about their burnout score, contributing domains, stress questions, or any other aspect of their survey results, you MUST use the query_survey_results tool to get the data before answering.
- Do not make up or guess the results; always rely on the tool output."""

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

                case "response.output_item.added":
                    if "item" in message and message["item"]["type"] == "function_call":
                        updated_message = None

                case "conversation.item.created":
                    # Transition to qa_mode if user sends a follow-up message after report
                    if (self._conversation_state == "report_delivered" and
                        "item" in message and
                        message.get("item", {}).get("role") == "user"):
                        self._conversation_state = "qa_mode"
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

                                    total_questions = len(
                                        self._survey_config.get("questions", [])
                                    )
                                    completed = len(self._survey_results)

                                    question_text = next(
                                        (
                                            q.get("prompt", q.get("text", ""))
                                            for q in self._survey_config.get(
                                                "questions", []
                                            )
                                            if q.get("id") == question_id
                                        ),
                                        "",
                                    )
                                    survey_options = self._survey_config.get(
                                        "options", []
                                    )
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

                                    survey_result_data = self._survey_results.get(
                                        question_id, {}
                                    )
                                    voice_sentiment = (
                                        survey_result_data.get("voice_sentiment")
                                        or self._current_sentiment
                                        if survey_result_data
                                        else self._current_sentiment
                                    )
                                    blink_change = (
                                        survey_result_data.get(
                                            "blink_rate_change_percent"
                                        )
                                        if survey_result_data
                                        and survey_result_data.get(
                                            "blink_rate_change_percent"
                                        )
                                        is not None
                                        else self._get_average_blink_rate_change()
                                    )
                                    face_emotion = (
                                        survey_result_data.get("face_emotion")
                                        if survey_result_data
                                        and survey_result_data.get("face_emotion")
                                        else self._get_dominant_emotion()
                                    )

                                    await client_ws.send_json(
                                        {
                                            "type": "survey.biometric.update",
                                            "snapshot": {
                                                "questionId": question_id,
                                                "domain": _get_question_domain(
                                                    question_id
                                                ),
                                                "score": score,
                                                "voiceSentiment": voice_sentiment,
                                                "blinkRateChange": blink_change,
                                                "faceEmotion": face_emotion,
                                            },
                                            "totalScore": sum(
                                                r["score"]
                                                for r in self._survey_results.values()
                                            ),
                                            "completed": completed,
                                            "total": total_questions,
                                        }
                                    )
                                    logger.info(
                                        f"Survey biometric update sent: {question_id}, sentiment={voice_sentiment}, blink_change={blink_change}, emotion={face_emotion}"
                                    )

                                    # Clear biometric history if survey is complete for next round
                                    if completed == total_questions:
                                        self.clear_biometric_history()
                                except json.JSONDecodeError as e:
                                    logger.error(f"Failed to parse survey result: {e}")
                        updated_message = None

                case "response.done":
                    if len(self._tools_pending) > 0:
                        self._tools_pending.clear()  # Any chance tool calls could be interleaved across different outstanding responses?
                        await server_ws.send_json({"type": "response.create"})
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
                    if self.system_message is not None:
                        base_instructions = self.system_message

                    extra_instructions = ""
                    if self.enable_meta_intent:
                        meta_instructions = self._get_meta_intent_instructions()
                        extra_instructions = meta_instructions
                    # Add sentiment analysis and/or survey instructions if enabled
                    if self.enable_sentiment_analysis:
                        sentiment_instructions = """ Additionally, you must analyze the sentiment of the user's input.
                        After each user message, determine if the sentiment is "positive", "neutral", or "negative".
                        IMPORTANT: You must call the 'report_sentiment' tool with the sentiment analysis results after each user message.
                        Do NOT speak or mention the sentiment analysis results out loud. The sentiment is for display purposes only."""
                        extra_instructions += sentiment_instructions
                    if self.enable_survey_mode:
                        survey_instructions = "\n\n" + self._get_survey_instructions()
                        extra_instructions += survey_instructions

                    # Add conversation state instructions to preserve continuity
                    state_instructions = self._get_conversation_state_instructions()
                    if state_instructions:
                        extra_instructions += "\n\n" + state_instructions

                    stress_instructions = "\n\n" + self._get_stress_instructions()
                    extra_instructions += stress_instructions

                    session["instructions"] = base_instructions + extra_instructions

                    logger.info(f"[RTMT] ★ Stress state: {self._stress_state}")
                    logger.info(f"[RTMT] ★ Conversation state: {self._conversation_state}")
                    logger.info(
                        f"[RTMT] ★ Generating stress instructions for state: {self._stress_state}"
                    )
                    logger.info(
                        f"[RTMT] ★ Sending instructions to LLM: {session['instructions'][:500]}..."
                    )

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
                                new_msg = await self._process_message_to_server(msg, ws)
                                if new_msg is not None:
                                    await target_ws.send_str(new_msg)
                            else:
                                print("Error: unexpected message type:", msg.type)

                        # Means it is gracefully closed by the client then time to close the target_ws
                        if target_ws:
                            print("Closing OpenAI's realtime socket connection.")
                            await target_ws.close()

                    async def from_server_to_client():
                        async for msg in target_ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                new_msg = await self._process_message_to_client(
                                    msg, ws, target_ws
                                )
                                if new_msg is not None:
                                    await ws.send_str(new_msg)
                            else:
                                print("Error: unexpected message type:", msg.type)

                    try:
                        await asyncio.gather(
                            from_client_to_server(), from_server_to_client()
                        )
                    except ConnectionResetError:
                        # Ignore the errors resulting from the client disconnecting the socket
                        pass
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
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await self._forward_messages(ws)
        return ws

    def attach_to_app(self, app, path):
        app.router.add_get(path, self._websocket_handler)
