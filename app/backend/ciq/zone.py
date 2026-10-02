"""Fatigue ↔ Burnout zone — a wellbeing guide, not a diagnosis.

Pure functions (no DB, no network) that turn stored PILOT survey answers into:

- a position on a Fatigue ↔ Burnout line (lean + marker),
- an overall severity zone (mean strain of all 7 items),
- a direction (improving / steady / worsening) vs recent check-ins,
- optional "fatigue signals" from biometrics (supporting only — they never move
  the marker, severity, zone or trend).

Nothing here is persisted; every caller calculates on demand from `survey_records`.
"""
import json
import logging
import math
from decimal import ROUND_HALF_UP, Decimal
from statistics import mean, median
from typing import NamedTuple

from survey_loader import effective_score, get_score_bounds, options_for_question

logger = logging.getLogger("voicerag")

ZONE_CONFIG: dict = {
    # Product judgement, not a validated factor structure. Must cover exactly the
    # PILOT question IDs (validate_config + a unit test enforce this).
    "groups": {
        "fatigue": ["bat_q1", "bat_q3", "cbi_q1", "cbi_q2", "cbi_q3"],
        "burnout": ["bat_q2", "bat_q4"],
    },
    # Upper bounds (exclusive) on unrounded severity; anything ≥ the last is "high".
    "zones": [(25, "well"), (50, "mild"), (75, "moderate")],
    "top_zone": "high",
    "lean_threshold": 15,      # |burnout − fatigue| at or beyond this picks a side
    "trend_dead_zone": 5,      # |delta| below this is "steady"
    "trend_window": 3,         # earlier complete runs averaged for the reference
    "trend_points": 20,        # chart points returned (most recent)
    "blink_up_pct": 20,        # PDF fatigue/recovery row: rate +20–50% → lower edge
    "slower_ratio": 1.25,      # PDF latency "High" band: ≥ +25%
    "min_signal_items": 5,     # usable items (of 7) needed before a chip is shown
}

_SIGNAL_LABELS = {
    "blink_up": "Blink rate above your baseline",
    "slower": "Slower responses than your recent check-ins",
}


class ZoneConfigError(Exception):
    """The survey config is not a usable PILOT config (e.g. the silent TEST fallback)."""


class _Scores(NamedTuple):
    fatigue: float
    burnout: float
    severity: float


def _all_item_ids() -> list[str]:
    return [qid for ids in ZONE_CONFIG["groups"].values() for qid in ids]


def _round(x: float) -> int:
    """Round half-up (away from zero at .5) to an int — the only rounding used for output."""
    return int(Decimal(str(x)).quantize(Decimal(0), rounding=ROUND_HALF_UP))


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_config(config: dict) -> None:
    """Raise ZoneConfigError unless `config` is the PILOT config the groups were built for.

    `load_survey("PILOT")` silently falls back to TEST when the PILOT file is missing or
    malformed, so the type is checked explicitly here.
    """
    if not isinstance(config, dict) or config.get("type") != "PILOT":
        raise ZoneConfigError("survey config is not PILOT")
    if not config.get("scoringSections"):
        raise ZoneConfigError("PILOT config has no scoringSections")
    question_ids = {q.get("id") for q in config.get("questions", [])}
    if set(_all_item_ids()) != question_ids:
        raise ZoneConfigError("zone groups do not match the PILOT question IDs")
    for qid in _all_item_ids():
        if not options_for_question(config, qid):
            raise ZoneConfigError(f"no answer options for {qid}")


def _strains(config: dict, survey_results: dict) -> dict[str, float] | None:
    """Per-item strain 0–100 (higher = more strain), or None if any item is invalid.

    Validity is checked BEFORE scoring: effective_score() maps None to 0, and a missing
    answer must never count as "no strain".
    """
    if not isinstance(survey_results, dict):
        return None
    strains: dict[str, float] = {}
    for qid in _all_item_ids():
        entry = survey_results.get(qid)
        raw = entry.get("score") if isinstance(entry, dict) else None
        # Membership, not a range: the realtime tool accepts one combined enum for both
        # scales, so a 3 on a 0–100 CBI item would pass a min/max check.
        allowed = {o.get("value") for o in options_for_question(config, qid)}
        if not isinstance(raw, int) or isinstance(raw, bool) or raw not in allowed:
            return None
        lo, hi = get_score_bounds(config, qid)
        eff = effective_score(config, qid, raw)  # flips reverse items exactly once
        strains[qid] = (eff - lo) / (hi - lo) * 100
    return strains


def _score(config: dict, survey_results: dict) -> _Scores | None:
    strains = _strains(config, survey_results)
    if strains is None:
        return None
    groups = ZONE_CONFIG["groups"]
    return _Scores(
        fatigue=mean(strains[q] for q in groups["fatigue"]),
        burnout=mean(strains[q] for q in groups["burnout"]),
        # Item-weighted: every answer step moves severity by 25/7 whichever item it is.
        severity=mean(strains.values()),
    )


def _zone_key(severity: float) -> str:
    for upper, key in ZONE_CONFIG["zones"]:
        if severity < upper:
            return key
    return ZONE_CONFIG["top_zone"]


def _format(scores: _Scores) -> dict:
    zone = _zone_key(scores.severity)
    lean_value = scores.burnout - scores.fatigue
    threshold = ZONE_CONFIG["lean_threshold"]
    if zone == "well":
        lean, marker = "none", None
    else:
        if lean_value <= -threshold:
            lean = "fatigue"
        elif lean_value >= threshold:
            lean = "burnout"
        else:
            lean = "mixed"
        marker = _round(50 + lean_value / 2)  # 0 = Fatigue end, 100 = Burnout end
    return {
        "fatigue": _round(scores.fatigue),
        "burnout": _round(scores.burnout),
        "severity": _round(scores.severity),
        "zone": zone,
        "lean": lean,
        "leanValue": _round(lean_value),
        "marker": marker,
    }


