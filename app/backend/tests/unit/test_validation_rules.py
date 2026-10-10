"""ciq.validation.rules — Data Validation dashboard status/report/file rules
(docs/data-validation-dashboard.md §3–§5)."""
import json

import pytest

from ciq.validation.rules import (
    REPORT_MISSING,
    REPORT_NOT_GENERATED,
    REPORT_SAVED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PARTIAL,
    ai_summary_generated,
    build_run_view,
    completed_at,
    file_manifest,
    parse_json_column,
    report_state,
    risks_deviate,
    validation_status,
)

REPORT = {"analysis": {}, "riskLevel": "Low"}


# ── validation_status ─────────────────────────────────────────────────────

@pytest.mark.parametrize("lifecycle", ["closed", "paused", "active"])
def test_left_before_report_is_partial_never_failed(lifecycle):
    # No report, no timeline, no scores — still PARTIAL: that is expected for a run the user left.
    assert validation_status(lifecycle, "PILOT", None, False, False, False) == STATUS_PARTIAL


def test_completed_with_everything_is_completed():
    assert validation_status("completed", "PILOT", REPORT, True, True, True) == STATUS_COMPLETED
    assert validation_status("completed", "BATFULL", REPORT, True, False, False) == STATUS_COMPLETED


def test_missing_lifecycle_defaults_to_completed():
    # Pre-lifecycle rows default to 'completed' in the schema; treat NULL the same.
    assert validation_status(None, "BATFULL", REPORT, True, False, False) == STATUS_COMPLETED


@pytest.mark.parametrize(
    "report, timeline, bat4, cbi3",
    [
        (None, True, True, True),   # report never saved
        (REPORT, False, True, True),  # no timeline frames
        (REPORT, True, False, True),  # PILOT missing BAT-4 row
        (REPORT, True, True, False),  # PILOT missing CBI-WRB3 row
    ],
)
def test_completed_run_missing_data_is_failed(report, timeline, bat4, cbi3):
    assert validation_status("completed", "PILOT", report, timeline, bat4, cbi3) == STATUS_FAILED


# ── report_state ──────────────────────────────────────────────────────────

def test_report_states():
    assert report_state("completed", REPORT) == REPORT_SAVED
    assert report_state("closed", REPORT) == REPORT_SAVED
    assert report_state("closed", None) == REPORT_NOT_GENERATED
    assert report_state("completed", None) == REPORT_MISSING


def test_ai_summary_is_informational():
    assert ai_summary_generated({"analysis": {"x": 1}}, {"agentResponse": "hi"}) is True
    assert ai_summary_generated({"analysis": {}}, {"agentResponse": "hi"}) is False
    assert ai_summary_generated({"analysis": {"x": 1}}, None) is False
    # ...and never changes status
    assert validation_status("completed", "BATFULL", {"analysis": {}}, True, False, False) == STATUS_COMPLETED


def test_parse_json_column_tolerates_bad_rows():
    assert parse_json_column(None) is None
    assert parse_json_column("not json") is None
    assert parse_json_column("[1, 2]") is None
    assert parse_json_column('{"a": 1}') == {"a": 1}


# ── risks_deviate ─────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "bat, cbi, expected",
    [
        ("Low", "High", True),
        ("High", "Low", True),
        ("high", " low ", True),
        ("Low", "Moderate", False),
        ("Moderate", "High", False),
        ("High", "High", False),
        ("Low", None, False),
        (None, None, False),
    ],
)
def test_risks_deviate_only_low_vs_high(bat, cbi, expected):
    assert risks_deviate(bat, cbi) is expected


# ── file_manifest ─────────────────────────────────────────────────────────

RUN = "abcdef12-3456-7890"
USER = "99887766-5544"


def test_manifest_no_eeg():
    files = file_manifest(RUN, USER, True, [])
    assert [f["path"] for f in files] == ["survey_timeline_99887766_abcdef12.csv"]


def test_manifest_single_eeg_session():
    paths = [f["path"] for f in file_manifest(RUN, USER, True, [0])]
    assert paths == [
        "survey_timeline_99887766_abcdef12.csv",
        "survey_timeline_combined_99887766_abcdef12.csv",
        "eeg/eeg_session_99887766_abcdef12.json",
    ]


