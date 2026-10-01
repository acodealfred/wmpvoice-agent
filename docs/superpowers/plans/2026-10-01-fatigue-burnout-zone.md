# Fatigue ↔ Burnout Zone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each employee a Fatigue ↔ Burnout scale, a strain zone and an Improving / Steady / Worsening trend, all calculated on demand from their stored PILOT survey answers.

**Architecture:**
- One pure backend module (`app/backend/ciq/zone.py`) turns stored `survey_results` into a zone per run, a trend and fatigue signals.
- One new authenticated endpoint (`GET /api/zone-trend`) and one new personal chat tool (`get_my_zone_trend`) call it.
- The frontend adds a pure helper (`lib/zone.ts`), three small components, a new card on the employee home screen, and a zone block in the session report. That block is fetched after `/analyze-report` has saved the run.
- Nothing new is persisted. `/analyze-report` and `survey_loader.py` are not modified.

**Tech Stack:**
- Backend: Python 3.12, aiohttp, aiosqlite, pytest 8 + pytest-asyncio (`asyncio_mode=auto`)
- Frontend: React 18 + TypeScript, Tailwind 3, recharts 2.15, Vitest 4 (node environment)

**Spec:** `docs/superpowers/specs/2026-10-01-fatigue-burnout-zone-design.md`. Read it before starting. §3–§5 hold the exact rules.

## Global Constraints

- **Survey scope:** PILOT only. A row counts only if `(survey_type or "").upper() == "PILOT"`.
- **Item groups:**
  - Fatigue = `bat_q1, bat_q3, cbi_q1, cbi_q2, cbi_q3`
  - Burnout = `bat_q2, bat_q4`
- **Validity:** each item score must be an `int`, not a `bool`, and a member of `options_for_question(config, qid)` values. Otherwise the run is incomplete and `compute_zone` returns `None`.
- **Strain:** `(effective_score − lo) / (hi − lo) × 100` with `lo, hi = get_score_bounds(config, qid)`.
- **Severity** = the mean strain of **all 7 items**.
- **Zones:** `< 25 well`, `< 50 mild`, `< 75 moderate`, `≥ 75 high`, decided on the unrounded value.
- **Lean:**
  - `leanValue = burnout − fatigue`
  - `≤ −15 fatigue`, `≥ +15 burnout`, else `mixed`
  - When the zone is `well`: `lean = "none"` and `marker = null`
- **Marker** = `50 + leanValue / 2`.
- **Rounding:** every returned number is rounded with `Decimal.quantize(Decimal("1"), ROUND_HALF_UP)`.
- **Trend:**
  - "Latest" is the newest **complete** run.
  - `ref` = the mean unrounded severity of the up to 3 complete runs before it.
  - `delta ≤ −5 improving`, `≥ +5 worsening`, else `steady`.
  - 0 runs gives `none`; 1 run gives `first`.
  - `points` holds the 20 most recent complete runs, oldest first.
- **Signals** (latest run only, never affect any score):
  - `blink_up`: the mean of usable `blinkRateChange` is `> 20`. Usable means numeric, not a `bool`, and `!= 0`.
  - `slower`: the median of usable `responseLatencyMs` (numeric, not a `bool`, `> 0`) is `≥ 1.25 ×` the median of the previous up to 3 complete runs' medians.
  - Each needs `≥ 5` usable items. For `slower`, each previous run also needs `≥ 5` usable latencies to contribute.
  - Labels are exactly `"Blink rate above your baseline"` and `"Slower responses than your recent check-ins"`, and both carry `"approximate": true`.
- **Copy:**
  - The disclaimer is exactly `A wellbeing guide, not a diagnosis.`
  - The empty state is exactly `Complete a check-in to see your zone`.
- **Privacy:** user identity comes only from `request["auth_session"]["user_id"]` or `auth.user_id`, never from request input.
- **Do not modify:**
  - `/analyze-report` (`ciq/reports/routes.py`)
  - `survey_loader.py`
  - `guest-score-trend.tsx`
  - the `get_my_score_trend` behaviour
  - manager screens and APIs
  - the existing `<motion.section>` in `guest-landing.tsx`
- **Owner rule:** every change ships with tests. Write tests first.
- **Commits:** end every commit message with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## Review Focus

These are inputs real users will hit that the spec implies but that are easy to miss. Each line names the task whose tests pin it.

1. **Voice model records a 1–5 answer on a CBI item** (e.g. `cbi_q1 = 3`). The run must be incomplete, not scored as 3% strain. Pinned in Task 1 (`test_invalid_scores_make_run_incomplete`).
2. **A user's newest run is half-finished or failed to save.** The zone must come from their previous complete run, and the session report must hide the scale rather than show an old run's zone as "this session". Pinned in Task 2 (`test_incomplete_newest_run_is_ignored`) and Task 7 (the run-ID match).
3. **Blink data missing (stored as `0`) for most questions.** The chip must be hidden, never shown as normal or as a low mean. Pinned in Task 3 (`test_blink_zero_and_bool_are_missing`).
4. **The PILOT survey file is broken in production**, so `load_survey` silently falls back to TEST. The endpoint must return 500 "zone unavailable", not an empty "no check-ins". Pinned in Task 1 (`test_validate_config`) and Task 4 (`test_zone_trend_500_when_pilot_config_missing`).
5. **Another user's runs, or the same user's TEST / demo / blank rows, in the database.** They must never appear in the caller's trend. Pinned in Task 4 (`test_zone_trend_only_callers_runs`, `test_zone_trend_skips_non_pilot_and_bad_rows`) and Task 5 (`test_dispatch_zone_tool_returns_only_callers_data`).

---

### Task 0: Environment and baseline (no commit)

**Files:** none changed.

- [ ] **Step 1: Confirm the branch**

Run: `cd "/Users/user/Documents/Devs/CIQ MVP/wmpvoice-agent" && git status -sb && git log --oneline -3`
Expected: `## feature/fatigue-burnout-zone`, a clean tree, and the two spec commits on top of `597b662`.

- [ ] **Step 2: Backend virtualenv**

Run:
```bash
cd "/Users/user/Documents/Devs/CIQ MVP/wmpvoice-agent/app/backend"
python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
```
- If any pinned package fails to build on the local Python (3.13), use 3.12 instead:
  `uv venv --python 3.12 .venv && uv pip install -p .venv -r requirements.txt` (install `uv` with `brew install uv` if needed).
- Check that `.venv` is git-ignored: `git check-ignore .venv`. If it isn't, don't add it; leave it untracked.

- [ ] **Step 3: Backend baseline**

Run: `.venv/bin/python -m pytest -q`
Expected: all existing tests pass. Record the count, for example `NN passed`. If anything fails **before** any change, stop and report it to the owner; do not fix unrelated failures.

- [ ] **Step 4: Frontend install and baseline**

Run:
```bash
cd "/Users/user/Documents/Devs/CIQ MVP/wmpvoice-agent/app/frontend"
npm ci || npm install
npm test
npx tsc -b
```
Expected: Vitest passes and `tsc -b` exits 0. Record both. Pre-existing failures are reported, not fixed.

---

### Task 1: Zone scoring core (`compute_zone`, config guard)

**Files:**
- Create: `app/backend/ciq/zone.py`
- Test: `app/backend/tests/unit/test_zone.py`

**Interfaces:**
- Consumes: `survey_loader.effective_score(config, qid, raw) -> int`, `survey_loader.get_score_bounds(config, qid) -> (int, int)`, `survey_loader.options_for_question(config, qid) -> list[dict]`
- Produces:
  - `ZONE_CONFIG: dict`
  - `class ZoneConfigError(Exception)`
  - `validate_config(config: dict) -> None` (raises `ZoneConfigError`)
  - `compute_zone(config: dict, survey_results: dict) -> dict | None`. It returns keys `fatigue, burnout, severity, zone, lean, leanValue, marker` (rounded ints, or `None` for `marker`) plus `severityExact: float` (internal; it is removed before anything leaves the module in Task 2).
  - `round_half_up(x: float) -> int`

- [ ] **Step 1: Write the failing tests**

Create `app/backend/tests/unit/test_zone.py`:

