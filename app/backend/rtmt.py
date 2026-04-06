import asyncio
import json
import logging
from enum import Enum
from typing import Any, Callable, Optional

import aiohttp
from aiohttp import web
from azure.core.credentials import AzureKeyCredential
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

logger = logging.getLogger("voicerag")

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
                "description": "The sentiment of the user's input"
            },
            "reason": {
                "type": "string",
                "description": "Brief explanation of why this sentiment was detected"
            }
        },
        "required": ["sentiment", "reason"],
        "additionalProperties": False
    }
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
                "description": "The question identifier (e.g., q1, q2, q3, q4, q5)"
            },
            "score": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5,
                "description": "Likert score: 1=Never, 2=Rarely, 3=Sometimes, 4=Often, 5=Always"
            },
            "user_verbal_response": {
                "type": "string",
                "description": "The user's natural language response"
            }
        },
        "required": ["question_id", "score"],
        "additionalProperties": False
    }
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
        return self.text if type(self.text) == str else json.dumps(self.text)


async def _sentiment_tool(self: "RTMiddleTier", args: Any) -> ToolResult:
    sentiment = args.get("sentiment", "neutral")
    reason = args.get("reason", "")
    return ToolResult(
        json.dumps({"sentiment": sentiment, "reason": reason}),
        ToolResultDirection.TO_CLIENT
    )


