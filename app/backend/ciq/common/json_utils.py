"""Pure JSON helpers shared across report/KB code paths. No I/O — unit-testable."""
import json
import re


def strip_llm_error(text: str) -> str:
    """analyze_with_prompt returns an {"error": ...} JSON string when the chat deployment
    is unavailable. Treat that as 'no output' so the UI surfaces a clean error instead."""
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and "error" in parsed:
            return ""
    except Exception:
        pass
    return text


def parse_llm_json(text: str):
    """Parse a JSON object from an LLM response, tolerating ```json code fences and
    surrounding prose. Returns the parsed object, or None if no JSON could be found —
    so the structured behavioral-analysis groups render instead of a raw JSON blob."""
    if not text:
        return None
    s = text.strip()
    # Strip a wrapping ```json … ``` (or plain ```) code fence if present.
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.DOTALL)
    if fence:
        s = fence.group(1).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    # Last resort: parse the first {...} block embedded in prose.
    start, end = s.find("{"), s.rfind("}")
    if 0 <= start < end:
        try:
            return json.loads(s[start : end + 1])
        except json.JSONDecodeError:
            return None
    return None


def safe_json(obj: object) -> object:
    """Recursively ensure all dict keys are strings so web.json_response never fails.
    None keys from external APIs (JSON null key) are converted to the string "null".
    """
    if isinstance(obj, dict):
        return {(str(k) if k is not None else "null"): safe_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [safe_json(i) for i in obj]
    return obj