```python
"""Fatigue ↔ Burnout zone — scoring rules (spec 2026-10-01 §3)."""
import pytest

from survey_loader import load_survey
from ciq.zone import ZONE_CONFIG, ZoneConfigError, compute_zone, round_half_up, validate_config

PILOT = load_survey("PILOT")
TEST = load_survey("TEST")

# Lowest-strain answer per item (cbi_q3 is reverse-scored, so 100 = no strain).
MIN = {"bat_q1": 1, "bat_q2": 1, "bat_q3": 1, "bat_q4": 1, "cbi_q1": 0, "cbi_q2": 0, "cbi_q3": 100}
MAX = {"bat_q1": 5, "bat_q2": 5, "bat_q3": 5, "bat_q4": 5, "cbi_q1": 100, "cbi_q2": 100, "cbi_q3": 0}
# One answer step = +25 strain on that item.
STEP = {"bat_q1": 1, "bat_q2": 1, "bat_q3": 1, "bat_q4": 1, "cbi_q1": 25, "cbi_q2": 25, "cbi_q3": -25}
ORDER = ["bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]

# Worked example from spec §3.
EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}


def results(scores: dict) -> dict:
    """Build a survey_results blob shaped like survey_loader.serialize_survey_results."""
    return {
        qid: {"score": s, "domain": "x", "userResponse": "", "voiceSentiment": "neutral",
              "blinkRateChange": 0, "leftGazePosition": "Center", "rightGazePosition": "Center",
              "responseLatencyMs": None}
        for qid, s in scores.items()
    }


def steps(k: int) -> dict:
    """Answers with exactly k answer-steps of strain, spread round-robin (severity = 25k/7)."""
    s = dict(MIN)
    for i in range(k):
        q = ORDER[i % 7]
        s[q] += STEP[q]
    return s


# ── config ────────────────────────────────────────────────────────────────

def test_groups_cover_exactly_the_pilot_questions():
    ids = [q["id"] for q in PILOT["questions"]]
    grouped = ZONE_CONFIG["groups"]["fatigue"] + ZONE_CONFIG["groups"]["burnout"]
    assert sorted(grouped) == sorted(ids)
    assert len(set(grouped)) == len(grouped)


def test_validate_config():
    validate_config(PILOT)  # no raise
    with pytest.raises(ZoneConfigError):
        validate_config(TEST)  # what load_survey("PILOT") silently returns when the file is broken
    with pytest.raises(ZoneConfigError):
        validate_config({**PILOT, "scoringSections": []})
    with pytest.raises(ZoneConfigError):
        validate_config(None)


# ── strain + groups ───────────────────────────────────────────────────────

def test_all_min_is_zero_strain():
    z = compute_zone(PILOT, results(MIN))
    assert (z["fatigue"], z["burnout"], z["severity"]) == (0, 0, 0)


def test_all_max_is_full_strain():
    z = compute_zone(PILOT, results(MAX))
    assert (z["fatigue"], z["burnout"], z["severity"]) == (100, 100, 100)
    assert z["zone"] == "high"


def test_cbi13_reversed_exactly_once():
    z = compute_zone(PILOT, results({**MIN, "cbi_q3": 0}))  # raw 0 on a reverse item = full strain
    assert z["fatigue"] == 20  # 100 / 5 fatigue items
    assert z["burnout"] == 0


def test_worked_example_from_spec():
    z = compute_zone(PILOT, results(EXAMPLE))
    assert z["fatigue"] == 50
    assert z["burnout"] == 25
    assert z["severity"] == 43          # 300 / 7 = 42.857…
    assert z["zone"] == "mild"
    assert z["lean"] == "fatigue"
    assert z["leanValue"] == -25
    assert z["marker"] == 38            # 37.5 rounds half-up
    assert z["severityExact"] == pytest.approx(300 / 7)


def test_severity_is_item_weighted_not_group_weighted():
    # 2 burnout steps only: item-weighted = 50/7 ≈ 7.14; group-weighted would be 12.5.
    z = compute_zone(PILOT, results({**MIN, "bat_q2": 2, "bat_q4": 2}))
    assert z["severityExact"] == pytest.approx(50 / 7)


# ── validity ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("override", [
    {"cbi_q1": 3},        # BAT-scale value on a CBI item — in the shared tool enum
    {"bat_q1": 25},       # CBI-scale value on a BAT item
    {"bat_q1": True},     # bool is an int subclass in Python
    {"bat_q1": None},
    {"bat_q1": "4"},
    {"bat_q1": 4.0},      # float, not int
    {"cbi_q2": 60},       # in 0–100 range but not an option value
])
def test_invalid_scores_make_run_incomplete(override):
    assert compute_zone(PILOT, results({**EXAMPLE, **override})) is None


def test_missing_item_makes_run_incomplete():
    partial = dict(EXAMPLE)
    del partial["bat_q4"]
    assert compute_zone(PILOT, results(partial)) is None


@pytest.mark.parametrize("blob", [None, {}, "not a dict", {"bat_q1": "not a dict"}])
def test_malformed_results_are_incomplete(blob):
    assert compute_zone(PILOT, blob) is None


# ── zones (severity = 25k/7, so 25/50/75 are hit exactly at k = 7/14/21) ──

@pytest.mark.parametrize("k,zone", [
    (0, "well"), (6, "well"), (7, "mild"), (13, "mild"),
    (14, "moderate"), (20, "moderate"), (21, "high"), (28, "high"),
])
def test_zone_boundaries(k, zone):
    assert compute_zone(PILOT, results(steps(k)))["zone"] == zone


# ── lean ──────────────────────────────────────────────────────────────────

def test_lean_exactly_minus_15_is_fatigue():
    # burnout 25, fatigue 40 → lean −15, severity 250/7 (mild)
    s = {"bat_q1": 5, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 0, "cbi_q3": 100, "bat_q2": 2, "bat_q4": 2}
    z = compute_zone(PILOT, results(s))
    assert (z["zone"], z["lean"], z["leanValue"]) == ("mild", "fatigue", -15)


def test_lean_minus_12_5_is_mixed():
    # burnout 37.5, fatigue 50 → lean −12.5 (rounds half-up away from zero to −13)
    s = {"bat_q1": 5, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 100, "bat_q2": 3, "bat_q4": 2}
    z = compute_zone(PILOT, results(s))
    assert (z["lean"], z["leanValue"]) == ("mixed", -13)


def test_lean_plus_12_5_is_mixed():
    # burnout 62.5, fatigue 50 → lean +12.5
    s = {"bat_q1": 5, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 100, "bat_q2": 4, "bat_q4": 3}
    z = compute_zone(PILOT, results(s))
    assert (z["zone"], z["lean"], z["leanValue"]) == ("moderate", "mixed", 13)


def test_lean_exactly_plus_15_is_burnout():
    # burnout 50, fatigue 35 → lean +15
    s = {"bat_q1": 4, "bat_q3": 3, "cbi_q1": 50, "cbi_q2": 0, "cbi_q3": 100, "bat_q2": 3, "bat_q4": 3}
    z = compute_zone(PILOT, results(s))
    assert (z["lean"], z["leanValue"]) == ("burnout", 15)


def test_well_zone_has_no_lean_and_no_marker():
    z = compute_zone(PILOT, results({**MIN, "bat_q2": 3}))  # burnout-heavy but tiny overall
    assert z["zone"] == "well"
    assert z["lean"] == "none"
    assert z["marker"] is None
    assert z["leanValue"] == 25


def test_marker_extremes():
    # Pure fatigue: all fatigue items max, burnout min → lean −100 → marker 0
    z = compute_zone(PILOT, results({**MAX, "bat_q2": 1, "bat_q4": 1}))
    assert z["marker"] == 0
    # Pure burnout: burnout max, fatigue min → lean +100 → marker 100
    z = compute_zone(PILOT, results({**MIN, "bat_q2": 5, "bat_q4": 5}))
    assert z["marker"] == 100


# ── rounding ──────────────────────────────────────────────────────────────

def test_round_half_up():
    assert round_half_up(12.5) == 13
    assert round_half_up(37.5) == 38
    assert round_half_up(42.857142857142854) == 43
    assert round_half_up(-12.5) == -13


def test_burnout_12_5_reports_13():
    z = compute_zone(PILOT, results({**EXAMPLE, "bat_q2": 2, "bat_q4": 1}))
    assert z["burnout"] == 13
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `cd app/backend && .venv/bin/python -m pytest tests/unit/test_zone.py -q`
Expected: collection error `ModuleNotFoundError: No module named 'ciq.zone'`.

- [ ] **Step 3: Write the minimal implementation**

Create `app/backend/ciq/zone.py`:

```python
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
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `.venv/bin/python -m pytest tests/unit/test_zone.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/ciq/zone.py app/backend/tests/unit/test_zone.py
git commit -m "feat(zone): fatigue-burnout zone scoring from PILOT answers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Trend and record pipeline (`compute_trend`, `build_zone_trend`)

**Files:**
- Modify: `app/backend/ciq/zone.py` (append)
- Test: `app/backend/tests/unit/test_zone_trend_unit.py`

**Interfaces:**
- Consumes: `compute_zone`, `validate_config`, `round_half_up`, `ZONE_CONFIG` (Task 1)
- Produces:
  - `compute_trend(runs: list[dict]) -> dict`. `runs` is oldest-first and each run has `severityExact`. It returns `{"status": ...}` plus `delta, ref, compared` when `status` is `improving` / `steady` / `worsening`.
  - `build_zone_trend(records: list[dict], config: dict) -> {"latest": dict | None, "trend": dict}`.
    - `records` are raw rows from `db.get_user_survey_records`, where `survey_results` is a JSON string.
    - `latest` keys: `surveyRunId, date, fatigue, burnout, severity, zone, lean, leanValue, marker, signals`.
    - `trend` always includes `points: [{surveyRunId, date, severity, zone, lean}]`.
    - No `severityExact` anywhere in the output.
  - In this task `signals` is always `[]`; Task 3 fills it.

- [ ] **Step 1: Write the failing tests**

Create `app/backend/tests/unit/test_zone_trend_unit.py`:

```python
"""Fatigue ↔ Burnout zone — trend + record pipeline (spec 2026-10-01 §4)."""
import json

