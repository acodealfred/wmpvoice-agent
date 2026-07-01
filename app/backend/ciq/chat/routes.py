"""Manager chat routes — SSE streaming endpoint + chat history REST.

All under /manager/*, so auth_middleware already restricts them to managers and
admins. See docs/manager-chat.md § "Transport protocol".
"""
import json
import logging
import uuid

from aiohttp import web

from db import (
    add_chat_message,
    create_chat_session,
    delete_chat_session,
    get_chat_messages,
    get_chat_session,
    list_chat_sessions,
)

from ciq.chat.guardrails import EMPTY_FALLBACK, build_footer, check_input
from ciq.chat.orchestrator import run_chat

logger = logging.getLogger("voicerag")


def _title_from(message: str) -> str:
    t = " ".join((message or "").split())
    return (t[:57] + "…") if len(t) > 58 else (t or "New chat")


async def _sse(resp: web.StreamResponse, event: str, data: dict) -> None:
    await resp.write(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8"))


async def manager_chat(request: web.Request) -> web.StreamResponse:
    """POST /manager/chat — send a message, stream the grounded answer as SSE."""
    user_id = request["auth_session"]["user_id"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    message = (body.get("message") or "").strip()
    if not message:
        return web.json_response({"error": "message is required"}, status=400)
    chat_id = body.get("chatId") or None
    filters = body.get("filters") if isinstance(body.get("filters"), dict) else None

    # ── Resolve / create the chat (ownership enforced) BEFORE streaming ──
    if chat_id:
        chat = await get_chat_session(chat_id)
        if not chat:
            return web.json_response({"error": "Chat not found"}, status=404)
        if chat["user_id"] != user_id:
            return web.json_response({"error": "Forbidden"}, status=403)
        history = await get_chat_messages(chat_id)
    else:
        chat_id = str(uuid.uuid4())
        await create_chat_session(chat_id, user_id, _title_from(message))
        history = []

    # Persist the user's turn up front so it survives a mid-generation failure.
    await add_chat_message(str(uuid.uuid4()), chat_id, "user", message)

    resp = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
    await resp.prepare(request)
    await _sse(resp, "meta", {"chatId": chat_id})

    # ── Deterministic input guard — refuse individual-level requests ──
    refusal = check_input(message)
    if refusal:
        await _sse(resp, "token", {"delta": refusal})
        await add_chat_message(str(uuid.uuid4()), chat_id, "assistant", refusal)
        await _sse(resp, "done", {"chatId": chat_id})
        await resp.write_eof()
        return resp

    # ── Orchestrate: tool loop → streamed synthesis ──
    answer_text = ""
    citations: list = []
    tool_trace: list = []
    errored = False
    rtmt = request.app.get("rtmt")
    try:
        async for ev in run_chat(rtmt, history, message, filters):
            kind = ev["type"]
            if kind == "tool":
                await _sse(resp, "tool", {"name": ev["name"], "status": "done"})
            elif kind == "token":
                await _sse(resp, "token", {"delta": ev["delta"]})
            elif kind == "citations":
                citations = ev["citations"]
                await _sse(resp, "citations", {"citations": citations})
            elif kind == "final":
                answer_text = ev["text"]
                citations = ev.get("citations") or citations
                tool_trace = ev.get("tool_trace") or []
            elif kind == "error":
                errored = True
                await _sse(resp, "error", {"message": ev["message"]})
    except Exception as exc:
        logger.error("[Chat] stream handler failed: %s", exc)
        errored = True
        await _sse(resp, "error", {"message": "The assistant hit an unexpected error."})

    # ── Footer + persist the assistant turn ──
    stored = answer_text.strip()
    if not stored and not errored:
        stored = EMPTY_FALLBACK
        await _sse(resp, "token", {"delta": stored})
    if stored:
        footer = build_footer(citations)
        await _sse(resp, "token", {"delta": footer})
        stored += footer
        await add_chat_message(
            str(uuid.uuid4()), chat_id, "assistant", stored,
            citations=citations or None, tool_trace=tool_trace or None,
        )

    await _sse(resp, "done", {"chatId": chat_id})
    await resp.write_eof()
    return resp


async def manager_chat_list(request: web.Request) -> web.Response:
    """GET /manager/chats — the manager's chats, most recent first."""
    user_id = request["auth_session"]["user_id"]
    return web.json_response({"chats": await list_chat_sessions(user_id)})


async def manager_chat_get(request: web.Request) -> web.Response:
    """GET /manager/chats/{chatId} — full message history (owner only)."""
    user_id = request["auth_session"]["user_id"]
    chat_id = request.match_info["chatId"]
    chat = await get_chat_session(chat_id)
    if not chat:
        return web.json_response({"error": "Chat not found"}, status=404)
    if chat["user_id"] != user_id:
        return web.json_response({"error": "Forbidden"}, status=403)
    return web.json_response({"chat": chat, "messages": await get_chat_messages(chat_id)})


async def manager_chat_delete(request: web.Request) -> web.Response:
    """DELETE /manager/chats/{chatId} — delete a chat (owner only)."""
    user_id = request["auth_session"]["user_id"]
    chat_id = request.match_info["chatId"]
    chat = await get_chat_session(chat_id)
    if not chat:
        return web.json_response({"error": "Chat not found"}, status=404)
    if chat["user_id"] != user_id:
        return web.json_response({"error": "Forbidden"}, status=403)
    await delete_chat_session(chat_id)
    return web.json_response({"ok": True})
