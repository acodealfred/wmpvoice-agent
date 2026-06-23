"""Client for the Mithra Knowledge Base API + the dedicated reporting LLM.

All outbound HTTP to Mithra (and the separate report-writing Azure OpenAI deployment)
lives here so route handlers just shape requests/responses.
"""
import json
import logging
import os

import aiohttp
from aiohttp import web

from ciq.common.json_utils import safe_json

logger = logging.getLogger("voicerag")


def mithra_headers() -> dict:
    """Auth header for all Mithra API calls.
    Azure Container Apps: create secret named 'mithra-app-token', then map it to
    env var MITHRA_APP_TOKEN in the container's environment variable configuration.
    """
    token = os.environ.get("MITHRA_APP_TOKEN", "")
    return {"Authorization": f"Bearer {token}"}


def mithra_base_url() -> str:
    return os.environ.get("MITHRA_API_BASE_URL", "https://api.dev.mithra.shelterzoom.com")


def mithra_session() -> aiohttp.ClientSession:
    """ClientSession with SSL verification disabled for the Mithra dev server.
    The dev certificate hostname doesn't match, so we skip verification. Remove
    ssl=False once a valid cert is in place.
    """
    connector = aiohttp.TCPConnector(ssl=False)
    return aiohttp.ClientSession(connector=connector)


async def mithra_response(resp) -> web.Response:
    """Convert a Mithra API response to an aiohttp response.
    Handles both JSON and non-JSON bodies (e.g. HTML error pages from the gateway).
    """
    raw = await resp.text()
    try:
        body = json.loads(raw)
        return web.json_response(body, status=resp.status)
    except Exception:
        return web.Response(
            text=raw,
            status=resp.status,
            content_type="text/plain",
        )


async def mithra_exc_response(handler_name: str, exc: Exception) -> web.Response:
    import traceback
    detail = traceback.format_exc()
    logger.error("[%s] %s\n%s", handler_name, exc, detail)
    return web.json_response({"error": str(exc), "detail": detail}, status=500)


async def call_mithra_kb_chat(query: str) -> "dict | None":
    """Query the Mithra KB chat API with a single question.
    Returns {'answer': str, 'citations': list} or None on failure.
    """
    if not os.environ.get("MITHRA_APP_TOKEN"):
        logger.info("[Mithra] MITHRA_APP_TOKEN not set — skipping KB chat")
        return None
    try:
        base = mithra_base_url()
        headers = {**mithra_headers(), "Content-Type": "application/json"}
        async with mithra_session() as session:
            # Step 1: create chat session
            async with session.post(
                f"{base}/gateway/v1/knowledgeBase/chats",
                json={"initialQuestion": query, "title": "Burnout Consultative Report"},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status not in (200, 201):
                    text = await resp.text()
                    logger.warning("[Mithra] create chat returned %s: %s", resp.status, text[:200])
                    return None
                create_data = await resp.json(content_type=None)

            chat_id = (create_data.get("chat") or {}).get("id")
            if not chat_id:
                logger.warning("[Mithra] create chat response has no chat.id: %s", str(create_data)[:200])
                return None

            logger.info("[Mithra] chat created id=%s, fetching messages", chat_id)

            # Step 2: fetch messages to get the assistant answer
            async with session.get(
                f"{base}/gateway/v1/knowledgeBase/chats/{chat_id}",
                params={"messageLimit": 10},
                headers=mithra_headers(),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    logger.warning("[Mithra] get chat messages returned %s: %s", resp.status, text[:200])
                    return None
                msg_data = await resp.json(content_type=None)

        messages = msg_data.get("messages") or []
        # Find first assistant message (messages are newest-first per spec)
        assistant_msg = next((m for m in messages if m.get("role") == "assistant"), None)
        if not assistant_msg:
            logger.warning("[Mithra] no assistant message found in chat %s", chat_id)
            return None

        answer = assistant_msg.get("content") or ""

        # sources is the current field; citations is deprecated but kept as fallback
        raw_sources = assistant_msg.get("sources") or assistant_msg.get("citations") or []
        citations = []
        for s in raw_sources:
            pages = s.get("pages") or []
            citations.append({
                "paperId": s.get("paperId", ""),
                "paperTitle": s.get("paperTitle", ""),
                "paperPage": pages[0] if pages else s.get("paperPage", 0),
            })

        logger.info("[Mithra] answer=%d chars citations=%d", len(answer), len(citations))
        return safe_json({"answer": answer, "citations": citations})

    except Exception as exc:
        logger.warning("[Mithra] KB chat call failed: %s", exc)
        return None


async def call_report_llm(facts: str, citations: list) -> "str | None":
    """Call the dedicated reporting Azure OpenAI deployment to write a physiometric report.
    Credentials are completely independent of the realtime voice model.
    Returns report text or None if not configured / on error.
    """
    endpoint   = os.environ.get("REPORT_OPENAI_ENDPOINT", "").rstrip("/")
    api_key    = os.environ.get("REPORT_OPENAI_API_KEY", "")
    deployment = os.environ.get("REPORT_OPENAI_DEPLOYMENT", "gpt-4o")

    logger.info("[ReportLLM] config — endpoint=%r  api_key_len=%d  deployment=%r",
                endpoint or "(not set)", len(api_key), deployment)

    if not endpoint:
        logger.warning("[ReportLLM] REPORT_OPENAI_ENDPOINT is empty — skipping LLM stage")
        return None
    if not api_key:
        logger.warning("[ReportLLM] REPORT_OPENAI_API_KEY is empty — skipping LLM stage")
        return None

    citations_text = "\n".join(
        f'- {c.get("paperTitle","?")} (p.{c.get("paperPage",0)})'
        for c in citations
    ) or "(none)"

    system_prompt = (
        "You are a licensed physiometric analyst specialising in workplace burnout and occupational wellbeing. "
        "Using ONLY the evidence-based facts provided below (sourced from the organisation's own knowledge base), "
        "write a concise, professional consultative report.\n\n"
        "Structure the report using EXACTLY these three headings — write nothing before the first heading:\n\n"
        "General Case:\n"
        "Root Cause:\n"
        "Recommendation:\n\n"
        "Style rules:\n"
        "- Write as a physiometric professional — clinical yet empathetic tone\n"
        "- Flowing prose paragraphs, not bullet lists\n"
        "- 2-3 paragraphs per section\n"
        "- Use only information from the facts below — do not add outside knowledge\n\n"
        f"KNOWLEDGE BASE FACTS:\n{facts}\n\n"
        f"SOURCE CITATIONS:\n{citations_text}"
    )

    url = (
        f"{endpoint}/openai/deployments/{deployment}"
        f"/chat/completions?api-version=2024-02-15-preview"
    )
    payload_bytes = json.dumps({
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": "Write the consultative report now."},
        ],
        "max_tokens": 1200,
        "temperature": 0.4,
    }, ensure_ascii=False).encode("utf-8")

    logger.info("[ReportLLM] POST %s  (facts_len=%d)", url, len(facts))
    try:
        async with mithra_session() as session:
            async with session.post(
                url,
                data=payload_bytes,
                headers={"Content-Type": "application/json", "api-key": api_key},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                logger.info("[ReportLLM] status=%s", resp.status)
                if resp.status != 200:
                    err = await resp.text()
                    logger.error("[ReportLLM] error %s: %s", resp.status, err[:300])
                    return None
                result = await resp.json(content_type=None)
                content = result["choices"][0]["message"]["content"] or ""
                logger.info("[ReportLLM] report generated — %d chars", len(content))
                return content
    except Exception as exc:
        logger.error("[ReportLLM] call failed: %s", exc)
        return None