import pytest

from survey_loader import load_survey
from ciq.zone import ZoneConfigError, build_zone_trend, compute_trend

PILOT = load_survey("PILOT")
TEST = load_survey("TEST")

EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}
MIN = {"bat_q1": 1, "bat_q2": 1, "bat_q3": 1, "bat_q4": 1, "cbi_q1": 0, "cbi_q2": 0, "cbi_q3": 100}


def blob(scores, blink=0, latency=None):
    return {qid: {"score": s, "blinkRateChange": blink, "responseLatencyMs": latency} for qid, s in scores.items()}


def rec(run_id, created_at, scores=None, survey_type="PILOT", raw=None):
    return {
        "survey_run_id": run_id,
        "created_at": created_at,
        "survey_type": survey_type,
        "survey_results": raw if raw is not None else json.dumps(blob(scores)),
    }


def runs(*sevs):
    return [{"severityExact": s} for s in sevs]


# ── compute_trend ─────────────────────────────────────────────────────────

def test_trend_none_and_first():
    assert compute_trend([]) == {"status": "none"}
    assert compute_trend(runs(40)) == {"status": "first"}


@pytest.mark.parametrize("sevs,status,delta,ref,compared", [
    ((40, 50), "worsening", 10, 40, 1),
    ((50, 45), "improving", -5, 50, 1),        # exactly −5 → improving
    ((50, 55), "worsening", 5, 50, 1),         # exactly +5 → worsening
    ((50, 45.5), "steady", -5, 50, 1),         # −4.5 → steady (delta still rounds to −5 for display)
    ((50, 54.9), "steady", 5, 50, 1),
    ((20, 30, 40, 24), "improving", -6, 30, 3),
    ((10, 20, 30, 40, 30), "steady", 0, 30, 3),  # window is the 3 runs before the latest
])
def test_trend_rules(sevs, status, delta, ref, compared):
    t = compute_trend(runs(*sevs))
    assert t == {"status": status, "delta": delta, "ref": ref, "compared": compared}


def test_one_answer_change_is_steady_two_is_not():
    # Item-weighted: one answer step = 25/7 ≈ 3.57; two = 7.14 (owner decision 2026-10-01).
    one = 25 / 7
    assert compute_trend(runs(50, 50 - one))["status"] == "steady"
    assert compute_trend(runs(50, 50 - 2 * one))["status"] == "improving"
    assert compute_trend(runs(50, 50 + 2 * one))["status"] == "worsening"


# ── build_zone_trend ──────────────────────────────────────────────────────

def test_build_empty():
    out = build_zone_trend([], PILOT)
    assert out == {"latest": None, "trend": {"status": "none", "points": []}}


def test_build_sorts_desc_input_oldest_first():
    recs = [  # newest first, as db.get_user_survey_records returns them
        rec("r3", "2026-09-03T10:00:00", MIN),
        rec("r2", "2026-09-02T10:00:00", EXAMPLE),
        rec("r1", "2026-09-01T10:00:00", EXAMPLE),
    ]
    out = build_zone_trend(recs, PILOT)
    assert [p["surveyRunId"] for p in out["trend"]["points"]] == ["r1", "r2", "r3"]
    assert out["latest"]["surveyRunId"] == "r3"
    assert out["latest"]["date"] == "2026-09-03"
    assert out["trend"]["status"] == "improving"  # 0 vs ref 42.86


def test_incomplete_newest_run_is_ignored():
    partial = dict(EXAMPLE)
    del partial["bat_q1"]
    recs = [rec("new", "2026-09-02T10:00:00", partial), rec("old", "2026-09-01T10:00:00", EXAMPLE)]
    out = build_zone_trend(recs, PILOT)
    assert out["latest"]["surveyRunId"] == "old"
    assert out["trend"]["status"] == "first"


@pytest.mark.parametrize("bad", [
    rec("t", "2026-09-05T00:00:00", EXAMPLE, survey_type="TEST"),
    rec("e", "2026-09-05T00:00:00", EXAMPLE, survey_type=""),
    rec("n", "2026-09-05T00:00:00", EXAMPLE, survey_type=None),
    rec("d", "2026-09-05T00:00:00", raw="{}"),
    rec("z", "2026-09-05T00:00:00", raw=""),
    {"survey_run_id": "null", "created_at": "2026-09-05T00:00:00", "survey_type": "PILOT", "survey_results": None},
    rec("m", "2026-09-05T00:00:00", raw="not json"),
    rec("l", "2026-09-05T00:00:00", raw="[1, 2]"),
])
def test_build_skips_non_pilot_and_bad_rows(bad):
    out = build_zone_trend([bad, rec("ok", "2026-09-01T00:00:00", EXAMPLE)], PILOT)
    assert [p["surveyRunId"] for p in out["trend"]["points"]] == ["ok"]


def test_build_accepts_lowercase_pilot_type():
    out = build_zone_trend([rec("a", "2026-09-01T00:00:00", EXAMPLE, survey_type="pilot")], PILOT)
    assert out["latest"]["surveyRunId"] == "a"


def test_build_accepts_already_parsed_results():
    r = rec("a", "2026-09-01T00:00:00", EXAMPLE)
    r["survey_results"] = json.loads(r["survey_results"])
    assert build_zone_trend([r], PILOT)["latest"]["surveyRunId"] == "a"


def test_points_capped_at_20_most_recent():
    recs = [rec(f"r{i:02d}", f"2026-08-{i:02d}T00:00:00", EXAMPLE) for i in range(1, 26)]
    pts = build_zone_trend(recs, PILOT)["trend"]["points"]
    assert len(pts) == 20
    assert pts[0]["surveyRunId"] == "r06" and pts[-1]["surveyRunId"] == "r25"


def test_output_shape_has_no_internal_keys():
    out = build_zone_trend([rec("a", "2026-09-01T00:00:00", EXAMPLE)], PILOT)
    assert set(out["latest"]) == {"surveyRunId", "date", "fatigue", "burnout", "severity",
                                  "zone", "lean", "leanValue", "marker", "signals"}
    assert set(out["trend"]["points"][0]) == {"surveyRunId", "date", "severity", "zone", "lean"}


def test_tie_on_created_at_breaks_by_run_id():
    recs = [rec("b", "2026-09-01T00:00:00", MIN), rec("a", "2026-09-01T00:00:00", EXAMPLE)]
    assert build_zone_trend(recs, PILOT)["latest"]["surveyRunId"] == "b"


def test_build_rejects_fallback_config():
    with pytest.raises(ZoneConfigError):
        build_zone_trend([rec("a", "2026-09-01T00:00:00", EXAMPLE)], TEST)
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `.venv/bin/python -m pytest tests/unit/test_zone_trend_unit.py -q`
Expected: `ImportError: cannot import name 'build_zone_trend'`.

- [ ] **Step 3: Implement**

