"""HTTP route handlers proxying the admin Knowledge Base UI to the Mithra API."""
import logging
import os

import aiohttp
from aiohttp import web

from ciq.kb.mithra_client import (
    mithra_base_url,
    mithra_exc_response,
    mithra_headers,
    mithra_response,
    mithra_session,
)
from ciq.kb.storage import load_kb_docs, save_kb_docs

logger = logging.getLogger("voicerag")


async def admin_kb_list_documents(request):
    """GET /admin/kb/documents — return persisted document metadata."""
    return web.json_response({"documents": load_kb_docs()})


async def admin_kb_upload(request):
    """Proxy: POST /admin/kb/upload → Mithra POST /gateway/v2/papers/fromFile"""
    try:
        reader = await request.multipart()
        title = ""
        classification_ids = []
        file_data = None
        file_name = "upload"
        file_content_type = "application/octet-stream"

        async for part in reader:
            if part.name == "title":
                title = await part.read(decode=True)
                title = title.decode("utf-8")
            elif part.name == "classificationIds":
                val = await part.read(decode=True)
                classification_ids.append(val.decode("utf-8"))
            elif part.name == "file":
                file_data = await part.read(decode=False)
                file_name = part.filename or "upload"
                file_content_type = part.headers.get("Content-Type", "application/octet-stream")

        if not title or file_data is None:
            return web.json_response({"error": "title and file are required"}, status=400)

        # Build multipart — file MUST be last (Mithra gateway requirement)
        form = aiohttp.FormData()
        form.add_field("title", title)
        for cid in classification_ids:
            form.add_field("classificationIds", cid)
        form.add_field("file", file_data, filename=file_name, content_type=file_content_type)

        async with mithra_session() as session:
            async with session.post(
                f"{mithra_base_url()}/gateway/v2/papers/fromFile",
                data=form,
                headers=mithra_headers(),
            ) as resp:
                if resp.status in (200, 201):
                    raw = await resp.json(content_type=None)
                    # Persist document metadata server-side so any browser can see it
                    from datetime import datetime, timezone
                    docs = load_kb_docs()
                    docs.append({
                        "paperId":   raw.get("id", ""),
                        "title":     raw.get("title", title),
                        "uploadedAt": datetime.now(timezone.utc).isoformat(),
                    })
                    save_kb_docs(docs)
                    return web.json_response(raw, status=resp.status)
                return await mithra_response(resp)
    except Exception as e:
        return await mithra_exc_response("admin_kb_upload", e)


async def admin_kb_delete(request):
    """Proxy: DELETE /admin/kb/documents/{paperId} → Mithra DELETE /gateway/v2/papers/{paperId}"""
    try:
        paper_id = request.match_info["paperId"]
        async with mithra_session() as session:
            async with session.delete(
                f"{mithra_base_url()}/gateway/v2/papers/{paper_id}",
                headers=mithra_headers(),
            ) as resp:
                if resp.status == 204 or resp.ok:
                    # Remove from persisted list on any success response
                    docs = load_kb_docs()
                    docs = [d for d in docs if d.get("paperId") != paper_id]
                    save_kb_docs(docs)
                    if resp.status == 204:
                        return web.Response(status=204)
                return await mithra_response(resp)
    except Exception as e:
        return await mithra_exc_response("admin_kb_delete", e)


async def admin_kb_get_settings(request):
    """Proxy: GET /admin/kb/settings → Mithra GET /gateway/v1/knowledgeBase/settings"""
    try:
        async with mithra_session() as session:
            async with session.get(
                f"{mithra_base_url()}/gateway/v1/knowledgeBase/settings",
                headers=mithra_headers(),
            ) as resp:
                return await mithra_response(resp)
    except Exception as e:
        return await mithra_exc_response("admin_kb_get_settings", e)


async def admin_kb_patch_settings(request):
    """Proxy: PATCH /admin/kb/settings → Mithra PATCH /gateway/v1/knowledgeBase/settings"""
    try:
        data = await request.json()
        min_citations = data.get("minCitationsCount", 1)
        async with mithra_session() as session:
            async with session.patch(
                f"{mithra_base_url()}/gateway/v1/knowledgeBase/settings",
                json={"minCitationsCount": min_citations},
                headers={**mithra_headers(), "Content-Type": "application/json"},
            ) as resp:
                return await mithra_response(resp)
    except Exception as e:
        return await mithra_exc_response("admin_kb_patch_settings", e)


