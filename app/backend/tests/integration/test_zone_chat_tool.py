"""Fatigue ↔ Burnout zone — personal chat tool (spec 2026-10-01 §6.3)."""
# pytest (rootdir-relative "prepend" import mode, no __init__.py) puts tests/integration on
# sys.path, so the sibling test module imports by its basename. Test basenames are unique.
from test_zone_trend import EXAMPLE, HIGH, insert_run, user_id


def test_guest_schemas_include_zone_tool():
    from ciq.chat.tools import GUEST_TOOL_SCHEMAS, MANAGER_TOOL_SCHEMAS
    assert "get_my_zone_trend" in [t["function"]["name"] for t in GUEST_TOOL_SCHEMAS]
    assert "get_my_zone_trend" not in [t["function"]["name"] for t in MANAGER_TOOL_SCHEMAS]


def test_guest_prompt_routes_improvement_questions_to_zone_tool():
    from ciq.chat.prompts import GUEST_SYSTEM_PROMPT
    assert "get_my_zone_trend" in GUEST_SYSTEM_PROMPT
    assert "not a diagnosis" in GUEST_SYSTEM_PROMPT


async def test_dispatch_zone_tool_returns_only_callers_data(initialized_db):
    from ciq.chat.rbac import ChatAuth
    from ciq.chat.tools import dispatch_tool

    g1, g2 = await user_id("guest1"), await user_id("guest2")
    await insert_run(g1, "g1-a", "2026-09-01T00:00:00", EXAMPLE)
    await insert_run(g2, "g2-a", "2026-09-02T00:00:00", HIGH)

    result, citations = await dispatch_tool(
        "get_my_zone_trend", {"user_id": g2}, ChatAuth(user_id=g1, role="employee", scope="personal")
    )
    assert citations == []
    assert [p["surveyRunId"] for p in result["trend"]["points"]] == ["g1-a"]
    assert result["latest"]["zone"] == "mild"


async def test_zone_tool_denied_on_manager_surface(initialized_db):
    from ciq.chat.rbac import ChatAuth
    from ciq.chat.tools import dispatch_tool

    m = await user_id("manager1")
    result, _ = await dispatch_tool("get_my_zone_trend", {}, ChatAuth(user_id=m, role="manager", scope="manager"))
    assert result == {"error": "not authorized for this tool on this surface"}


async def test_zone_tool_reports_unavailable_config(initialized_db, monkeypatch):
    import survey_loader
    from ciq.chat.rbac import ChatAuth
    from ciq.chat.tools import dispatch_tool

    monkeypatch.setitem(survey_loader.SURVEY_MAP, "PILOT", "surveys/does-not-exist.json")
    g1 = await user_id("guest1")
    result, _ = await dispatch_tool("get_my_zone_trend", {}, ChatAuth(user_id=g1, role="employee", scope="personal"))
    assert result == {"error": "zone unavailable"}


async def test_existing_score_trend_tool_unchanged(initialized_db):
    """Regression: get_my_score_trend still filters on totalScore (empty for PILOT runs)."""
    from ciq.chat.rbac import ChatAuth
    from ciq.chat.tools import dispatch_tool

    g1 = await user_id("guest1")
    await insert_run(g1, "g1-a", "2026-09-01T00:00:00", EXAMPLE)
    result, _ = await dispatch_tool("get_my_score_trend", {}, ChatAuth(user_id=g1, role="employee", scope="personal"))
    assert result == {"points": []}