Append to `app/backend/ciq/zone.py`. Also add `import json` to the imports at the top of the file.

```python
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
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `.venv/bin/python -m pytest tests/unit/test_zone.py tests/unit/test_zone_trend_unit.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/ciq/zone.py app/backend/tests/unit/test_zone_trend_unit.py
git commit -m "feat(zone): trend vs previous runs and record pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fatigue signals (`compute_signals`)

**Files:**
- Modify: `app/backend/ciq/zone.py`
- Test: `app/backend/tests/unit/test_zone_signals.py`

**Interfaces:**
- Consumes: `ZONE_CONFIG`, `build_zone_trend` (Task 2)
- Produces:
  - `compute_signals(latest_results: dict, previous_results: list[dict]) -> list[dict]`. Each item is `{"key", "label", "approximate": True}`, in the order `blink_up`, then `slower`.
  - `build_zone_trend` now fills `latest["signals"]`.
  - The spec listed a `config` parameter; it is dropped because it is unused (YAGNI).

- [ ] **Step 1: Write the failing tests**

Create `app/backend/tests/unit/test_zone_signals.py`:

```python
"""Fatigue ↔ Burnout zone — supporting fatigue signals (spec 2026-10-01 §5)."""
import json

from survey_loader import load_survey
from ciq.zone import build_zone_trend, compute_signals

PILOT = load_survey("PILOT")
IDS = ["bat_q1", "bat_q2", "bat_q3", "bat_q4", "cbi_q1", "cbi_q2", "cbi_q3"]
EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}


def blob(blinks=None, lats=None, scores=EXAMPLE):
    """blinks / lats: list of 7 per-item values (or None → serializer defaults 0 / None)."""
    blinks = blinks or [0] * 7
    lats = lats or [None] * 7
    return {q: {"score": scores[q], "blinkRateChange": b, "responseLatencyMs": l}
            for q, b, l in zip(IDS, blinks, lats)}


def keys(signals):
    return [s["key"] for s in signals]


# ── blink_up ──────────────────────────────────────────────────────────────

def test_blink_mean_exactly_20_is_hidden():
    assert keys(compute_signals(blob(blinks=[20] * 7), [])) == []


def test_blink_mean_above_20_is_shown():
    sig = compute_signals(blob(blinks=[20.1] * 7), [])
    assert sig == [{"key": "blink_up", "label": "Blink rate above your baseline", "approximate": True}]


def test_blink_zero_and_bool_are_missing():
    # 3 zeros + 1 bool → only 3 usable → below the 5-item minimum → hidden
    assert keys(compute_signals(blob(blinks=[30, 30, 30, 0, 0, 0, True]), [])) == []


def test_blink_five_usable_is_enough():
    assert keys(compute_signals(blob(blinks=[30, 30, 30, 30, 30, 0, 0]), [])) == ["blink_up"]


def test_blink_below_baseline_is_not_a_signal():
    assert keys(compute_signals(blob(blinks=[-50] * 7), [])) == []


# ── slower ────────────────────────────────────────────────────────────────

def test_slower_needs_a_previous_run():
    assert keys(compute_signals(blob(lats=[5000] * 7), [])) == []


def test_slower_at_exactly_25_percent():
    prev = [blob(lats=[1000] * 7)]
    assert keys(compute_signals(blob(lats=[1250] * 7), prev)) == ["slower"]
    assert keys(compute_signals(blob(lats=[1249] * 7), prev)) == []


def test_slower_uses_median_of_previous_medians():
    prev = [blob(lats=[1000] * 7), blob(lats=[2000] * 7), blob(lats=[3000] * 7)]  # medians → 2000
    assert keys(compute_signals(blob(lats=[2500] * 7), prev)) == ["slower"]
    assert keys(compute_signals(blob(lats=[2400] * 7), prev)) == []


def test_slower_ignores_previous_runs_with_too_few_latencies():
    prev = [blob(lats=[1000, 1000, 1000, None, None, None, None])]
    assert keys(compute_signals(blob(lats=[5000] * 7), prev)) == []


def test_slower_ignores_non_positive_and_bool_latency():
    latest = blob(lats=[5000, 5000, 5000, 5000, 0, -1, True])  # only 4 usable
    assert keys(compute_signals(latest, [blob(lats=[1000] * 7)])) == []


def test_both_signals_in_fixed_order():
    sig = compute_signals(blob(blinks=[30] * 7, lats=[2000] * 7), [blob(lats=[1000] * 7)])
    assert keys(sig) == ["blink_up", "slower"]
    assert sig[1]["label"] == "Slower responses than your recent check-ins"


# ── wiring + independence from the score ──────────────────────────────────

def _rec(run_id, created, b):
    return {"survey_run_id": run_id, "created_at": created, "survey_type": "PILOT",
            "survey_results": json.dumps(b)}


def test_build_attaches_signals_to_latest_only():
    recs = [
        _rec("new", "2026-09-02T00:00:00", blob(blinks=[30] * 7, lats=[2000] * 7)),
        _rec("old", "2026-09-01T00:00:00", blob(lats=[1000] * 7)),
    ]
    out = build_zone_trend(recs, PILOT)
    assert keys(out["latest"]["signals"]) == ["blink_up", "slower"]
    assert all("signals" not in p for p in out["trend"]["points"])


def test_signals_never_change_the_score_or_trend():
    calm = [_rec("b", "2026-09-02T00:00:00", blob()), _rec("a", "2026-09-01T00:00:00", blob())]
    busy = [_rec("b", "2026-09-02T00:00:00", blob(blinks=[90] * 7, lats=[9000] * 7)),
            _rec("a", "2026-09-01T00:00:00", blob(lats=[1000] * 7))]
    c, b = build_zone_trend(calm, PILOT), build_zone_trend(busy, PILOT)
    strip = lambda o: {**o["latest"], "signals": None}
    assert strip(c) == strip(b)
    assert c["trend"] == b["trend"]
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `.venv/bin/python -m pytest tests/unit/test_zone_signals.py -q`
Expected: `ImportError: cannot import name 'compute_signals'`.

- [ ] **Step 3: Implement**

In `app/backend/ciq/zone.py`, add `import statistics` to the imports. Then add these functions above `build_zone_trend`:

```python
_SIGNAL_LABELS = {
    "blink_up": "Blink rate above your baseline",
    "slower": "Slower responses than your recent check-ins",
}


def _number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v  # excludes NaN


def _usable(results: dict, field: str, ok) -> list[float]:
    out = []
    for qid in _item_ids():
        entry = results.get(qid)
        v = entry.get(field) if isinstance(entry, dict) else None
        if _number(v) and ok(v):
            out.append(float(v))
    return out


def _blinks(results: dict) -> list[float]:
    return _usable(results, "blinkRateChange", lambda v: v != 0)  # serializer stores missing as 0


def _latencies(results: dict) -> list[float]:
    return _usable(results, "responseLatencyMs", lambda v: v > 0)


def compute_signals(latest_results: dict, previous_results: list[dict]) -> list[dict]:
    """Supporting fatigue chips for the latest run. Never affects any score (spec §5)."""
    need = ZONE_CONFIG["signal_min_items"]
    signals = []

    blinks = _blinks(latest_results)
    if len(blinks) >= need and sum(blinks) / len(blinks) > ZONE_CONFIG["blink_up_pct"]:
        signals.append("blink_up")

    lats = _latencies(latest_results)
    prev_medians = [statistics.median(l) for l in map(_latencies, previous_results) if len(l) >= need]
    if len(lats) >= need and prev_medians:
        if statistics.median(lats) >= ZONE_CONFIG["slower_ratio"] * statistics.median(prev_medians):
            signals.append("slower")

    return [{"key": k, "label": _SIGNAL_LABELS[k], "approximate": True} for k in signals]
```

In `build_zone_trend`, replace:

```python
    if complete:
        latest = {**_public(runs[-1]), "signals": []}
```

with:

```python
    if complete:
        window = ZONE_CONFIG["trend_window"]
        previous = [c["results"] for c in complete[-1 - window:-1]]
        latest = {**_public(runs[-1]), "signals": compute_signals(complete[-1]["results"], previous)}
```

- [ ] **Step 4: Run all the zone unit tests**

Run: `.venv/bin/python -m pytest tests/unit/test_zone.py tests/unit/test_zone_trend_unit.py tests/unit/test_zone_signals.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/ciq/zone.py app/backend/tests/unit/test_zone_signals.py
git commit -m "feat(zone): approximate blink and response-time fatigue signals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `GET /api/zone-trend` endpoint

