"""Download filenames for every per-run export — one source so the Admin panel
downloads, the Data Validation downloads and the files inside the export ZIP can
never drift apart. Pure, no I/O.

Every name carries the run owner's short user id and the short run id
(`<user8>_<run8>`); the user part is left out when a run has no user record.
"""


def _short(value: str | None) -> str:
    return (value or "")[:8]


def _ids(survey_run_id: str, user_id: str | None) -> str:
    user = _short(user_id)
    return f"{user}_{_short(survey_run_id)}" if user else _short(survey_run_id)


def export_filename(
    kind: str,
    survey_run_id: str,
    user_id: str | None = None,
    segment: int | None = None,
    in_zip: bool = False,
) -> str:
    """kind: timeline | combined | eeg | zip.

    eeg: no segment → the whole-run file (one session or the all-segments bundle);
    a segment → that segment's file. Inside the ZIP, EEG files live under eeg/ and a
    per-segment file is named eeg_segment<N>_… (the ZIP never holds the bundle).
    """
    ids = _ids(survey_run_id, user_id)
    if kind == "timeline":
        return f"survey_timeline_{ids}.csv"
    if kind == "combined":
        return f"survey_timeline_combined_{ids}.csv"
    if kind == "zip":
        user = _short(user_id)
        return f"ciq_export_{user}_{survey_run_id}.zip" if user else f"ciq_export_{survey_run_id}.zip"
    if kind == "eeg":
        if in_zip:
            return f"eeg/eeg_segment{segment}_{ids}.json" if segment is not None else f"eeg/eeg_session_{ids}.json"
        return f"eeg_session_{ids}_segment{segment}.json" if segment is not None else f"eeg_session_{ids}.json"
    raise ValueError(f"unknown export kind: {kind!r}")
