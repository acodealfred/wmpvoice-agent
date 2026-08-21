"""Centralized configuration constants for the CIQ backend."""
import os

# Bump this string whenever you need to verify a deployment from the version endpoint.
APP_VERSION = "v2025-admin-routes"

AVAILABLE_SURVEY_TYPES = ["TEST", "BATFULL", "PILOT", "CBTFULL", "READINESS"]


def env_flag(name: str, default: str = "false") -> bool:
    """Read a boolean feature flag from the environment."""
    return os.environ.get(name, default).lower() == "true"