**Files:**
- Modify: `app/backend/ciq/api/history_routes.py` (add imports, a logger and a new handler at the end of the file)
- Modify: `app/backend/ciq/server.py:148` (add one route line)
- Test: `app/backend/tests/integration/test_zone_trend.py`

**Interfaces:**
- Consumes: `build_zone_trend`, `ZoneConfigError` (Tasks 1–3); `db.get_user_survey_records(user_id)`; `survey_loader.load_survey`
- Produces: `async def user_zone_trend(request) -> web.Response`, which returns `200 {latest, trend}`, `401` (middleware) or `500 {"error": "zone unavailable"}`. The test helpers `insert_run` and `user_id` live in this test file and are reused by Task 5.

- [ ] **Step 1: Write the failing tests**

Create `app/backend/tests/integration/test_zone_trend.py`:

```python
"""Fatigue ↔ Burnout zone — GET /api/zone-trend (spec 2026-10-01 §6.1, §7)."""
import json

import aiohttp
import aiosqlite
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

EXAMPLE = {"bat_q1": 4, "bat_q2": 2, "bat_q3": 3, "bat_q4": 2, "cbi_q1": 50, "cbi_q2": 50, "cbi_q3": 75}
HIGH = {"bat_q1": 5, "bat_q2": 5, "bat_q3": 5, "bat_q4": 5, "cbi_q1": 100, "cbi_q2": 100, "cbi_q3": 0}


async def user_id(name: str) -> str:
    from db import get_user_by_name
    return (await get_user_by_name(name))["user_id"]


async def insert_run(uid, run_id, created_at, scores=None, survey_type="PILOT", raw=None):
    """Insert a survey_records row directly (the seeded DB has none)."""
    import db
    payload = raw if raw is not None else json.dumps(
        {q: {"score": s, "blinkRateChange": 0, "responseLatencyMs": None} for q, s in scores.items()}
    )
    async with aiosqlite.connect(db.DB_PATH) as conn:
        await conn.execute(
            """INSERT INTO survey_records
               (survey_run_id, user_id, session_token, session_id, survey_type,
                created_at, updated_at, survey_results)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, uid, None, "s", survey_type, created_at, created_at, payload),
        )
        await conn.commit()


@pytest_asyncio.fixture
async def zone_client(initialized_db):
    from auth import auth_middleware, login
    from ciq.api.history_routes import user_zone_trend

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/login", login)
    app.router.add_get("/api/zone-trend", user_zone_trend)
    async with TestClient(TestServer(app), cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
        yield client


async def _login(client, name):
    resp = await client.post("/login", json={"username": name, "password": "sys123"})
    assert resp.status == 200


async def test_zone_trend_requires_login(zone_client):
    resp = await zone_client.get("/api/zone-trend")
    assert resp.status == 401


async def test_zone_trend_empty_for_new_user(zone_client):
    await _login(zone_client, "guest1")
    resp = await zone_client.get("/api/zone-trend")
    assert resp.status == 200
    assert await resp.json() == {"latest": None, "trend": {"status": "none", "points": []}}


async def test_zone_trend_only_callers_runs(zone_client):
    g1, g2 = await user_id("guest1"), await user_id("guest2")
    await insert_run(g1, "g1-a", "2026-09-01T00:00:00", EXAMPLE)
    await insert_run(g1, "g1-b", "2026-09-02T00:00:00", EXAMPLE)
    await insert_run(g2, "g2-a", "2026-09-03T00:00:00", HIGH)

    await _login(zone_client, "guest1")
    body = await (await zone_client.get("/api/zone-trend")).json()
    assert [p["surveyRunId"] for p in body["trend"]["points"]] == ["g1-a", "g1-b"]
    assert body["latest"]["surveyRunId"] == "g1-b"
    assert body["trend"]["status"] == "steady"


async def test_zone_trend_ignores_user_id_in_query(zone_client):
    g2 = await user_id("guest2")
    await insert_run(g2, "g2-a", "2026-09-03T00:00:00", HIGH)
    await _login(zone_client, "guest1")
    body = await (await zone_client.get(f"/api/zone-trend?user_id={g2}")).json()
    assert body["latest"] is None


async def test_zone_trend_skips_non_pilot_and_bad_rows(zone_client):
    g1 = await user_id("guest1")
    await insert_run(g1, "ok", "2026-09-01T00:00:00", EXAMPLE)
    await insert_run(g1, "test", "2026-09-02T00:00:00", EXAMPLE, survey_type="TEST")
    await insert_run(g1, "blank", "2026-09-03T00:00:00", EXAMPLE, survey_type="")
    await insert_run(g1, "demo", "2026-09-04T00:00:00", raw="{}")
    await insert_run(g1, "broken", "2026-09-05T00:00:00", raw="not json")

    await _login(zone_client, "guest1")
    body = await (await zone_client.get("/api/zone-trend")).json()
    assert [p["surveyRunId"] for p in body["trend"]["points"]] == ["ok"]


async def test_zone_trend_500_when_pilot_config_missing(zone_client, monkeypatch):
    import survey_loader
    monkeypatch.setitem(survey_loader.SURVEY_MAP, "PILOT", "surveys/does-not-exist.json")
    await _login(zone_client, "guest1")
    resp = await zone_client.get("/api/zone-trend")
    assert resp.status == 500
    assert await resp.json() == {"error": "zone unavailable"}
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `.venv/bin/python -m pytest tests/integration/test_zone_trend.py -q`
Expected: `ImportError: cannot import name 'user_zone_trend'`.

- [ ] **Step 3: Implement the handler**

In `app/backend/ciq/api/history_routes.py`:

1. Add `import logging` with the other stdlib imports at the top (after `import json`).
2. After the existing `from survey_loader import compute_survey_summary, effective_score, load_survey` line, add:

```python
from ciq.zone import ZoneConfigError, build_zone_trend

logger = logging.getLogger("voicerag")
```

3. Append at the end of the file:

```python
async def user_zone_trend(request: web.Request) -> web.Response:
    """GET /api/zone-trend — the logged-in user's Fatigue ↔ Burnout zone and trend.

    Identity comes from the auth session only; nothing in the request selects the user.
    """
    user_id = request["auth_session"]["user_id"]
    records = await get_user_survey_records(user_id)
    try:
        result = build_zone_trend(records, load_survey("PILOT"))
    except ZoneConfigError:
        logger.exception("[Zone] PILOT survey config unavailable")
        return web.json_response({"error": "zone unavailable"}, status=500)
    return web.json_response(result)
```

- [ ] **Step 4: Register the route**

In `app/backend/ciq/server.py`:
- Add `user_zone_trend` to the existing import from `ciq.api.history_routes`. Find it with `grep -n "user_sessions_history" app/backend/ciq/server.py`.
- Directly below `app.router.add_get("/api/history", user_sessions_history)`, add:

```python
    app.router.add_get("/api/zone-trend", user_zone_trend)
```

- [ ] **Step 5: Run the tests, plus a smoke check that the server module imports**

Run:
```bash
.venv/bin/python -m pytest tests/integration/test_zone_trend.py -q
.venv/bin/python -c "import ciq.server"
```
Expected: all tests pass and the import exits 0.

- [ ] **Step 6: Commit**

```bash
git add app/backend/ciq/api/history_routes.py app/backend/ciq/server.py app/backend/tests/integration/test_zone_trend.py
git commit -m "feat(zone): GET /api/zone-trend for the logged-in user

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Chat tool `get_my_zone_trend` and the approved prompt line

**Files:**
- Modify: `app/backend/ciq/chat/tools.py` (imports; append to `GUEST_TOOL_SCHEMAS` before `_SEARCH_RESEARCH`; add a new `dispatch_tool` branch)
- Modify: `app/backend/ciq/chat/rbac.py:31-35` (one `TOOL_ACCESS` entry)
- Modify: `app/backend/ciq/chat/prompts.py:28-29` (the owner-approved line)
- Test: `app/backend/tests/integration/test_zone_chat_tool.py`

**Interfaces:**
- Consumes: `build_zone_trend`, `ZoneConfigError`; `load_survey`; `ChatAuth(user_id, role, scope)`; the `insert_run` and `user_id` helpers from `tests/integration/test_zone_trend.py`
- Produces: a tool named `get_my_zone_trend`, returning the same JSON as the endpoint, or `{"error": "zone unavailable"}`

