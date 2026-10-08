"""Realtime GA protocol shapes (ciq.realtime.ga_protocol) — the preview API is retired."""
from ciq.realtime.ga_protocol import (
    CONVERSATION_ITEM_EVENTS,
    REALTIME_PATH,
    apply_session_overrides,
    realtime_params,
    redact_session_created,
)

VAD = {"type": "server_vad", "threshold": 0.65, "prefix_padding_ms": 300, "silence_duration_ms": 500}


def test_ga_url_has_no_api_version():
    assert REALTIME_PATH == "/openai/v1/realtime"
    assert realtime_params("gpt-realtime") == {"model": "gpt-realtime"}


def test_session_update_gets_ga_shape_and_keeps_client_vad():
    session = {"type": "realtime", "audio": {"input": {"turn_detection": dict(VAD)}}, "instructions": "x"}
    apply_session_overrides(session, voice="alloy")
    assert session["type"] == "realtime"
    assert session["audio"]["input"]["turn_detection"] == VAD
    assert session["audio"]["input"]["transcription"] == {"model": "whisper-1"}
    assert session["audio"]["output"]["voice"] == "alloy"
    # No preview-only keys leak through.
    for key in ("voice", "input_audio_transcription", "turn_detection", "max_response_output_tokens", "temperature"):
        assert key not in session


def test_session_update_without_type_or_audio_is_completed():
    session = apply_session_overrides({})
    assert session["type"] == "realtime"
    assert session["audio"] == {"input": {"transcription": {"model": "whisper-1"}}}
    assert "output_modalities" not in session and "max_output_tokens" not in session


def test_optional_overrides_use_ga_names():
    s = apply_session_overrides({}, max_tokens=500, disable_audio=True)
    assert s["max_output_tokens"] == 500
    assert s["output_modalities"] == ["text"]
    assert apply_session_overrides({}, disable_audio=False)["output_modalities"] == ["audio"]


def test_session_created_redaction_hides_server_config():
    session = {
        "type": "realtime",
        "instructions": "secret",
        "tools": [{"name": "t"}],
        "tool_choice": "auto",
        "max_output_tokens": "inf",
        "audio": {"output": {"voice": "marin"}},
    }
    redact_session_created(session, voice="alloy")
    assert session["instructions"] == ""
    assert session["tools"] == []
    assert session["tool_choice"] == "none"
    assert session["max_output_tokens"] is None
    assert session["audio"]["output"]["voice"] == "alloy"


def test_both_conversation_item_event_names_are_handled():
    assert {"conversation.item.created", "conversation.item.added"} <= CONVERSATION_ITEM_EVENTS
    assert "conversation.item.done" not in CONVERSATION_ITEM_EVENTS