def test_manifest_one_file_per_eeg_segment():
    files = file_manifest(RUN, USER, True, [0, 1, 2])
    eeg = [f for f in files if f["kind"] == "eeg"]
    assert [(f["segment"], f["path"]) for f in eeg] == [
        (0, "eeg/eeg_segment0_99887766_abcdef12.json"),
        (1, "eeg/eeg_segment1_99887766_abcdef12.json"),
        (2, "eeg/eeg_segment2_99887766_abcdef12.json"),
    ]


def test_manifest_combined_needs_timeline():
    kinds = [f["kind"] for f in file_manifest(RUN, USER, False, [0])]
    assert kinds == ["eeg"]


def test_manifest_empty_run():
    assert file_manifest(RUN, USER, False, []) == []


# ── completed_at (§4a) ────────────────────────────────────────────────────

def test_completed_at_fallbacks():
    base = {"updated_at": "u", "closed_at": None, "paused_at": None}
    assert completed_at({**base, "status": "completed", "closed_at": "c"}) == "u"
    assert completed_at({**base, "status": "closed", "closed_at": "c", "paused_at": "p"}) == "c"
    assert completed_at({**base, "status": "paused", "paused_at": "p"}) == "p"
    assert completed_at({**base, "status": "active"}) == "u"


# ── build_run_view ────────────────────────────────────────────────────────

def _row(**over):
    row = {
        "survey_run_id": RUN, "user_id": USER, "survey_type": "PILOT", "status": "completed",
        "created_at": "2026-10-06T08:00:00", "updated_at": "2026-10-06T08:20:00",
        "closed_at": None, "paused_at": None,
        "technical_report": json.dumps({"analysis": {}}), "prompt_info": None,
        "has_timeline": 1, "has_bat4_row": 1, "has_cbi3_row": 1,
        "bat4_risk_level": "High", "bat4_average": 4.25,
        "cbi3_risk_level": "Low", "cbi3_mean": 16.7,
        "eeg_segments": [0, 1],
        "segment_spans": {0: {"start": "s0", "end": "e0"}, 1: {"start": "s1", "end": "e1"}},
    }
    row.update(over)
    return row


def test_view_pilot_with_deviation_and_segments():
    v = build_run_view(_row())
    assert v["status"] == STATUS_COMPLETED
    assert v["userId"] == USER
    assert v["report"] == REPORT_SAVED
    assert v["scores"]["riskDeviation"] is True
    assert all("99887766" in f["path"] for f in v["files"])
    assert v["scores"]["primary"]["label"] == "BAT-4"
    assert v["eegSegments"] == [{"index": 0, "start": "s0", "end": "e0"}, {"index": 1, "start": "s1", "end": "e1"}]
    assert v["fileCount"] == 4  # timeline, combined, 2 eeg segments
    assert all(f["kind"] != "pilot" for f in v["files"])  # pilot XLSX is not offered


def test_view_non_pilot_uses_technical_report_risk_and_no_cbi():
    v = build_run_view(_row(
        survey_type="BATFULL", has_bat4_row=0, has_cbi3_row=0,
        technical_report=json.dumps({"analysis": {}, "riskLevel": "Moderate", "totalScore": 61}),
        eeg_segments=[], segment_spans={},
    ))
    assert v["scores"]["primary"] == {"label": "BATFULL", "riskLevel": "Moderate", "score": 61, "max": None}
    assert v["scores"]["cbi"] is None
    assert v["scores"]["riskDeviation"] is False


def test_view_closed_run_is_partial_and_unscored():
    v = build_run_view(_row(
        status="closed", closed_at="2026-10-06T08:10:00", technical_report=None,
        has_bat4_row=0, has_cbi3_row=0, bat4_risk_level=None, cbi3_risk_level=None,
    ))
    assert v["status"] == STATUS_PARTIAL
    assert v["lifecycleStatus"] == "closed"
    assert v["report"] == REPORT_NOT_GENERATED
    assert v["completedAt"] == "2026-10-06T08:10:00"
    assert v["scores"]["scored"] is False
    assert v["scores"]["riskDeviation"] is False