- [ ] **Step 1: Write the failing tests**

Create `app/backend/tests/integration/test_zone_chat_tool.py`:

```python
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
```

Do **not** add `__init__.py` files to `tests/`. That would change how pytest imports every existing test.

- [ ] **Step 2: Run the tests to check they fail**

Run: `.venv/bin/python -m pytest tests/integration/test_zone_chat_tool.py -q`
Expected:
- `test_guest_schemas_include_zone_tool` and the prompt test fail on their assertions.
- The dispatch tests fail with `{"error": "not authorized…"}` (the tool isn't in `TOOL_ACCESS` yet).
- The regression test passes.

- [ ] **Step 3: Implement**

**3a.** In `app/backend/ciq/chat/rbac.py`, below `"get_my_latest_report": _PERSONAL,`, add:

```python
    "get_my_zone_trend": _PERSONAL,
```

**3b.** In `app/backend/ciq/chat/tools.py`, add these imports below `from ciq.kb.mithra_client import call_mithra_kb_chat`:

```python
from ciq.zone import ZoneConfigError, build_zone_trend
from survey_loader import load_survey
```

**3c.** In `GUEST_TOOL_SCHEMAS`, insert this immediately **before** the final `_SEARCH_RESEARCH,` entry of that list (the one after the `get_my_latest_report` schema):

```python
    {
        "type": "function",
        "function": {
            "name": "get_my_zone_trend",
            "description": (
                "The person's own Fatigue ↔ Burnout zone from their PILOT check-ins: latest "
                "strain zone, whether they lean towards fatigue or burnout, Improving / Steady / "
                "Worsening against their previous check-ins, and approximate fatigue signals. "
                "Use for 'am I improving' or 'fatigue vs burnout' questions. It is a wellbeing "
                "guide, not a diagnosis."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
```

**3d.** In `dispatch_tool`, directly above the line `    if name == "get_my_latest_report":`, add:

```python
    if name == "get_my_zone_trend":
        recs = await get_user_survey_records(auth.user_id)
        try:
            return build_zone_trend(recs, load_survey("PILOT")), []
        except ZoneConfigError:
            logger.exception("[Chat] zone config unavailable")
            return {"error": "zone unavailable"}, []

```

**3e. Owner-approved prompt change.** In `app/backend/ciq/chat/prompts.py`, replace exactly:

```python
    "(get_my_assessments, get_my_score_trend, get_my_latest_report). Never invent figures.\n"
```

with:

```python
    "(get_my_assessments, get_my_score_trend, get_my_latest_report, get_my_zone_trend). Never invent figures.\n"
    "- For 'am I improving' or 'fatigue vs burnout' questions, call get_my_zone_trend; it is a "
    "wellbeing guide, not a diagnosis.\n"
```

- [ ] **Step 4: Run the tests to check they pass**

Run: `.venv/bin/python -m pytest tests/integration/test_zone_chat_tool.py tests/integration/test_zone_trend.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/backend/ciq/chat/tools.py app/backend/ciq/chat/rbac.py app/backend/ciq/chat/prompts.py app/backend/tests/integration/test_zone_chat_tool.py
git commit -m "feat(zone): personal chat tool get_my_zone_trend (prompt line owner-approved)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend types and pure helper (`lib/zone.ts`)

**Files:**
- Modify: `app/frontend/src/types.ts` (append)
- Create: `app/frontend/src/lib/zone.ts`
- Test: `app/frontend/src/lib/zone.test.ts`

**Interfaces:**
- Consumes: `Tone` from `@/lib/badges`
- Produces:
  - Types: `ZoneKey`, `LeanKey`, `ZoneTrendStatus`, `ZoneSignal`, `ZoneResult`, `ZonePoint`, `ZoneTrend`, `ZoneTrendResponse` (in `@/types`)
  - Helpers: `ZONE_LABEL`, `ZONE_TONE`, `LEAN_LABEL`, `LEAN_HINT`, `ZONE_BANDS`, `ZONE_EMPTY_TEXT`, `ZONE_DISCLAIMER`, `trendBadge(status) -> {text, tone}`, `hasMarker(zone) -> boolean`, `scaleAriaLabel(zone) -> string` (in `@/lib/zone`)

- [ ] **Step 1: Append the types**

Append to `app/frontend/src/types.ts`:

```ts
// ── Fatigue ↔ Burnout zone (GET /api/zone-trend) — spec 2026-10-01 ─────────
export type ZoneKey = "well" | "mild" | "moderate" | "high";
export type LeanKey = "none" | "fatigue" | "mixed" | "burnout";
export type ZoneTrendStatus = "none" | "first" | "improving" | "steady" | "worsening";

export type ZoneSignal = { key: "blink_up" | "slower"; label: string; approximate: boolean };

export type ZoneResult = {
    surveyRunId: string;
    date: string;
    fatigue: number;
    burnout: number;
    severity: number;
    zone: ZoneKey;
    lean: LeanKey;
    leanValue: number;
    marker: number | null;
    signals: ZoneSignal[];
};

export type ZonePoint = { surveyRunId: string; date: string; severity: number; zone: ZoneKey; lean: LeanKey };

export type ZoneTrend = {
    status: ZoneTrendStatus;
    delta?: number;
    ref?: number;
    compared?: number;
    points: ZonePoint[];
};

export type ZoneTrendResponse = { latest: ZoneResult | null; trend: ZoneTrend };
```

- [ ] **Step 2: Write the failing test**

Create `app/frontend/src/lib/zone.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
    LEAN_HINT, LEAN_LABEL, ZONE_BANDS, ZONE_DISCLAIMER, ZONE_EMPTY_TEXT, ZONE_LABEL, ZONE_TONE,
    hasMarker, scaleAriaLabel, trendBadge,
} from "./zone";
import type { ZoneResult } from "@/types";

const base: ZoneResult = {
    surveyRunId: "r1", date: "2026-10-01", fatigue: 50, burnout: 25, severity: 43,
    zone: "mild", lean: "fatigue", leanValue: -25, marker: 38, signals: [],
};

describe("zone labels and tones", () => {
    it.each([
        ["well", "Doing well", "green"],
        ["mild", "Mild strain", "blue"],
        ["moderate", "Moderate strain", "amber"],
        ["high", "High strain", "red"],
    ] as const)("%s → %s / %s", (zone, label, tone) => {
        expect(ZONE_LABEL[zone]).toBe(label);
        expect(ZONE_TONE[zone]).toBe(tone);
    });

    it("lean labels", () => {
        expect(LEAN_LABEL.fatigue).toBe("Fatigue-leaning");
        expect(LEAN_LABEL.burnout).toBe("Burnout-leaning");
        expect(LEAN_LABEL.mixed).toBe("Mixed");
        expect(LEAN_LABEL.none).toBe("");
        expect(LEAN_HINT.fatigue).toMatch(/rest/i);
        expect(LEAN_HINT.burnout).toMatch(/change/i);
    });

    it("bands match the backend zone edges", () => {
        expect(ZONE_BANDS.map(b => [b.from, b.to, b.zone])).toEqual([
            [0, 25, "well"], [25, 50, "mild"], [50, 75, "moderate"], [75, 100, "high"],
        ]);
    });

    it("copy is exact", () => {
        expect(ZONE_EMPTY_TEXT).toBe("Complete a check-in to see your zone");
        expect(ZONE_DISCLAIMER).toBe("A wellbeing guide, not a diagnosis.");
    });
});

describe("trendBadge", () => {
    it.each([
        ["none", "No check-ins yet", "neutral"],
        ["first", "First check-in", "neutral"],
        ["improving", "Improving", "green"],
        ["steady", "Steady", "blue"],
        ["worsening", "Worsening", "red"],
    ] as const)("%s", (status, text, tone) => {
        expect(trendBadge(status)).toEqual({ text, tone });
    });
});