async def admin_kb_search_papers(request):
    """Proxy: POST /admin/kb/papers/search → Mithra POST /gateway/v2/papers/search
    Uses type=enterprise to list all company documents.
    """
    try:
        body = await request.json() if request.content_length else {}
        payload = {
            "type": "enterprise",
            "limit": body.get("limit", 100),
        }
        if body.get("lastId"):
            payload["lastId"] = body["lastId"]
        async with mithra_session() as session:
            async with session.post(
                f"{mithra_base_url()}/gateway/v2/papers/search",
                json=payload,
                headers={**mithra_headers(), "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                data = await resp.json(content_type=None)
                logger.info("[Mithra] papers/search status=%s count=%s", resp.status,
                            len(data.get("papers", [])) if isinstance(data, dict) else "?")
                return web.json_response(data, status=resp.status)
    except Exception as e:
        return await mithra_exc_response("admin_kb_search_papers", e)


async def kb_create_chat(request):
    """Proxy: POST /kb/chats → Mithra POST /gateway/v1/knowledgeBase/chats"""
    try:
        data = await request.json()
        async with mithra_session() as session:
            async with session.post(
                f"{mithra_base_url()}/gateway/v1/knowledgeBase/chats",
                json=data,
                headers={**mithra_headers(), "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                body = await resp.json(content_type=None)
                logger.info("[Mithra] kb_create_chat status=%s keys=%s", resp.status, list(body.keys()) if isinstance(body, dict) else type(body))
                return web.json_response(body, status=resp.status)
    except Exception as e:
        return await mithra_exc_response("kb_create_chat", e)


async def kb_get_chat(request):
    """Proxy: GET /kb/chats/{chatId} → Mithra GET /gateway/v1/knowledgeBase/chats/{chatId}"""
    chat_id = request.match_info["chatId"]
    try:
        limit = request.rel_url.query.get("messageLimit", "50")
        async with mithra_session() as session:
            async with session.get(
                f"{mithra_base_url()}/gateway/v1/knowledgeBase/chats/{chat_id}",
                params={"messageLimit": limit},
                headers=mithra_headers(),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                body = await resp.json(content_type=None)
                return web.json_response(body, status=resp.status)
    except Exception as e:
        return await mithra_exc_response("kb_get_chat", e)


async def kb_send_message(request):
    """Proxy: POST /kb/chats/{chatId}/messages → Mithra POST .../chats/{chatId}/messages"""
    chat_id = request.match_info["chatId"]
    try:
        data = await request.json()
        async with mithra_session() as session:
            async with session.post(
                f"{mithra_base_url()}/gateway/v1/knowledgeBase/chats/{chat_id}/messages",
                json=data,
                headers={**mithra_headers(), "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                body = await resp.json(content_type=None)
                logger.info("[Mithra] kb_send_message chatId=%s status=%s", chat_id, resp.status)
                return web.json_response(body, status=resp.status)
    except Exception as e:
        return await mithra_exc_response("kb_send_message", e)


async def report_llm_debug(request):
    """GET /admin/report-llm/debug — show what the backend reads for the reporting LLM config."""
    ep  = os.environ.get("REPORT_OPENAI_ENDPOINT", "")
    key = os.environ.get("REPORT_OPENAI_API_KEY", "")
    dep = os.environ.get("REPORT_OPENAI_DEPLOYMENT", "")
    return web.json_response({
        "REPORT_OPENAI_ENDPOINT":   ep or "(not set)",
        "REPORT_OPENAI_API_KEY":    (key[:6] + "…" + key[-4:]) if len(key) > 10 else ("(not set)" if not key else "(set but short)"),
        "REPORT_OPENAI_API_KEY_len": len(key),
        "REPORT_OPENAI_DEPLOYMENT": dep or "(not set — will use default gpt-4o)",
        "ready": bool(ep and key),
    })


async def admin_kb_debug(request):
    """Diagnostics: checks token config + outbound connectivity to Mithra."""
    import traceback

    token_raw = os.environ.get("MITHRA_APP_TOKEN", "")
    base_url = mithra_base_url()

    result = {
        "token_configured": bool(token_raw),
        "token_preview": (token_raw[:8] + "…") if token_raw else "(empty — MITHRA_APP_TOKEN not set)",
        "mithra_base_url": base_url,
        "connectivity": None,
        "connectivity_error": None,
        "settings_status": None,
        "settings_body": None,
        "settings_error": None,
    }

    # 1. Basic connectivity probe (HEAD to base URL)
    try:
        async with mithra_session() as session:
            async with session.head(base_url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                result["connectivity"] = resp.status
    except Exception:
        result["connectivity_error"] = traceback.format_exc()

    # 2. Try the actual settings endpoint
    try:
        async with mithra_session() as session:
            async with session.get(
                f"{base_url}/gateway/v1/knowledgeBase/settings",
                headers=mithra_headers(),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                result["settings_status"] = resp.status
                result["settings_body"] = await resp.text()
    except Exception:
        result["settings_error"] = traceback.format_exc()

    return web.json_response(result)
