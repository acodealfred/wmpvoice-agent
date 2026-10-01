"""Fatigue ↔ Burnout zone — a wellbeing guide computed on demand from PILOT answers.

Pure functions: no DB, no network. Nothing here is persisted; every call recomputes
from the stored survey_results so a formula change applies to all history at once.
See docs/superpowers/specs/2026-10-01-fatigue-burnout-zone-design.md.
"""
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
