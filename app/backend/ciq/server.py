"""Application composition root: build the app, wire dependencies, register routes."""
import logging
import os
from pathlib import Path

from aiohttp import web
from dotenv import load_dotenv

from auth import auth_middleware, login, logout, me, signup
from biometric_interpreter import analyze_stress
from ciq.api.consent_routes import get_consent, save_consent
from ciq.api.history_routes import (
    admin_export_pilot_survey,
    admin_export_survey_timeline,
    admin_export_survey_timeline_combined,
    admin_list_user_survey_runs,
    admin_list_users,
    admin_update_user_role,
    get_demo_data,
    manager_analytics,
    manager_overview,
    manager_score_trend,
    set_demo_data,
    user_sessions_history,
    user_zone_trend,
)
from ciq.api.meta_routes import get_config, get_version
from ciq.api.password_reset_routes import (
    admin_approve_password_reset,
    admin_deny_password_reset,
    admin_list_password_resets,
    complete_password_reset_route,
    password_reset_status,
    request_password_reset,
)
from ciq.assessments.routes import (
    close_assessment,
    continue_assessment,
    get_assessment,
    pause_assessment,
    save_assessment_baseline,
    start_assessment,
)
from ciq.biometrics.routes import analyze_face
from ciq.bootstrap import build_rtmt
from ciq.chat.routes import (
    manager_chat,
    manager_chat_delete,
    manager_chat_get,
    manager_chat_list,
    me_chat,
    me_chat_delete,
    me_chat_get,
    me_chat_list,
)
from ciq.config import APP_VERSION
from ciq.eeg.routes import admin_export_eeg_session, upload_eeg_session
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
from ciq.monitoring.routes import admin_monitor_session, admin_monitor_sessions
from ciq.realtime.routes import (
    clear_conversation_state,
    get_session,
    set_biometric_guardrail,
    set_survey_phase,
    set_survey_type,
    update_biometrics,
    update_stress_state,
)
from ciq.recovery.routes import (
    ack_flagged_session,
    complete_recovery_route,
    get_latest_recovery_session_route,
    get_recovery_session_route,
    list_flagged_sessions,
    recommend_recovery_route,
    select_track_route,
    start_recovery_session,
)
from ciq.reports.comparison_routes import me_report_comparison
from ciq.reports.download_request_routes import (
    admin_approve_download_request,
    admin_deny_download_request,
    admin_list_download_requests,
    request_another_download,
)
from ciq.reports.export_routes import admin_export_reports
from ciq.reports.pdf_store_routes import upload_report_pdf
from ciq.reports.routes import (
    analyze_report,
    generate_ssot_report,
    report_behavioral_analysis,
    report_consultative_summary,
)
from ciq.reports.saved_routes import admin_saved_report, me_saved_report
from ciq.reports.share_routes import (
    create_report_share,
    report_share_download,
    report_share_page,
)
from ciq.validation.routes import (
    admin_data_validation_export_zip,
    admin_data_validation_runs,
)
from db_init import init_db

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
    app.router.add_post("/api/signup", signup)
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

    # ── Assessment lifecycle: Start / Pause / Continue / Close (ciq/assessments/) ──
    app.router.add_get("/me/assessment", get_assessment)
    app.router.add_post("/me/assessment/start", start_assessment)
    app.router.add_post("/me/assessment/pause", pause_assessment)
    app.router.add_post("/me/assessment/continue", continue_assessment)
    app.router.add_post("/me/assessment/close", close_assessment)
    app.router.add_post("/me/assessment/baseline", save_assessment_baseline)

    # ── EEG / Muse — raw recording only, uploaded per segment (Pause) and on completion ──
    app.router.add_post("/eeg-sessions", upload_eeg_session)
    app.router.add_get("/admin/eeg-sessions/export", admin_export_eeg_session)

    # ── Recovery Window (see ciq/recovery/, docs/recovery-window.md) — voice-
    # agent-driven; these REST routes are the lifecycle control plane + a
    # non-voice fallback (the 9-question intake itself is mostly collected via
    # voice tools, see ciq/realtime/tools/recovery_handlers.py). "latest" is
    # registered before the {recoverySessionId} routes since aiohttp matches
    # resources in registration order and "latest" would otherwise be captured
    # by the {recoverySessionId} pattern.
    app.router.add_post("/api/recovery-window/start", start_recovery_session)
    app.router.add_get("/api/recovery-window/sessions/latest", get_latest_recovery_session_route)
    app.router.add_post("/api/recovery-window/sessions/{recoverySessionId}/recommend", recommend_recovery_route)
    app.router.add_post("/api/recovery-window/sessions/{recoverySessionId}/select-track", select_track_route)
    app.router.add_post("/api/recovery-window/sessions/{recoverySessionId}/complete", complete_recovery_route)
    app.router.add_get("/api/recovery-window/sessions/{recoverySessionId}", get_recovery_session_route)
    app.router.add_get("/admin/recovery-window/flagged", list_flagged_sessions)
    app.router.add_post("/admin/recovery-window/flagged/{recoverySessionId}/ack", ack_flagged_session)

    # ── Reports ───────────────────────────────────────────────────────────
    app.router.add_post("/analyze-report", analyze_report)
    app.router.add_post("/report/behavioral-analysis", report_behavioral_analysis)
    app.router.add_post("/report/consultative-summary", report_consultative_summary)
    app.router.add_post("/ssot-report", generate_ssot_report)
    # Saved report reopened for viewing / PDF download (ciq/reports/saved_routes.py)
    app.router.add_get("/me/reports/{runId}", me_saved_report)
    # Compared with the previous same-type run (ciq/reports/comparison_routes.py)
    app.router.add_get("/me/reports/{runId}/comparison", me_report_comparison)
    app.router.add_get("/admin/reports/runs/{runId}", admin_saved_report)
    # QR report download — password, then a one-time link for the phone (ciq/reports/share_routes.py)
    app.router.add_post("/me/reports/{runId}/share", create_report_share)
    # The on-screen report PDF, uploaded once by the browser (ciq/reports/pdf_store_routes.py)
    app.router.add_post("/me/reports/{runId}/pdf", upload_report_pdf)
    # One download per report; "request another" → admin approve/deny (ciq/reports/download_request_routes.py)
    app.router.add_post("/me/reports/{runId}/download-request", request_another_download)
    app.router.add_get("/admin/download-requests", admin_list_download_requests)
    app.router.add_post("/admin/download-requests/{requestId}/approve", admin_approve_download_request)
    app.router.add_post("/admin/download-requests/{requestId}/deny", admin_deny_download_request)
    app.router.add_get("/report-share/{token}", report_share_page)
    app.router.add_post("/report-share/{token}/download", report_share_download)

    # ── History / consent (baselines are per assessment: /me/assessment/baseline) ──
    app.router.add_get("/api/history", user_sessions_history)
    app.router.add_get("/api/zone-trend", user_zone_trend)
    app.router.add_get("/consent", get_consent)
    app.router.add_post("/consent", save_consent)
    app.router.add_get("/admin/users", admin_list_users)
    app.router.add_patch("/admin/users/{userId}/role", admin_update_user_role)
    app.router.add_get("/admin/password-resets", admin_list_password_resets)
    app.router.add_post("/admin/password-resets/{requestId}/approve", admin_approve_password_reset)
    app.router.add_post("/admin/password-resets/{requestId}/deny", admin_deny_password_reset)
    app.router.add_post("/password-reset/request", request_password_reset)
    app.router.add_post("/password-reset/status", password_reset_status)
    app.router.add_post("/password-reset/complete", complete_password_reset_route)
    app.router.add_get("/admin/demo-data", get_demo_data)
    app.router.add_post("/admin/demo-data", set_demo_data)
    app.router.add_get("/admin/pilot-survey/export", admin_export_pilot_survey)
    app.router.add_get("/admin/users/{userId}/survey-runs", admin_list_user_survey_runs)
    app.router.add_get("/admin/survey-timeline/export", admin_export_survey_timeline)
    app.router.add_get("/admin/survey-timeline/export-combined", admin_export_survey_timeline_combined)

    # ── Admin Data Validation (docs/data-validation-dashboard.md) ─────────
    app.router.add_get("/admin/data-validation/runs", admin_data_validation_runs)
    app.router.add_get("/admin/data-validation/export-zip", admin_data_validation_export_zip)

    # ── Admin Live Monitor (in-memory, read-only; ciq/monitoring/) ─────────
    app.router.add_get("/admin/monitor/sessions", admin_monitor_sessions)
    app.router.add_get("/admin/monitor/sessions/{sessionId}", admin_monitor_session)

    # ── Admin participant reports (PDF ZIP; ciq/reports/export.py) ──────
    app.router.add_get("/admin/reports/export", admin_export_reports)

    app.router.add_get("/manager/overview", manager_overview)
    app.router.add_get("/manager/analytics", manager_analytics)
    app.router.add_get("/manager/score-trend", manager_score_trend)

    # ── Manager "Wellbeing Assistant" chat (SSE + history) ────────────────
    app.router.add_post("/manager/chat", manager_chat)
    app.router.add_get("/manager/chats", manager_chat_list)
    app.router.add_get("/manager/chats/{chatId}", manager_chat_get)
    app.router.add_delete("/manager/chats/{chatId}", manager_chat_delete)

    # ── Personal (guest) "Wellbeing Assistant" chat — own data only ───────
    app.router.add_post("/me/chat", me_chat)
    app.router.add_get("/me/chats", me_chat_list)
    app.router.add_get("/me/chats/{chatId}", me_chat_get)
    app.router.add_delete("/me/chats/{chatId}", me_chat_delete)

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
