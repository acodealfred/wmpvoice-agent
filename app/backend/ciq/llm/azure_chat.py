"""Azure OpenAI chat-completions client.

This is the report-generation LLM path — entirely separate from the realtime
WebSocket proxy. It was previously ``RTMiddleTier.analyze_with_prompt``; extracting
it lets the report service depend on a small, mockable client instead of the proxy.
"""
import json
import logging
import os
import traceback as _tb

import aiohttp

logger = logging.getLogger("voicerag")


class AzureChatClient:
    """Thin wrapper over the Azure OpenAI chat-completions REST API."""

    def __init__(self, endpoint: str, key: str | None = None, token_provider=None):
        self.endpoint = endpoint
        self.key = key
        self._token_provider = token_provider

    async def analyze_with_prompt(self, system_prompt: str) -> str:
        """Send system_prompt to Azure OpenAI chat completions and return the text response."""
        try:
            # ── Step 1: build auth headers ──────────────────────────────────
            api_key = self.key
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
            chat_deployment = os.environ.get("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-4o")
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