describe("marker", () => {
    it("shows a marker when present", () => {
        expect(hasMarker(base)).toBe(true);
        expect(scaleAriaLabel(base)).toBe("Fatigue to burnout scale: marker at 38 of 100, fatigue-leaning");
    });

    it("greys out when marker is null (zone well)", () => {
        const well: ZoneResult = { ...base, zone: "well", lean: "none", marker: null };
        expect(hasMarker(well)).toBe(false);
        expect(scaleAriaLabel(well)).toBe("Fatigue to burnout scale: low strain, no lean");
    });

    it("treats marker 0 as present", () => {
        expect(hasMarker({ ...base, marker: 0 })).toBe(true);
    });
});
```

- [ ] **Step 3: Run it to check it fails**

Run: `cd app/frontend && npx vitest run src/lib/zone.test.ts`
Expected: `Failed to resolve import "./zone"`.

- [ ] **Step 4: Implement**

Create `app/frontend/src/lib/zone.ts`:

```ts
// Fatigue ↔ Burnout zone — display helpers (pure). Numbers/edges mirror
// app/backend/ciq/zone.py ZONE_CONFIG; keep them identical to the BE.
import type { Tone } from "@/lib/badges";
import type { LeanKey, ZoneKey, ZoneResult, ZoneTrendStatus } from "@/types";

export const ZONE_LABEL: Record<ZoneKey, string> = {
    well: "Doing well",
    mild: "Mild strain",
    moderate: "Moderate strain",
    high: "High strain",
};

export const ZONE_TONE: Record<ZoneKey, Tone> = { well: "green", mild: "blue", moderate: "amber", high: "red" };

export const LEAN_LABEL: Record<LeanKey, string> = {
    none: "",
    fatigue: "Fatigue-leaning",
    mixed: "Mixed",
    burnout: "Burnout-leaning",
};

export const LEAN_HINT: Record<LeanKey, string> = {
    none: "Low strain overall, so there is nothing to lean towards.",
    fatigue: "Rest and recovery are likely to help.",
    mixed: "A mix of tiredness and detachment.",
    burnout: "Something about the work situation may need to change.",
};

export const ZONE_BANDS: ReadonlyArray<{ from: number; to: number; zone: ZoneKey }> = [
    { from: 0, to: 25, zone: "well" },
    { from: 25, to: 50, zone: "mild" },
    { from: 50, to: 75, zone: "moderate" },
    { from: 75, to: 100, zone: "high" },
];

export const ZONE_EMPTY_TEXT = "Complete a check-in to see your zone";
export const ZONE_DISCLAIMER = "A wellbeing guide, not a diagnosis.";

const BADGE: Record<ZoneTrendStatus, { text: string; tone: Tone }> = {
    none: { text: "No check-ins yet", tone: "neutral" },
    first: { text: "First check-in", tone: "neutral" },
    improving: { text: "Improving", tone: "green" },
    steady: { text: "Steady", tone: "blue" },
    worsening: { text: "Worsening", tone: "red" },
};

export function trendBadge(status: ZoneTrendStatus): { text: string; tone: Tone } {
    return BADGE[status];
}

export function hasMarker(zone: Pick<ZoneResult, "marker">): boolean {
    return zone.marker !== null;
}

