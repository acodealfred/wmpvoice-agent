"""Azure OpenAI Realtime **GA** protocol shapes.

The Realtime preview (beta) API — `/openai/realtime?api-version=…-preview` — was
retired by Azure (deprecated 2026-04-30; connections now fail with
`realtime_beta_access_required`). The GA protocol differs in three ways that matter
here (see https://aka.ms/aoai/realtime-ga):

- URL: `/openai/v1/realtime?model=<deployment>` — no `api-version`, no `OpenAI-Beta`.
- `session.update` needs `session.type = "realtime"`, and the audio settings moved
  under `session.audio.input` / `session.audio.output`.
- Assistant audio events were renamed (`response.output_audio.delta`, …) — handled
  in the frontend (useRealtime.tsx), which consumes them.

Pure helpers only, so the exact wire shape is unit-tested without a socket.
"""

REALTIME_PATH = "/openai/v1/realtime"

# Both spellings: GA added `conversation.item.added` / `.done` alongside the
# preview-era `conversation.item.created`.
CONVERSATION_ITEM_EVENTS = frozenset({"conversation.item.created", "conversation.item.added"})

# Whisper transcription of the user's audio: the source of each answer's
# user_response (the user's own words — see ciq.realtime.transcripts).
INPUT_TRANSCRIPTION = {"model": "whisper-1"}


def realtime_params(deployment: str) -> dict[str, str]:
    """Query parameters for the GA realtime WebSocket."""
    return {"model": deployment}


def apply_session_overrides(
    session: dict,
    *,
    voice: str | None = None,
    max_tokens: int | None = None,
    disable_audio: bool | None = None,
) -> dict:
    """Put the server-enforced settings into a GA `session.update` payload, in place.

    Keeps whatever the client already set (e.g. its `audio.input.turn_detection`
    VAD tuning) and only adds/overwrites the fields the server owns.
    """
    session["type"] = "realtime"
    audio = session.setdefault("audio", {})
    audio_in = audio.setdefault("input", {})
    audio_in["transcription"] = dict(INPUT_TRANSCRIPTION)
    if voice is not None:
        audio.setdefault("output", {})["voice"] = voice
    if max_tokens is not None:
        session["max_output_tokens"] = max_tokens
    if disable_audio is not None:
        session["output_modalities"] = ["text"] if disable_audio else ["audio"]
    return session


def redact_session_created(session: dict, *, voice: str | None) -> dict:
    """Hide the instructions, tools and token limit from clients (`session.created`)."""
    session["instructions"] = ""
    session["tools"] = []
    session["tool_choice"] = "none"
    session["max_output_tokens"] = None
    if voice is not None:
        session.setdefault("audio", {}).setdefault("output", {})["voice"] = voice
    return session
