"""Application composition root: build the app, wire dependencies, register routes."""
import logging
import os
from pathlib import Path

from aiohttp import web
from dotenv import load_dotenv

from auth import auth_middleware, login, logout, me
from biometric_interpreter import analyze_stress
from db_init import init_db

from ciq.api.baseline_routes import clear_baseline, get_baseline, save_baseline
from ciq.api.history_routes import (
    admin_list_users,
    get_demo_data,
    manager_overview,
    set_demo_data,
    user_sessions_history,
)
from ciq.api.meta_routes import get_config, get_version
from ciq.biometrics.routes import analyze_face
from ciq.bootstrap import build_rtmt
from ciq.config import APP_VERSION
from ciq.kb.routes import (
    admin_kb_debug,
    admin_kb_delete,
    admin_kb_get_settings,
    admin_kb_list_documents,
    admin_kb_patch_settings,
    admin_kb_search_papers,
    admin_kb_upload,
    kb_create_chat,
    kb_get_chat,
    kb_send_message,
    report_llm_debug,
)
from ciq.realtime.routes import (
    clear_conversation_state,
    get_session,
    set_biometric_guardrail,
    set_survey_phase,
    set_survey_type,
    update_biometrics,
    update_stress_state,
)
from ciq.reports.routes import (
    analyze_report,
    generate_ssot_report,
    report_behavioral_analysis,
    report_consultative_summary,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
)
logger = logging.getLogger("voicerag")
logger.setLevel(logging.INFO)

logger.info("=== CIQ backend starting — build %s ===", APP_VERSION)


async def create_app():
    if not os.environ.get("RUNNING_IN_PRODUCTION"):
        logger.info("Running in development mode, loading from .env file")
        load_dotenv()

    await init_db()

    app = web.Application(middlewares=[auth_middleware])

    # Build and wire the realtime middle tier from environment configuration.
    rtmt = build_rtmt()
    app["rtmt"] = rtmt

    # ── Auth ──────────────────────────────────────────────────────────────
    app.router.add_post("/login", login)
    app.router.add_post("/logout", logout)
    app.router.add_get("/me", me)

    # ── Realtime control plane + biometrics ───────────────────────────────
    app.router.add_post("/biometrics", update_biometrics)
    app.router.add_post("/analyze", analyze_face)
    app.router.add_post("/analyze-stress", analyze_stress)
    app.router.add_get("/config", get_config)
    app.router.add_post("/survey-type", set_survey_type)
    app.router.add_post("/admin/biometric-guardrail", set_biometric_guardrail)
    app.router.add_post("/clear-conversation", clear_conversation_state)
    app.router.add_post("/update-stress", update_stress_state)
    app.router.add_post("/survey-phase", set_survey_phase)
    app.router.add_get("/session", get_session)

    # ── Reports ───────────────────────────────────────────────────────────
    app.router.add_post("/analyze-report", analyze_report)
    app.router.add_post("/report/behavioral-analysis", report_behavioral_analysis)
    app.router.add_post("/report/consultative-summary", report_consultative_summary)
    app.router.add_post("/ssot-report", generate_ssot_report)

    # ── History / baseline ────────────────────────────────────────────────
    app.router.add_get("/api/history", user_sessions_history)
    app.router.add_get("/baseline", get_baseline)
    app.router.add_post("/baseline", save_baseline)
    app.router.add_delete("/baseline", clear_baseline)
    app.router.add_get("/admin/users", admin_list_users)
    app.router.add_get("/admin/demo-data", get_demo_data)
    app.router.add_post("/admin/demo-data", set_demo_data)
    app.router.add_get("/manager/overview", manager_overview)

    # ── Mithra Knowledge Base admin proxy routes ──────────────────────────
    app.router.add_get("/admin/kb/documents", admin_kb_list_documents)
    app.router.add_post("/admin/kb/upload", admin_kb_upload)
    app.router.add_delete("/admin/kb/documents/{paperId}", admin_kb_delete)
    app.router.add_get("/admin/kb/settings", admin_kb_get_settings)
    app.router.add_patch("/admin/kb/settings", admin_kb_patch_settings)
    app.router.add_get("/admin/kb/debug", admin_kb_debug)
    app.router.add_get("/admin/report-llm/debug", report_llm_debug)
    app.router.add_post("/admin/kb/papers/search", admin_kb_search_papers)
    app.router.add_post("/kb/chats", kb_create_chat)
    app.router.add_get("/kb/chats/{chatId}", kb_get_chat)
    app.router.add_post("/kb/chats/{chatId}/messages", kb_send_message)
    app.router.add_get("/version", get_version)

    # RAG tools disabled - kept for future extensibility (see ragtools.py).

    rtmt.attach_to_app(app, "/realtime")

    current_directory = Path(__file__).resolve().parents[1]
    app.add_routes(
        [
            web.get(
                "/", lambda _: web.FileResponse(current_directory / "static/index.html")
            )
        ]
    )
    app.router.add_static("/", path=current_directory / "static", name="static")

    # Log every registered route so we can verify deployment in the container log stream
    logger.info("=== REGISTERED ROUTES ===")
    for resource in app.router.resources():
        logger.info("  %s", resource)
    logger.info("=========================")

    return app