export function scaleAriaLabel(zone: Pick<ZoneResult, "marker" | "lean">): string {
    if (zone.marker === null) return "Fatigue to burnout scale: low strain, no lean";
    return `Fatigue to burnout scale: marker at ${zone.marker} of 100, ${LEAN_LABEL[zone.lean].toLowerCase()}`;
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run src/lib/zone.test.ts && npx tsc -b`
Expected: tests pass and `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add app/frontend/src/types.ts app/frontend/src/lib/zone.ts app/frontend/src/lib/zone.test.ts
git commit -m "feat(zone): frontend zone types and display helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Components, home card and session report

**Files:**
- Create: `app/frontend/src/components/ui/zone-scale.tsx`
- Create: `app/frontend/src/components/ui/zone-trend.tsx`
- Create: `app/frontend/src/components/ui/zone-card.tsx`. This small wrapper does the fetch, so `guest-landing.tsx` only gains a few lines. It is an implementation detail of spec §6.4.
- Modify: `app/frontend/src/components/ui/guest-landing.tsx` (one import; one new `<motion.section>` above the existing one)
- Modify: `app/frontend/src/components/ui/detailed-report.tsx` (imports; one state; one effect; one conditional block)

**Interfaces:**
- Consumes: everything from Task 6; `apiFetch` from `@/lib/api`; `PILL` and `TEXT_TONE` from `@/lib/badges`
- Produces:
  - `ZoneScale({ zone: ZoneResult; trend?: ZoneTrend })`
  - `ZoneTrendChart({ points: ZonePoint[] })`
  - `ZoneCard()`

There is no DOM test harness in this repo (Vitest runs in a node environment), so these components are checked by `tsc`, `vite build` and the manual checks in Step 6. The logic they rely on is already covered in Task 6.

- [ ] **Step 1: `zone-scale.tsx`**

```tsx
import { PILL, TEXT_TONE } from "@/lib/badges";
import { LEAN_HINT, LEAN_LABEL, ZONE_DISCLAIMER, ZONE_LABEL, ZONE_TONE, hasMarker, scaleAriaLabel, trendBadge } from "@/lib/zone";
import type { ZoneResult, ZoneTrend } from "@/types";

/** Fatigue ↔ Burnout line + strain zone + trend badge + approximate signal chips. Own data only. */
export function ZoneScale({ zone, trend }: { zone: ZoneResult; trend?: ZoneTrend }) {
    const badge = trend ? trendBadge(trend.status) : null;
    const marked = hasMarker(zone);

    return (
        <div>
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <p className={`text-lg font-semibold ${TEXT_TONE[ZONE_TONE[zone.zone]]}`}>{ZONE_LABEL[zone.zone]}</p>
                    <p className="text-xs text-[color:var(--ciq-text-60)]">Strain {zone.severity} / 100 · lower is better</p>
                </div>
                {badge && <span className={`rounded-full px-3 py-1 text-xs font-medium ${PILL[badge.tone]}`}>{badge.text}</span>}
            </div>

            <div className="mt-5">
                <div className="flex justify-between text-xs font-medium text-[color:var(--ciq-text-60)]">
                    <span>Fatigue</span>
                    <span>Burnout</span>
                </div>
                <div
                    role="img"
                    aria-label={scaleAriaLabel(zone)}
                    className={`relative mt-2 h-2 rounded-full bg-gradient-to-r from-[color:var(--ciq-accent-amber)] to-[color:var(--ciq-accent-red)] ${marked ? "" : "opacity-30 grayscale"}`}
                >
                    {marked && (
                        <span
                            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--ciq-card)] bg-[color:var(--ciq-text-strong)]"
                            style={{ left: `${zone.marker}%` }}
                        />
                    )}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-[color:var(--ciq-text-40)]">
                    <span>rest likely helps</span>
                    <span>situation may need to change</span>
                </div>
            </div>

            <p className="mt-3 text-sm text-[color:var(--ciq-text-86)]">
                {zone.lean !== "none" && <b>{LEAN_LABEL[zone.lean]}. </b>}
                {LEAN_HINT[zone.lean]}
            </p>

            {zone.signals.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                    {zone.signals.map(s => (
                        <span key={s.key} className={`rounded-full px-2.5 py-1 text-xs ${PILL.neutral}`}>
                            {s.label}
                            {s.approximate && " · approximate"}
                        </span>
                    ))}
                </div>
            )}

            <p className="mt-3 text-xs text-[color:var(--ciq-text-40)]">{ZONE_DISCLAIMER}</p>
        </div>
    );
}
```

- [ ] **Step 2: `zone-trend.tsx`**

```tsx
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea } from "recharts";
import { ZONE_BANDS, ZONE_LABEL } from "@/lib/zone";
import type { ZonePoint } from "@/types";

const BAND_FILL: Record<string, string> = {
    well: "var(--ciq-accent-green)", mild: "var(--ciq-accent-blue)",
    moderate: "var(--ciq-accent-amber)", high: "var(--ciq-accent-red)",
};

function label(date: string): string {
    return new Date(`${date}T00:00:00`).toLocaleString("en", { month: "short", day: "numeric" });
}

/** Strain over time, one point per complete PILOT check-in, zone bands shaded. Lower is better. */
export function ZoneTrendChart({ points }: { points: ZonePoint[] }) {
    if (points.length < 2) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-center text-sm text-[color:var(--ciq-text-60)]">
                    Your trend line appears after your next check-in.
                </p>
            </div>
        );
    }
    const data = points.map(p => ({ ...p, label: label(p.date) }));
    return (
        <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                {ZONE_BANDS.map(b => (
                    <ReferenceArea key={b.zone} y1={b.from} y2={b.to} fill={BAND_FILL[b.zone]} fillOpacity={0.07} stroke="none" />
                ))}
                <CartesianGrid stroke="var(--ciq-divider)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "var(--ciq-text-60)", fontSize: 11 }}
                    axisLine={{ stroke: "var(--ciq-divider)" }} tickLine={false} />
                <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: "var(--ciq-text-60)", fontSize: 11 }}
                    axisLine={false} tickLine={false} width={40} />
                <Tooltip
                    contentStyle={{ background: "var(--ciq-card)", border: "1px solid var(--ciq-border)", borderRadius: 12, fontSize: 12 }}
                    formatter={(v: number, _n, p) => [`${v} · ${ZONE_LABEL[p.payload.zone as ZonePoint["zone"]]}`, "Strain"]} />
                <Line type="linear" dataKey="severity" stroke="var(--ciq-accent-blue)" strokeWidth={2.5} dot={{ r: 3.5 }} activeDot={{ r: 5 }} />
            </LineChart>
        </ResponsiveContainer>
    );
}
```

- [ ] **Step 3: `zone-card.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ZONE_EMPTY_TEXT } from "@/lib/zone";
import type { ZoneTrendResponse } from "@/types";
import { ZoneScale } from "./zone-scale";
import { ZoneTrendChart } from "./zone-trend";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: ZoneTrendResponse };

/** Home-screen card: the signed-in employee's own Fatigue ↔ Burnout zone and trend. */
export function ZoneCard() {
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        apiFetch("/api/zone-trend")
            .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data: ZoneTrendResponse) => alive && setState({ kind: "ready", data }))
            .catch(() => alive && setState({ kind: "error" }));
        return () => {
            alive = false;
        };
    }, []);

    return (
        <div className="bg-[color:var(--ciq-card)]/70 rounded-2xl border border-[color:var(--ciq-border)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl">
            <div className="mb-4 flex items-center gap-2">
                <Gauge className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" />
                <h2 className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">Fatigue ↔ Burnout</h2>
            </div>

            {state.kind === "loading" && <p className="text-sm text-[color:var(--ciq-text-60)]">Loading your zone…</p>}
            {state.kind === "error" && <p className="text-sm text-[color:var(--ciq-text-60)]">Zone unavailable right now.</p>}
            {state.kind === "ready" && !state.data.latest && (
                <p className="text-sm text-[color:var(--ciq-text-60)]">{ZONE_EMPTY_TEXT}</p>
            )}
            {state.kind === "ready" && state.data.latest && (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
                    <div className="lg:col-span-2">
                        <ZoneScale zone={state.data.latest} trend={state.data.trend} />
                    </div>
                    <div className="h-[220px] lg:col-span-3">
                        <ZoneTrendChart points={state.data.trend.points} />
                    </div>
                </div>
            )}
        </div>
    );
}
```

- [ ] **Step 4: Add the card to `guest-landing.tsx` (additions only)**

1. Below `import { GuestChat } from "./guest-chat";`, add:

```tsx
import { ZoneCard } from "./zone-card";
```

2. Directly **above** the line `                        {/* Your journey — personal trend + wellbeing assistant (own data only) */}`, insert:

```tsx
                        {/* Fatigue ↔ Burnout zone — own data only (spec 2026-10-01). Separate section so the
                            existing trend/chat grid below is untouched. */}
                        <motion.section
                            initial={{ opacity: 0, y: 24 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.55, delay: 0.28, ease: [0.22, 1, 0.36, 1] }}
                            className="mt-4"
                        >
                            <ZoneCard />
                        </motion.section>

```

Do **not** edit the existing `<motion.section>`, `GuestScoreTrend` or `GuestChat` lines.

- [ ] **Step 5: Add the zone block to `detailed-report.tsx` (additions only)**

1. Change the types import on line 2 to also import `ZoneTrendResponse`:

```tsx
import { BiometricSnapshot, SSoTReport, AnalyzeReportResponse, AnalysisResult, AnalysisInsight, ZoneTrendResponse } from "@/types";
```

2. Below the `@/components/ui/readiness-report-view` import, add:

```tsx
import { ZoneScale } from "@/components/ui/zone-scale";
```

3. Directly below `    const [analyzeData, setAnalyzeData] = useState<AnalyzeReportResponse | null>(null);`, add:

```tsx
    const [zoneData, setZoneData] = useState<ZoneTrendResponse | null>(null);
```

4. Directly below the (unique) line `    }, [analyzeData, surveyRunId]);`, add:

```tsx

    // Fatigue ↔ Burnout zone (spec 2026-10-01 §6.2). Fetched only after /analyze-report has
    // saved this run; rendered only if the newest complete run IS this run, so a failed save
    // or an incomplete run never shows a previous session's zone as this one.
    useEffect(() => {
        if (!analyzeData || !surveyRunId) return;
        let cancelled = false;
        apiFetch("/api/zone-trend")
            .then(r => (r.ok ? r.json() : null))
            .then((d: ZoneTrendResponse | null) => {
                if (!cancelled) setZoneData(d);
            })
            .catch(() => {
                if (!cancelled) setZoneData(null);
            });
        return () => {
            cancelled = true;
        };
    }, [analyzeData, surveyRunId]);
```

5. Directly **above** the line `            {/* ── Combined Overall Burnout: risk gauge + enlarged domain radar ──`, insert:

```tsx
            {zoneData?.latest && zoneData.latest.surveyRunId === surveyRunId && (
                <div className={`mb-4 ${cardClass}`}>
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                        <Gauge className="h-5 w-5" /> Fatigue ↔ Burnout zone
                    </div>
                    <ZoneScale zone={zoneData.latest} trend={zoneData.trend} />
                </div>
            )}

```

- [ ] **Step 6: Build and check by hand**

Run:
```bash
cd app/frontend && npx tsc -b && npm test && npx vite build
```
Expected: all exit 0.

Then check manually. Run the backend locally as described in the repo `CLAUDE.md` / `scripts/start.sh`, then log in as `guest1` / `sys123`.
1. **New user:** the home screen shows the Fatigue ↔ Burnout card with "Complete a check-in to see your zone". The existing trend and chat cards are unchanged and in the same place.
2. **With data:** seed 4 PILOT runs for guest1. You can reuse `insert_run` from the integration test in a short `python -c` script against the dev DB, or complete real check-ins. Then check:
   - the marker position
   - the zone label
   - the trend badge
   - the chart with shaded bands
   - the "approximate" chips (only when the data supports them)
3. **Low strain:** a run with all minimum answers shows "Doing well", a greyed line and no marker.
4. **Session report:** complete a PILOT check-in. The report shows the zone block above "Overall Burnout". Then stop the backend between the analyze call and the zone fetch (or make the run incomplete): the report renders with no zone block.
5. **Widths:** check a phone width (about 375 px) and a desktop width. There must be no horizontal scroll, and the chart must stay readable.

Record the result of each check in the commit message body.

- [ ] **Step 7: Commit**

```bash
git add app/frontend/src/components/ui/zone-scale.tsx app/frontend/src/components/ui/zone-trend.tsx app/frontend/src/components/ui/zone-card.tsx app/frontend/src/components/ui/guest-landing.tsx app/frontend/src/components/ui/detailed-report.tsx
git commit -m "feat(zone): home card and session-report zone block

Manual checks: <list results of Step 6 checks 1–5>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full regression and wrap-up

**Files:** none new.

- [ ] **Step 1: Full backend suite**

Run: `cd app/backend && .venv/bin/python -m pytest -q`
Expected: the Task 0 baseline count plus the new tests, all passing. In particular, `tests/integration/test_analyze_report.py` passes **unchanged**.

- [ ] **Step 2: Full frontend suite, type check and build**

Run: `cd app/frontend && npm test && npx tsc -b && npx vite build`
Expected: all exit 0.

- [ ] **Step 3: Confirm no forbidden files changed**

Run:
```bash
git diff --stat 74a2e9b..HEAD -- app/backend/ciq/reports/routes.py app/backend/survey_loader.py app/frontend/src/components/ui/guest-score-trend.tsx
```
Expected: **empty output**.

Run: `git diff 74a2e9b..HEAD -- app/frontend/src/components/ui/guest-landing.tsx app/frontend/src/components/ui/detailed-report.tsx`
Expected: only `+` lines, plus the one-line types import change in `detailed-report.tsx`.

- [ ] **Step 4: Report**

Summarise for the owner:
- the test counts before and after
- the manual-check results
- that nothing was pushed

The follow-up `fix/analyze-report-ownership` (spec §11) is a separate task and is not part of this branch.
