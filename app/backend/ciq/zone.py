"""Fatigue ↔ Burnout zone — a wellbeing guide computed on demand from PILOT answers.

Pure functions: no DB, no network. Nothing here is persisted; every call recomputes
from the stored survey_results so a formula change applies to all history at once.
See docs/superpowers/specs/2026-10-01-fatigue-burnout-zone-design.md.
"""
import json
import logging
from decimal import ROUND_HALF_UP, Decimal

from survey_loader import effective_score, get_score_bounds, options_for_question

logger = logging.getLogger("voicerag")

ZONE_CONFIG = {
    # Product judgement, not a validated factor structure (spec §2).
    "groups": {
        "fatigue": ["bat_q1", "bat_q3", "cbi_q1", "cbi_q2", "cbi_q3"],
        "burnout": ["bat_q2", "bat_q4"],
    },
    # severity < edge → zone; anything ≥ the last edge is "high".
    "zones": [(25, "well"), (50, "mild"), (75, "moderate")],
    "lean_cutoff": 15,
    "trend_dead_zone": 5,
    "trend_window": 3,
    "trend_points_max": 20,
    "blink_up_pct": 20,       # PDF fatigue/recovery row: blink rate +20–50 %
    "slower_ratio": 1.25,     # PDF latency "High": > +25 %
    "signal_min_items": 5,
}


class ZoneConfigError(Exception):
    """The PILOT survey config is unavailable (load_survey fell back to TEST, or it is malformed)."""


def round_half_up(x: float) -> int:
    return int(Decimal(str(x)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _item_ids() -> list[str]:
    groups = ZONE_CONFIG["groups"]
    return groups["fatigue"] + groups["burnout"]


def validate_config(config) -> None:
    if not isinstance(config, dict) or config.get("type") != "PILOT" or not config.get("scoringSections"):
        got = config.get("type") if isinstance(config, dict) else type(config).__name__
        raise ZoneConfigError(f"PILOT survey config unavailable (got {got!r})")


def _valid_score(config: dict, qid: str, raw) -> bool:
    if not isinstance(raw, int) or isinstance(raw, bool):
        return False
    allowed = {o.get("value") for o in options_for_question(config, qid)}
    return raw in allowed


def _strain(config: dict, qid: str, raw: int) -> float:
    lo, hi = get_score_bounds(config, qid)
    eff = effective_score(config, qid, raw)  # flips reverse items exactly once
    return (eff - lo) / (hi - lo) * 100


def _zone_for(severity: float) -> str:
    for edge, key in ZONE_CONFIG["zones"]:
        if severity < edge:
            return key
    return "high"


def compute_zone(config: dict, survey_results) -> dict | None:
    """Zone for one run, or None if the run is incomplete (spec §3)."""
    if not isinstance(survey_results, dict):
        return None
    strains: dict[str, float] = {}
    for qid in _item_ids():
        entry = survey_results.get(qid)
        raw = entry.get("score") if isinstance(entry, dict) else None
        if not _valid_score(config, qid, raw):
            return None
        strains[qid] = _strain(config, qid, raw)

    groups = ZONE_CONFIG["groups"]
    fatigue = sum(strains[q] for q in groups["fatigue"]) / len(groups["fatigue"])
    burnout = sum(strains[q] for q in groups["burnout"]) / len(groups["burnout"])
    severity = sum(strains.values()) / len(strains)
    zone = _zone_for(severity)
    lean_value = burnout - fatigue

    cutoff = ZONE_CONFIG["lean_cutoff"]
    if zone == "well":
        lean, marker = "none", None
    else:
        lean = "fatigue" if lean_value <= -cutoff else "burnout" if lean_value >= cutoff else "mixed"
        marker = round_half_up(50 + lean_value / 2)

    return {
        "fatigue": round_half_up(fatigue),
        "burnout": round_half_up(burnout),
        "severity": round_half_up(severity),
        "zone": zone,
        "lean": lean,
        "leanValue": round_half_up(lean_value),
        "marker": marker,
        "severityExact": severity,
    }


def compute_trend(runs: list[dict]) -> dict:
    """Improving / steady / worsening for the newest complete run (spec §4). `runs` oldest-first."""
    if not runs:
        return {"status": "none"}
    if len(runs) == 1:
        return {"status": "first"}
    window = ZONE_CONFIG["trend_window"]
    latest = runs[-1]["severityExact"]
    previous = [r["severityExact"] for r in runs[-1 - window:-1]]
    ref = sum(previous) / len(previous)
    delta = latest - ref
    dead = ZONE_CONFIG["trend_dead_zone"]
    status = "improving" if delta <= -dead else "worsening" if delta >= dead else "steady"
    return {"status": status, "delta": round_half_up(delta), "ref": round_half_up(ref), "compared": len(previous)}


def _parse_results(record: dict):
    raw = record.get("survey_results")
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw or None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("[Zone] unparseable survey_results for run %s — skipped", record.get("survey_run_id"))
        return None
    return parsed if isinstance(parsed, dict) and parsed else None


def _public(zone: dict) -> dict:
    return {k: v for k, v in zone.items() if k != "severityExact"}


def build_zone_trend(records: list[dict], config: dict) -> dict:
    """Latest zone + trend for one user's survey_records rows (any order). Spec §2–§5."""
    validate_config(config)
    complete = []
    for record in records:
        if (record.get("survey_type") or "").upper() != "PILOT":
            continue
        results = _parse_results(record)
        if results is None:
            continue
        zone = compute_zone(config, results)
        if zone is None:
            continue
        run_id = record.get("survey_run_id") or ""
        created = record.get("created_at") or ""
        complete.append({"key": (created, run_id), "results": results,
                         "zone": {"surveyRunId": run_id, "date": created[:10], **zone}})
    complete.sort(key=lambda c: c["key"])

    runs = [c["zone"] for c in complete]
    trend = compute_trend(runs)
    trend["points"] = [
        {k: r[k] for k in ("surveyRunId", "date", "severity", "zone", "lean")}
        for r in runs[-ZONE_CONFIG["trend_points_max"]:]
    ]
    latest = None
    if complete:
        latest = {**_public(runs[-1]), "signals": []}
    return {"latest": latest, "trend": trend}