def compute_zone(config: dict, survey_results: dict) -> dict | None:
    """Zone scores for one run (no signals), or None when the run is incomplete."""
    scores = _score(config, survey_results)
    return None if scores is None else _format(scores)


def _usable_blink(entry) -> float | None:
    v = entry.get("blinkRateChange") if isinstance(entry, dict) else None
    # The serializer stores a missing blink value as 0, so 0 means "no data".
    return v if _is_number(v) and v != 0 else None


def _usable_latency(entry) -> float | None:
    v = entry.get("responseLatencyMs") if isinstance(entry, dict) else None
    return v if _is_number(v) and v > 0 else None


def _usable_values(results: dict, picker) -> list[float]:
    values = [picker(results.get(qid)) for qid in _all_item_ids()]
    usable = [v for v in values if v is not None]
    return usable if len(usable) >= ZONE_CONFIG["min_signal_items"] else []


def compute_signals(config: dict, latest_results: dict, previous_results_list: list[dict]) -> list:
    """Supporting fatigue signals for the latest run. Hidden (not "normal") when data is thin.

    `previous_results_list` holds the survey_results of up to `trend_window` earlier
    complete runs. `config` is accepted for symmetry with compute_zone; the signals
    read only biometric fields.
    """
    signals: list[dict] = []

    blinks = _usable_values(latest_results, _usable_blink)
    if blinks and mean(blinks) > ZONE_CONFIG["blink_up_pct"]:
        signals.append({"key": "blink_up", "label": _SIGNAL_LABELS["blink_up"], "approximate": True})

    latencies = _usable_values(latest_results, _usable_latency)
    previous_medians = [
        median(vals)
        for vals in (_usable_values(r, _usable_latency) for r in previous_results_list)
        if vals
    ]
    if latencies and previous_medians:
        if median(latencies) >= ZONE_CONFIG["slower_ratio"] * median(previous_medians):
            signals.append({"key": "slower", "label": _SIGNAL_LABELS["slower"], "approximate": True})

    return signals


def compute_trend(complete_runs: list[dict]) -> dict:
    """Direction of the latest complete run vs the average of the up-to-3 runs before it.

    `complete_runs` is sorted oldest → newest; each item has `surveyRunId`, `date`,
    `zone`, `lean` and the UNROUNDED `severity` (float).
    """
    points = [
        {"surveyRunId": r["surveyRunId"], "date": r["date"], "severity": _round(r["severity"]),
         "zone": r["zone"], "lean": r["lean"]}
        for r in complete_runs[-ZONE_CONFIG["trend_points"]:]
    ]
    if not complete_runs:
        return {"status": "none", "points": []}
    if len(complete_runs) == 1:
        return {"status": "first", "points": points}

    earlier = complete_runs[-1 - ZONE_CONFIG["trend_window"]:-1]
    ref = mean(r["severity"] for r in earlier)
    # Rounded to 9 dp only to absorb float noise when a delta sits exactly on ±5.
    delta = round(complete_runs[-1]["severity"] - ref, 9)
    dead_zone = ZONE_CONFIG["trend_dead_zone"]
    if delta <= -dead_zone:
        status = "improving"
    elif delta >= dead_zone:
        status = "worsening"
    else:
        status = "steady"
    return {
        "status": status,
        "delta": _round(delta),
        "ref": _round(ref),
        "compared": len(earlier),
        "points": points,
    }


def _parse_results(record: dict) -> dict | None:
    """survey_results as a non-empty dict, or None (skipped). Bad JSON logs a warning."""
    raw = record.get("survey_results")
    if isinstance(raw, dict):
        return raw or None
    if not raw or raw == "{}":
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("[Zone] Unparseable survey_results for run %s — skipped",
                       str(record.get("survey_run_id"))[:8])
        return None
    if not isinstance(parsed, dict):
        logger.warning("[Zone] Non-object survey_results for run %s — skipped",
                       str(record.get("survey_run_id"))[:8])
        return None
    return parsed or None


def build_zone_trend(records: list[dict], config: dict) -> dict:
    """{"latest": zone | None, "trend": trend} for one user's survey_records rows.

    Only PILOT rows with complete, valid answers are scored. Raises ZoneConfigError when
    `config` is not a usable PILOT config.
    """
    validate_config(config)

    runs: list[dict] = []
    for record in records:
        if (record.get("survey_type") or "").upper() != "PILOT":
            continue
        results = _parse_results(record)
        if results is None:
            continue
        scores = _score(config, results)
        if scores is None:
            continue  # incomplete: no zone, left out of the trend
        runs.append({"record": record, "results": results, "scores": scores})

    runs.sort(key=lambda r: (r["record"].get("created_at") or "", r["record"].get("survey_run_id") or ""))

    complete_runs = [
        {
            "surveyRunId": r["record"].get("survey_run_id"),
            "date": (r["record"].get("created_at") or "")[:10],
            "severity": r["scores"].severity,
            **{k: v for k, v in _format(r["scores"]).items() if k in ("zone", "lean")},
        }
        for r in runs
    ]
    trend = compute_trend(complete_runs)

    if not runs:
        return {"latest": None, "trend": trend}

    newest = runs[-1]
    previous = [r["results"] for r in runs[-1 - ZONE_CONFIG["trend_window"]:-1]]
    latest = {
        "surveyRunId": complete_runs[-1]["surveyRunId"],
        "date": complete_runs[-1]["date"],
        **_format(newest["scores"]),
        "signals": compute_signals(config, newest["results"], previous),
    }
    return {"latest": latest, "trend": trend}
