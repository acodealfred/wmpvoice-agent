"""Participant report export (ciq.reports.export / ciq.reports.pdf) — pure parts."""
import json
from datetime import datetime

import pytest

from ciq.reports.export import (
    period_since,
    report_content,
    report_filename,
    valid_offset,
    zip_filename,
)
from ciq.reports.pdf import (
    NO_SUMMARY,
    _styles,
    markdown_flowables,
    pdf_safe,
    render_report_pdf,
)

SRI_LANKA = 330  # UTC+05:30, minutes east of UTC
NOW = datetime(2026, 10, 10, 3, 0, 0)  # 08:30 in Sri Lanka

PILOT_RECORD = {
    "survey_run_id": "6f1c2a90-run",
    "user_id": "user-uuid-1",
    "user_name": "P001",
    "survey_type": "PILOT",
    "updated_at": "2026-10-10T02:15:00",
    "technical_report": json.dumps({
        "analysis": {"patterns": ["internal only"]},
        "sections": [
            {"id": "bat4", "label": "BAT-4", "score": 3.0, "scoreRange": [1, 5], "riskLevel": "Moderate", "interpretation": "BAT text."},
            {"id": "cbi3", "label": "CBI-WRB3", "score": 66.7, "scoreRange": [0, 100], "riskLevel": "High", "interpretation": "CBI text."},
        ],
        "domainTotals": {"exhaustion": 9},
    }),
    "prompt_info": json.dumps({
        "agentResponse": "## Overall\nYou are **doing** your best.\n\n- rest more\n- talk to someone",
        "ssotReport": {"answer": "Research says rest helps.", "citations": [{"paperId": "p1", "paperTitle": "Rest study", "paperPage": 4}]},
    }),
}


def test_today_starts_at_local_midnight():
    # 08:30 Sri Lanka on Oct 10 → today began at 00:00 local = Oct 9 18:30 UTC.
    assert period_since("today", NOW, SRI_LANKA) == "2026-10-09T18:30:00"
    assert period_since("today", NOW, 0) == "2026-10-10T00:00:00"


def test_rolling_periods_and_all():
    assert period_since("7", NOW, SRI_LANKA) == "2026-10-03T03:00:00"
    assert period_since("30", NOW, SRI_LANKA) == "2026-09-10T03:00:00"
    assert period_since("all", NOW, SRI_LANKA) is None
    with pytest.raises(ValueError):
        period_since("14", NOW, SRI_LANKA)


def test_offset_range():
    assert valid_offset(SRI_LANKA) and valid_offset(-720) and valid_offset(840)
    assert not valid_offset(900)


def test_filenames_are_safe():
    assert report_filename("P001", "6f1c2a90-run") == "P001_6f1c2a90-run.pdf"
    assert report_filename("John Smith/../x", "r1") == "John_Smith_.._x_r1.pdf"
    assert report_filename(None, "r1") == "unknown_r1.pdf"
    assert report_filename("   ", "r1") == "unknown_r1.pdf"
    assert zip_filename("today", NOW, SRI_LANKA) == "ciq_reports_today_2026-10-10.zip"
    assert zip_filename("7", NOW, SRI_LANKA) == "ciq_reports_last7days_2026-10-10.zip"


def test_participant_content_has_results_and_summary_but_no_internal_fields():
    c = report_content(PILOT_RECORD, SRI_LANKA)
    assert c["name"] == "P001"
    assert c["completed"] == "10 Oct 2026, 07:45 (UTC+05:30)"
    assert c["results"] == [
        {"label": "BAT-4", "score": 3.0, "max": 5, "riskLevel": "Moderate", "interpretation": "BAT text."},
        {"label": "CBI-WRB3", "score": 66.7, "max": 100, "riskLevel": "High", "interpretation": "CBI text."},
    ]
    assert c["summary"].startswith("## Overall")
    assert c["kbReport"]["citations"][0]["paperTitle"] == "Rest study"
    flat = json.dumps(c)
    for internal in ("user-uuid-1", "6f1c2a90-run", "internal only", "exhaustion"):
        assert internal not in flat


def test_non_pilot_report_shows_total_and_risk():
    rec = {**PILOT_RECORD, "survey_type": "BATFULL",
           "technical_report": json.dumps({"totalScore": 61, "riskLevel": "Moderate", "interpretation": "Total text."}),
           "prompt_info": None}
    c = report_content(rec, SRI_LANKA)
    assert c["results"] == [{"label": "BATFULL", "score": 61, "max": None, "riskLevel": "Moderate", "interpretation": "Total text."}]
    assert c["summary"] is None and c["kbReport"] is None


def test_pdf_is_produced_with_and_without_a_summary():
    assert render_report_pdf(report_content(PILOT_RECORD, SRI_LANKA)).startswith(b"%PDF")
    bare = report_content({**PILOT_RECORD, "prompt_info": None}, SRI_LANKA)
    assert render_report_pdf(bare).startswith(b"%PDF")
    assert NO_SUMMARY  # the fallback line exists


def test_markdown_is_escaped_and_never_interpreted_as_markup():
    texts = [getattr(f, "text", "") for f in markdown_flowables("Hi <script>alert(1)</script> **bold** & co", _styles())]
    joined = " ".join(texts)
    assert "<script>" not in joined
    assert "&lt;script&gt;" in joined
    assert "<b>bold</b>" in joined
    assert "&amp; co" in joined


def test_characters_the_pdf_font_cannot_draw_are_replaced():
    assert pdf_safe("Fatigue ↔ Burnout → rest ≥ 3") == "Fatigue <-> Burnout -> rest >= 3"
    assert pdf_safe("emoji 🙂 gone") == "emoji  gone"
    assert pdf_safe("curly ’quotes’ – kept") == "curly ’quotes’ – kept"


def test_scores_read_like_the_app():
    from ciq.reports.pdf import _score_text
    assert _score_text(3.0, 5) == "<b>3</b> / 5"
    assert _score_text(66.7, 100) == "<b>66.7</b> / 100"
    assert _score_text(61, None) == "<b>61</b>"
    assert _score_text(None, 5) == "—"
