"""Chat routes — SSE streaming + history REST, for two surfaces.

  • Manager (org) surface: /manager/chat*  — auth_middleware gates to manager/admin.
  • Personal (guest) surface: /me/chat*     — any authenticated user; tools are
    bound to their own user_id and RBAC-gated.

Both share one SSE handler; they differ only in scope, system prompt and toolkit.
See docs/manager-chat.md § "Transport protocol" and § "RBAC".
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
from ciq.chat.prompts import GUEST_SYSTEM_PROMPT, MANAGER_SYSTEM_PROMPT
from ciq.chat.rbac import ChatAuth
from ciq.chat.tools import GUEST_TOOL_SCHEMAS, MANAGER_TOOL_SCHEMAS

logger = logging.getLogger("voicerag")


def _title_from(message: str) -> str:
    t = " ".join((message or "").split())
    return (t[:57] + "…") if len(t) > 58 else (t or "New chat")


async def _sse(resp: web.StreamResponse, event: str, data: dict) -> None:
    await resp.write(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8"))


def _auth_for(request: web.Request, scope: str) -> ChatAuth:
    session = request["auth_session"]
    return ChatAuth(user_id=session["user_id"], role=session.get("role") or "employee", scope=scope)


async def _stream_chat(request: web.Request, scope: str, system_prompt: str, tool_schemas: list) -> web.StreamResponse:
    """Shared SSE handler for a chat turn on either surface."""
    auth = _auth_for(request, scope)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    message = (body.get("message") or "").strip()
    if not message:
        return web.json_response({"error": "message is required"}, status=400)
    chat_id = body.get("chatId") or None
    filters = body.get("filters") if isinstance(body.get("filters"), dict) else None

    # ── Resolve / create the chat (ownership + scope enforced) BEFORE streaming ──
    if chat_id:
        chat = await get_chat_session(chat_id)
        if not chat or chat.get("scope") != scope:
            return web.json_response({"error": "Chat not found"}, status=404)
        if chat["user_id"] != auth.user_id:
            return web.json_response({"error": "Forbidden"}, status=403)
        history = await get_chat_messages(chat_id)
    else:
        chat_id = str(uuid.uuid4())
        await create_chat_session(chat_id, auth.user_id, _title_from(message), scope=scope)
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

    # ── Deterministic input guard (scope-aware) ──
    refusal = check_input(message, scope)
    if refusal:
        await _sse(resp, "token", {"delta": refusal})
        await add_chat_message(str(uuid.uuid4()), chat_id, "assistant", refusal)
        await _sse(resp, "done", {"chatId": chat_id})
        await resp.write_eof()
        return resp

    # ── Orchestrate: tool loop → streamed synthesis ──
    answer_text, citations, tool_trace, errored = "", [], [], False
    rtmt = request.app.get("rtmt")
    try:
        async for ev in run_chat(rtmt, auth, history, message, filters, system_prompt, tool_schemas):
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
        footer = build_footer(citations, scope)
        await _sse(resp, "token", {"delta": footer})
        stored += footer
        await add_chat_message(
            str(uuid.uuid4()), chat_id, "assistant", stored,
            citations=citations or None, tool_trace=tool_trace or None,
        )

    await _sse(resp, "done", {"chatId": chat_id})
    await resp.write_eof()
    return resp


async def _list(request: web.Request, scope: str) -> web.Response:
    user_id = request["auth_session"]["user_id"]
    return web.json_response({"chats": await list_chat_sessions(user_id, scope)})


async def _get(request: web.Request, scope: str) -> web.Response:
    user_id = request["auth_session"]["user_id"]
    chat_id = request.match_info["chatId"]
    chat = await get_chat_session(chat_id)
    if not chat or chat.get("scope") != scope:
        return web.json_response({"error": "Chat not found"}, status=404)
    if chat["user_id"] != user_id:
        return web.json_response({"error": "Forbidden"}, status=403)
    return web.json_response({"chat": chat, "messages": await get_chat_messages(chat_id)})


async def _delete(request: web.Request, scope: str) -> web.Response:
    user_id = request["auth_session"]["user_id"]
    chat_id = request.match_info["chatId"]
    chat = await get_chat_session(chat_id)
    if not chat or chat.get("scope") != scope:
        return web.json_response({"error": "Chat not found"}, status=404)
    if chat["user_id"] != user_id:
        return web.json_response({"error": "Forbidden"}, status=403)
    await delete_chat_session(chat_id)
    return web.json_response({"ok": True})


# ── Manager (org) surface — /manager/chat* ──────────────────────────────────
async def manager_chat(request):
    return await _stream_chat(request, "manager", MANAGER_SYSTEM_PROMPT, MANAGER_TOOL_SCHEMAS)


async def manager_chat_list(request):
    return await _list(request, "manager")


async def manager_chat_get(request):
    return await _get(request, "manager")


async def manager_chat_delete(request):
    return await _delete(request, "manager")


# ── Personal (guest) surface — /me/chat* ────────────────────────────────────
async def me_chat(request):
    return await _stream_chat(request, "personal", GUEST_SYSTEM_PROMPT, GUEST_TOOL_SCHEMAS)


async def me_chat_list(request):
    return await _list(request, "personal")


async def me_chat_get(request):
    return await _get(request, "personal")


async def me_chat_delete(request):
    return await _delete(request, "personal")
