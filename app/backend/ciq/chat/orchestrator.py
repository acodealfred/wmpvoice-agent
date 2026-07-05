"""Chat orchestrator — Azure OpenAI tool loop + streaming synthesis.

Reuses the SAME Azure OpenAI gpt-4o path as the post-assessment consultative
summary (AzureChatClient): the realtime resource endpoint + AZURE_OPENAI_CHAT_DEPLOYMENT
+ the live realtime credential (api-key or Entra bearer token). We can't call
AzureChatClient.analyze_with_prompt directly because it's one-shot — no tool
calling or streaming — so we borrow its endpoint/deployment/credential from the
running RTMiddleTier and build the tool+stream requests here.

Runs a bounded, non-streamed tool-resolution loop, then a single streamed
completion for the user-visible answer. Emits typed events the route turns into
SSE. See docs/manager-chat.md § "Orchestration loop".
"""
import json
import logging
import os

import aiohttp

from ciq.chat.rbac import ChatAuth
from ciq.chat.tools import dispatch_tool

logger = logging.getLogger("voicerag")

MAX_TOOL_ITERS = int(os.environ.get("MANAGER_CHAT_MAX_TOOL_ITERS", "3"))
# Match the consultative-summary chat path (AzureChatClient) for resource compat.
_API_VERSION = "2024-08-01-preview"  # tool calling + streaming


def _endpoint_deployment(rtmt) -> tuple[str, str]:
    """Same endpoint + chat deployment the consultative summary uses."""
    endpoint = (getattr(rtmt, "endpoint", "") or "").rstrip("/")
    deployment = os.environ.get("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-4o")
    return endpoint, deployment


def _auth_headers(rtmt) -> dict:
    """Reuse the live realtime credential: api-key if present, else an Entra token."""
    headers = {"Content-Type": "application/json"}
    key = getattr(rtmt, "key", None)
    if key:
        headers["api-key"] = key
    else:
        provider = getattr(rtmt, "_token_provider", None)
        if provider:
            headers["Authorization"] = f"Bearer {provider()}"
    return headers


def _completions_url(endpoint: str, deployment: str) -> str:
    return (
        f"{endpoint}/openai/deployments/{deployment}"
        f"/chat/completions?api-version={_API_VERSION}"
    )


def build_messages(system_prompt: str, history: list[dict], user_message: str, filters: dict | None) -> list[dict]:
    """System prompt + prior turns + optional current dashboard filter context + new message."""
    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    for m in history:
        role = m.get("role")
        if role in ("user", "assistant") and m.get("content"):
            messages.append({"role": role, "content": m["content"]})
    if filters:
        active = {k: v for k, v in filters.items() if v}
        if active:
            messages.append({
                "role": "system",
                "content": "The dashboard currently has these filters applied: "
                           + json.dumps(active) + ". Consider them the default lens unless they ask otherwise.",
            })
    messages.append({"role": "user", "content": user_message})
    return messages


async def _post(session, url, headers, payload):
    async with session.post(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        timeout=aiohttp.ClientTimeout(total=90),
    ) as resp:
        if resp.status != 200:
            err = await resp.text()
            logger.error("[Chat] Azure OpenAI %s: %s", resp.status, err[:300])
            raise RuntimeError(f"LLM error {resp.status}")
        return await resp.json(content_type=None)


async def run_chat(
    rtmt,
    auth: ChatAuth,
    history: list[dict],
    user_message: str,
    filters: dict | None,
    system_prompt: str,
    tool_schemas: list,
):
    """Async generator of events:
        {"type": "tool", "name": str}
        {"type": "token", "delta": str}
        {"type": "citations", "citations": list}
        {"type": "final", "text": str, "citations": list, "tool_trace": list}
        {"type": "error", "message": str}
    """
    endpoint, deployment = _endpoint_deployment(rtmt)
    headers = _auth_headers(rtmt)
    if not endpoint or ("api-key" not in headers and "Authorization" not in headers):
        yield {"type": "error", "message": "The assistant isn't configured (no Azure OpenAI endpoint/credential)."}
        return
    url = _completions_url(endpoint, deployment)

    messages = build_messages(system_prompt, history, user_message, filters)
    citations: list = []
    tool_trace: list = []

    # SSL disabled to match the rest of the CIQ→Azure/Mithra egress (dev certs).
    connector = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=connector) as session:
        # ── Phase 1: bounded tool-resolution loop (non-streamed) ──────────────
        try:
            for _ in range(MAX_TOOL_ITERS):
                data = await _post(session, url, headers, {
                    "messages": messages,
                    "tools": tool_schemas,
                    "tool_choice": "auto",
                    "temperature": 0.3,
                    "max_tokens": 800,
                })
                choice = (data.get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                tool_calls = msg.get("tool_calls") or []
                if not tool_calls:
                    break
                # Record the assistant's tool-call turn, then answer each call.
                messages.append({
                    "role": "assistant",
                    "content": msg.get("content") or "",
                    "tool_calls": tool_calls,
                })
                for tc in tool_calls:
                    fn = tc.get("function") or {}
                    name = fn.get("name", "")
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except Exception:
                        args = {}
                    yield {"type": "tool", "name": name}
                    result, cites = await dispatch_tool(name, args, auth)
                    if cites:
                        for c in cites:
                            if c not in citations:
                                citations.append(c)
                    tool_trace.append({"name": name, "args": args})
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id"),
                        "content": json.dumps(result, ensure_ascii=False),
                    })
        except Exception as exc:
            logger.error("[Chat] tool loop failed: %s", exc)
            yield {"type": "error", "message": "The assistant hit an error reaching its data."}
            return

        if citations:
            yield {"type": "citations", "citations": citations}

        # ── Phase 2: stream the final answer ──────────────────────────────────
        full = []
        try:
            async with session.post(
                url,
                data=json.dumps({
                    "messages": messages,
                    "temperature": 0.4,
                    "max_tokens": 900,
                    "stream": True,
                }, ensure_ascii=False).encode("utf-8"),
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as resp:
                if resp.status != 200:
                    err = await resp.text()
                    logger.error("[Chat] stream error %s: %s", resp.status, err[:300])
                    yield {"type": "error", "message": "The assistant couldn't compose an answer."}
                    return
                async for raw in resp.content:
                    line = raw.decode("utf-8", "ignore").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        obj = json.loads(payload)
                    except Exception:
                        continue
                    delta = (((obj.get("choices") or [{}])[0]).get("delta") or {}).get("content")
                    if delta:
                        full.append(delta)
                        yield {"type": "token", "delta": delta}
        except Exception as exc:
            logger.error("[Chat] streaming failed: %s", exc)
            yield {"type": "error", "message": "The assistant couldn't compose an answer."}
            return

        yield {"type": "final", "text": "".join(full), "citations": citations, "tool_trace": tool_trace}