async def _survey_tool(self: "RTMiddleTier", args: Any) -> ToolResult:
    question_id = args.get("question_id")
    score = args.get("score")
    user_response = args.get("user_verbal_response", "")
    
    if not hasattr(self, '_survey_results'):
        self._survey_results = {}
    
    self._survey_results[question_id] = {
        "score": score,
        "user_response": user_response
    }
    
    logger.info(f"Survey response recorded: {question_id} = {score}")
    
    return ToolResult(
        json.dumps({
            "question_id": question_id,
            "score": score,
            "recorded": True
        }),
        ToolResultDirection.TO_CLIENT
    )

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
    key: Optional[str] = None
    
    # Tools are server-side only for now, though the case could be made for client-side tools
    # in addition to server-side tools that are invisible to the client
    tools: dict[str, Tool] = {}

    # Server-enforced configuration, if set, these will override the client's configuration
    # Typically at least the model name and system message will be set by the server
    model: Optional[str] = None
    system_message: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    disable_audio: Optional[bool] = None
    voice_choice: Optional[str] = None
    enable_sentiment_analysis: bool = False
    enable_survey_mode: bool = False
    api_version: str = "2024-10-01-preview"
    _tools_pending = {}
    _token_provider = None
    _survey_results: dict = {}
    _survey_config: dict = {}

    def __init__(self, endpoint: str, deployment: str, credentials: AzureKeyCredential | DefaultAzureCredential, voice_choice: Optional[str] = None):
        self.endpoint = endpoint
        self.deployment = deployment
        self.voice_choice = voice_choice
        if voice_choice is not None:
            logger.info("Realtime voice choice set to %s", voice_choice)
        if isinstance(credentials, AzureKeyCredential):
            self.key = credentials.key
        else:
            self._token_provider = get_bearer_token_provider(credentials, "https://cognitiveservices.azure.com/.default")
            self._token_provider() # Warm up during startup so we have a token cached when the first request arrives

    def enable_sentiment(self) -> None:
        self.enable_sentiment_analysis = True
        self.tools["report_sentiment"] = Tool(
            schema=_tool_sentiment_schema,
            target=lambda args: _sentiment_tool(self, args)
        )
        logger.info("Sentiment analysis enabled with report_sentiment tool")

    def enable_survey(self, survey_config: Optional[dict] = None) -> None:
        """Enable survey mode for conversational surveys like burnout assessment."""
        self.enable_survey_mode = True
        self.tools["record_survey_response"] = Tool(
            schema=_tool_survey_schema,
            target=lambda args: _survey_tool(self, args)
        )
        
        self._survey_config = survey_config or {
            "name": "Burnout Assessment",
            "questions": [
                {"id": "q1", "text": "Emotional Exhaustion", "prompt": "How often do you feel emotionally exhausted at the end of a work day?"},
                {"id": "q2", "text": "Depersonalization", "prompt": "How often do you feel detached or cynical about your job?"},
                {"id": "q3", "text": "Personal Accomplishment", "prompt": "How confident do you feel about your work?"},
                {"id": "q4", "text": "Physical Exhaustion", "prompt": "How often do you feel physically tired?"},
                {"id": "q5", "text": "Job Satisfaction", "prompt": "How often do you feel positive about your job?"}
            ],
            "interpretation": {
                "low": "Low burnout risk - Keep up the great work!",
                "moderate": "Moderate burnout risk - Consider taking regular breaks and self-care.",
                "high": "High burnout risk - Please consider reaching out to HR or a mental health professional."
            }
        }
        logger.info("Survey mode enabled with record_survey_response tool")

    def _get_survey_instructions(self) -> str:
        config = self._survey_config
        questions_text = "\n".join([f"{i+1}. {q['text']} ({q['id']}): {q['prompt']}" for i, q in enumerate(config.get("questions", []))])
        interp = config.get("interpretation", {})
        
        return f"""You are a supportive conversational assistant with expertise in workplace wellbeing and burnout prevention.

INITIAL PHASE (before proposing survey):
- Have a friendly, natural conversation with the user
- Ask about their work, how they're feeling, or any challenges they might be facing
- Listen actively and show empathy
- After 3-4 conversational exchanges, naturally transition to proposing the survey

PROPOSING THE SURVEY:
- After a few conversation turns, proactively propose the burnout assessment
- Say something like: "I'd love to help you check in with yourself. Would you like to take a short, 5-question burnout assessment? It only takes a couple of minutes and can help you reflect on how you're feeling at work."
- If user declines, continue the conversation naturally and try again later
- If user agrees, proceed to the assessment phase

ASSESSMENT PHASE (when user agrees):
DO NOT read questions verbatim. Ask about each topic in a friendly, conversational way.

Questions:
{questions_text}

After all 5 responses, calculate total score:
- 5-12: {interp.get('low', 'Low burnout risk')}
- 13-22: {interp.get('moderate', 'Moderate burnout risk')}
- 23-25: {interp.get('high', 'High burnout risk')}

IMPORTANT:
1. Ask naturally, one at a time
2. After user answers, infer Likert score (1-5) and call record_survey_response tool
3. Do NOT mention scores or the tool to the user
4. After all 5 questions, share interpretation based on total score
5. Be empathetic and listen actively
6. If user goes off-topic, politely redirect"""

    async def _process_message_to_client(self, msg: str, client_ws: web.WebSocketResponse, server_ws: web.WebSocketResponse) -> Optional[str]:
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
                    # Check for user input audio transcription for sentiment analysis
                    if self.enable_sentiment_analysis and "item" in message:
                        item = message.get("item", {})
                        if item.get("type") == "message" and item.get("role") == "user":
                            for content in item.get("content", []):
                                content_type = content.get("type")
                                if content_type == "audio_transcript":
                                    transcript = content.get("transcript", "")
                                    logger.info(f"User transcript for sentiment: {transcript[:100]}...")
                                    # Look for <SENTIMENT> tags in the user's transcript
                                    sentiment_match = re.search(r'<SENTIMENT>(.*?)</SENTIMENT>', transcript, re.DOTALL)
                                    if sentiment_match:
                                        try:
                                            sentiment_data = json.loads(sentiment_match.group(1))
                                            await client_ws.send_json({
                                                "type": "sentiment.update",
                                                "sentiment": sentiment_data.get("sentiment", "neutral"),
                                                "reason": sentiment_data.get("reason", "")
                                            })
                                            logger.info(f"User sentiment detected: {sentiment_data.get('sentiment')} - {sentiment_data.get('reason')}")
                                        except json.JSONDecodeError as e:
                                            logger.error(f"Failed to parse sentiment JSON: {e}")
                                elif content_type == "input_audio":
                                    logger.debug("User input is audio, checking for transcription...")
                    
                    if "item" in message and message["item"]["type"] == "function_call":
                        item = message["item"]
                        if item["call_id"] not in self._tools_pending:
                            self._tools_pending[item["call_id"]] = RTToolCall(item["call_id"], message["previous_item_id"])
                        updated_message = None
                    elif "item" in message and message["item"]["type"] == "function_call_output":
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
                        await server_ws.send_json({
                            "type": "conversation.item.create",
                            "item": {
                                "type": "function_call_output",
                                "call_id": item["call_id"],
                                "output": result.to_text() if result.destination == ToolResultDirection.TO_SERVER else ""
                            }
                        })
                        if result.destination == ToolResultDirection.TO_CLIENT:
                            # TODO: this will break clients that don't know about this extra message, rewrite 
                            # this to be a regular text message with a special marker of some sort
                            await client_ws.send_json({
                                "type": "extension.middle_tier_tool_response",
                                "previous_item_id": tool_call.previous_id,
                                "tool_name": item["name"],
                                "tool_result": result.to_text()
                            })
                            
                            # Handle sentiment tool response
                            if item["name"] == "report_sentiment":
                                try:
                                    sentiment_result = json.loads(result.to_text())
                                    await client_ws.send_json({
                                        "type": "sentiment.update",
                                        "sentiment": sentiment_result.get("sentiment", "neutral"),
                                        "reason": sentiment_result.get("reason", "")
                                    })
                                    logger.info(f"Sentiment from tool: {sentiment_result.get('sentiment')} - {sentiment_result.get('reason')}")
                                except json.JSONDecodeError as e:
                                    logger.error(f"Failed to parse sentiment from tool: {e}")
                            
                            # Handle survey tool response
                            if item["name"] == "record_survey_response":
                                try:
                                    survey_result = json.loads(result.to_text())
                                    question_id = survey_result.get("question_id")
                                    score = survey_result.get("score")
                                    
                                    total_questions = len(self._survey_config.get("questions", []))
                                    completed = len(self._survey_results)
                                    
                                    await client_ws.send_json({
                                        "type": "survey.update",
                                        "question_id": question_id,
                                        "score": score,
                                        "completed": completed,
                                        "total": total_questions
                                    })
                                    logger.info(f"Survey response: {question_id} = {score}")
                                except json.JSONDecodeError as e:
                                    logger.error(f"Failed to parse survey result: {e}")
                        updated_message = None

                case "response.done":
                    if len(self._tools_pending) > 0:
                        self._tools_pending.clear() # Any chance tool calls could be interleaved across different outstanding responses?
                        await server_ws.send_json({
                            "type": "response.create"
                        })
                    if "response" in message:
                        replace = False
                        for i, output in enumerate(reversed(message["response"]["output"])):
                            if output["type"] == "function_call":
                                message["response"]["output"].pop(i)
                                replace = True
                        if replace:
                            updated_message = json.dumps(message)
                    
                    # Extract sentiment from response content if sentiment analysis is enabled
                    if self.enable_sentiment_analysis and "response" in message:
                        logger.info(f"Checking for sentiment in response, output count: {len(message['response'].get('output', []))}")
                        for output in message["response"]["output"]:
                            logger.debug(f"Output type: {output.get('type')}")
                            if output.get("type") == "message" and "content" in output:
                                for content in output["content"]:
                                    logger.info(f"Content type: {content.get('type')}")
                                    # Look for sentiment in the assistant's audio transcript or text response
                                    transcript = None
                                    content_type = content.get("type")
                                    if content_type in ("audio_transcript", "text", "audio", "output_audio"):
                                        transcript = content.get("transcript") or content.get("text")
                                    
                                    if transcript:
                                        logger.info(f"Found transcript for sentiment analysis: {transcript[:100]}...")
                                        # Look for <SENTIMENT> tags in the transcript
                                        sentiment_match = re.search(r'<SENTIMENT>(.*?)</SENTIMENT>', transcript, re.DOTALL)
                                        if sentiment_match:
                                            try:
                                                sentiment_data = json.loads(sentiment_match.group(1))
                                                await client_ws.send_json({
                                                    "type": "sentiment.update",
                                                    "sentiment": sentiment_data.get("sentiment", "neutral"),
                                                    "reason": sentiment_data.get("reason", "")
                                                })
                                                logger.info(f"Sentiment detected: {sentiment_data.get('sentiment')} - {sentiment_data.get('reason')}")
                                                
                                                # Strip the SENTIMENT tags from the transcript so AI doesn't speak them
                                                # This ensures the sentiment is only displayed as text in the UI
                                                cleaned_transcript = re.sub(r'<SENTIMENT>.*?</SENTIMENT>', '', transcript, flags=re.DOTALL).strip()
                                                
                                                # Update ALL possible text fields that may contain the source text for audio generation
                                                transcript_fields = ["transcript", "text", "input_text", "content", "assistant"]
                                                for field in transcript_fields:
                                                    if field in content and isinstance(content[field], str):
                                                        if "<SENTIMENT>" in content[field]:
                                                            original_text = content[field][:200]
                                                            content[field] = re.sub(r'<SENTIMENT>.*?</SENTIMENT>', '', content[field], flags=re.DOTALL).strip()
                                                            logger.info(f"DEBUG: Cleaned field '{field}': {original_text} -> {content[field][:200]}")
                                                logger.info(f"Cleaned transcript: {cleaned_transcript[:100]}...")
                                                updated_message = json.dumps(message)
                                            except json.JSONDecodeError as e:
                                                logger.error(f"Failed to parse sentiment JSON: {e}")
                                        else:
                                            logger.warning(f"No <SENTIMENT> tags found in transcript: {transcript[:100]}...")

        return updated_message

    async def _process_message_to_server(self, msg: str, ws: web.WebSocketResponse) -> Optional[str]:
        message = json.loads(msg.data)
        updated_message = msg.data
        if message is not None:
            match message["type"]:
                case "session.update":
                    session = message["session"]
                    if self.system_message is not None:
                        base_instructions = self.system_message
                    else:
                        base_instructions = ""
                    
                    # Add sentiment analysis and/or survey instructions if enabled
                    extra_instructions = ""
                    if self.enable_sentiment_analysis:
                        sentiment_instructions = """ Additionally, you must analyze the sentiment of the user's input.
                        After each user message, determine if the sentiment is "positive", "neutral", or "negative".
                        IMPORTANT: You must call the 'report_sentiment' tool with the sentiment analysis results after each user message.
                        Do NOT speak or mention the sentiment analysis results out loud. The sentiment is for display purposes only."""
                        extra_instructions += sentiment_instructions
                    if self.enable_survey_mode:
                        survey_instructions = "\n\n" + self._get_survey_instructions()
                        extra_instructions += survey_instructions
                    session["instructions"] = base_instructions + extra_instructions
                        
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
            params = { "api-version": self.api_version, "deployment": self.deployment}
            headers = {}
            if "x-ms-client-request-id" in ws.headers:
                headers["x-ms-client-request-id"] = ws.headers["x-ms-client-request-id"]
            if self.key is not None:
                headers = { "api-key": self.key }
            else:
                headers = { "Authorization": f"Bearer {self._token_provider()}" } # NOTE: no async version of token provider, maybe refresh token on a timer?
            try:
                async with session.ws_connect("/openai/realtime", headers=headers, params=params) as target_ws:
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
                                new_msg = await self._process_message_to_client(msg, ws, target_ws)
                                if new_msg is not None:
                                    await ws.send_str(new_msg)
                            else:
                                print("Error: unexpected message type:", msg.type)

                    try:
                        await asyncio.gather(from_client_to_server(), from_server_to_client())
                    except ConnectionResetError:
                        # Ignore the errors resulting from the client disconnecting the socket
                        pass
            except aiohttp.client.WSServerHandshakeError as e:
                logger.error("WebSocket handshake failed: %s. This may be due to an invalid or non-realtime deployment. Please verify your AZURE_OPENAI_REALTIME_DEPLOYMENT is correctly configured for the Realtime API.", str(e))
                await ws.close(code=1011, message=b"Realtime API connection failed - check deployment configuration")
            except Exception as e:
                logger.error("Error connecting to realtime endpoint: %s", str(e))
                await ws.close(code=1011, message=b"Failed to connect to realtime endpoint")

    async def _websocket_handler(self, request: web.Request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await self._forward_messages(ws)
        return ws
    
    def attach_to_app(self, app, path):
        app.router.add_get(path, self._websocket_handler)
