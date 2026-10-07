"""ciq.common.export_names — every per-run download name carries <user8>_<run8>."""
import pytest

from ciq.common.export_names import export_filename

RUN = "abcdef12-3456"
USER = "99887766-5544"


@pytest.mark.parametrize(
    "kind, segment, in_zip, expected",
    [
        ("timeline", None, False, "survey_timeline_99887766_abcdef12.csv"),
        ("combined", None, False, "survey_timeline_combined_99887766_abcdef12.csv"),
        ("eeg", None, False, "eeg_session_99887766_abcdef12.json"),
        ("eeg", 2, False, "eeg_session_99887766_abcdef12_segment2.json"),
        ("eeg", None, True, "eeg/eeg_session_99887766_abcdef12.json"),
        ("eeg", 2, True, "eeg/eeg_segment2_99887766_abcdef12.json"),
        ("timeline", None, True, "survey_timeline_99887766_abcdef12.csv"),
        ("zip", None, False, "ciq_export_99887766_abcdef12-3456.zip"),
    ],
)
def test_names_carry_user_and_run(kind, segment, in_zip, expected):
    assert export_filename(kind, RUN, USER, segment=segment, in_zip=in_zip) == expected


def test_missing_user_drops_the_user_part():
    assert export_filename("timeline", RUN, None) == "survey_timeline_abcdef12.csv"
    assert export_filename("zip", RUN, "") == "ciq_export_abcdef12-3456.zip"


def test_unknown_kind_raises():
    with pytest.raises(ValueError):
        export_filename("pilot", RUN, USER)
