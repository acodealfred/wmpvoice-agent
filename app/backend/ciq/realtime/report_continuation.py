"""Keep the PILOT voice report going when Azure cuts a response off at its output limit.

The report explanation (`report.cue`) is one long response. If it runs past the model's
per-response output cap, Azure ends it with status "incomplete" / reason
"max_output_tokens" and the agent simply stops mid-sentence. When that happens to a
report response, the middle tier asks the model — at most MAX_AUTO_CONTINUES times — to
carry on from exactly where it stopped. Any other ending (completed, cancelled by
Pause, another reason) clears the report so ordinary follow-up replies are never
continued. Pure helpers (no I/O); the state lives on ConnectionState.
"""

MAX_AUTO_CONTINUES = 2


def _response(message: dict) -> dict:
    response = message.get("response")
    return response if isinstance(response, dict) else {}


def cut_off_by_token_limit(message: dict) -> bool:
    """True when this `response.done` ended because it hit the output-token cap."""
    response = _response(message)
    details = response.get("status_details") or {}
    return response.get("status") == "incomplete" and details.get("reason") == "max_output_tokens"


def response_end_summary(message: dict) -> str:
    """One log line: how a response ended and how many output tokens it used."""
    response = _response(message)
    details = response.get("status_details") or {}
    usage = response.get("usage") or {}
    out = usage.get("output_token_details") or {}
    return (f"status={response.get('status')} reason={details.get('reason')} "
            f"output_tokens={usage.get('output_tokens')} "
            f"(audio={out.get('audio_tokens')}, text={out.get('text_tokens')})")
