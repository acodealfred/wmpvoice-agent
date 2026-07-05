"""Meta endpoints: feature config + build/version info."""
from aiohttp import web

from ciq.config import APP_VERSION, AVAILABLE_SURVEY_TYPES, env_flag


async def get_config(request):
    """Return current feature configuration to frontend."""
    rtmt = request.app.get("rtmt")
    return web.json_response(
        {
            "enableSentimentAnalysis": env_flag("ENABLE_SENTIMENT_ANALYSIS"),
            "enableSurveyMode": env_flag("ENABLE_SURVEY_MODE"),
            "surveyTypeOverridden": rtmt.survey_type_overridden if rtmt else False,
            "activeSurveyType": rtmt.active_survey_type if rtmt else "TEST",
            "availableSurveyTypes": AVAILABLE_SURVEY_TYPES,
            "biometricGuardrailEnabled": rtmt.biometric_guardrail_enabled if rtmt else True,
        }
    )


async def get_version(request):
    """Return build version and REAL registered routes from the live router."""
    live_routes = [str(r) for r in request.app.router.resources()]
    admin_registered = any("admin" in r for r in live_routes)
    return web.json_response({
        "version": APP_VERSION,
        "admin_routes_registered": admin_registered,
        "all_routes": live_routes,
    })
