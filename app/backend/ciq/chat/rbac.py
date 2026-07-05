"""Role-based authorization for chat tools — the injection-proof backstop.

Even if the model is tricked (prompt injection, a merged toolkit, a future
refactor) into emitting an org-level tool call from the personal surface, the
dispatcher checks THIS map against the trusted, server-derived ``ChatAuth``
(never anything the prompt controls) and refuses. Org data is therefore
unreachable from the guest surface by construction.

See docs/manager-chat.md § "RBAC on the assistant tools".
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class ChatAuth:
    """Trusted identity for a chat turn, derived from the auth session only."""
    user_id: str
    role: str    # 'employee' | 'manager' | 'admin'
    scope: str   # 'manager' (org surface) | 'personal' (employee surface)


# Capability required per tool: which surface (scope) and which roles may run it.
_ORG = {"scopes": {"manager"}, "roles": {"manager", "admin"}}
_PERSONAL = {"scopes": {"personal"}, "roles": {"employee", "manager", "admin"}}
_BOTH = {"scopes": {"manager", "personal"}, "roles": {"employee", "manager", "admin"}}

TOOL_ACCESS: dict[str, dict] = {
    # Org / aggregate tools — manager surface only.
    "get_org_overview": _ORG,
    "get_department_breakdown": _ORG,
    "get_score_trend": _ORG,
    # Personal tools — bound to the caller's own user_id.
    "get_my_assessments": _PERSONAL,
    "get_my_score_trend": _PERSONAL,
    "get_my_latest_report": _PERSONAL,
    # Research is safe for everyone.
    "search_research": _BOTH,
}


def is_authorized(name: str, auth: ChatAuth) -> bool:
    rule = TOOL_ACCESS.get(name)
    return bool(rule and auth.scope in rule["scopes"] and auth.role in rule["roles"])
