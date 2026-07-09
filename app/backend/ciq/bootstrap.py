"""Build and wire the RTMiddleTier from environment configuration.

This is the only place that decides credentials, feature flags, persona and survey
type — keeping that ~40 lines of setup out of the route-registration code in server.py.
"""
import logging
import os

from azure.core.credentials import AzureKeyCredential
from azure.identity import AzureDeveloperCliCredential, DefaultAzureCredential

from ciq.config import env_flag
from ciq.prompts.personas import BASIC_SYSTEM_MESSAGE, META_INTENT, SURVEY_SYSTEM_MESSAGE
from ciq.realtime.middle_tier import RTMiddleTier

logger = logging.getLogger("voicerag")


def _llm_credential():
    llm_key = os.environ.get("AZURE_OPENAI_API_KEY")
    if llm_key:
        return AzureKeyCredential(llm_key)
    if tenant_id := os.environ.get("AZURE_TENANT_ID"):
        logger.info("Using AzureDeveloperCliCredential with tenant_id %s", tenant_id)
        return AzureDeveloperCliCredential(tenant_id=tenant_id, process_timeout=60)
    logger.info("Using DefaultAzureCredential")
    return DefaultAzureCredential()


def build_rtmt() -> RTMiddleTier:
    """Construct the RTMiddleTier and apply sentiment/survey/persona/guardrail config."""
    rtmt = RTMiddleTier(
        credentials=_llm_credential(),
        endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
        deployment=os.environ["AZURE_OPENAI_REALTIME_DEPLOYMENT"],
        voice_choice=os.environ.get("AZURE_OPENAI_REALTIME_VOICE_CHOICE") or "alloy",
    )

    if env_flag("ENABLE_SENTIMENT_ANALYSIS"):
        rtmt.enable_sentiment()
        logger.info("Sentiment analysis is enabled")

    enable_survey = env_flag("ENABLE_SURVEY_MODE")
    if enable_survey:
        from survey_loader import SURVEY_MAP, load_survey
        override = env_flag("OVERRIDE_SURVEY_TYPE")
        survey_type_env = os.environ.get("SURVEY_TYPE", "TEST").upper()
        if survey_type_env not in SURVEY_MAP:
            logger.warning("Unknown SURVEY_TYPE=%s, defaulting to TEST", survey_type_env)
            survey_type_env = "TEST"
        rtmt.survey_type_overridden = override
        rtmt.enable_survey(load_survey(survey_type_env), survey_type=survey_type_env)
        logger.info("Survey mode is enabled (type=%s, overridden=%s)", survey_type_env, override)

    # Meta intent is identical for both modes; persona differs.
    rtmt.meta_intent_config = META_INTENT
    rtmt.system_message = SURVEY_SYSTEM_MESSAGE if enable_survey else BASIC_SYSTEM_MESSAGE

    # Biometric guardrail: descriptive-only mode (default on; runtime-togglable from Admin).
    rtmt.biometric_guardrail_enabled = env_flag("ENABLE_BIOMETRIC_GUARDRAIL", "true")
    logger.info("Biometric guardrail default: %s", rtmt.biometric_guardrail_enabled)

    return rtmt
