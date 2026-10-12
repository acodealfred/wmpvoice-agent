"""muse_id column of the combined timeline + EEG CSV (ciq.api.history_routes)."""
import csv
import io

from ciq.api import history_routes
from ciq.api.history_routes import muse_ids_by_segment
from ciq.eeg.combine import EEG_COLUMNS


def test_muse_id_per_segment_from_column_then_file():
    segments = [
        {"segment_index": 0, "device_name": "Muse-39E1", "file_json": {"device": {"name": "ignored"}}},
        {"segment_index": 1, "device_name": None, "file_json": {"device": {"name": "Muse-7A02"}}},
        {"segment_index": 2, "file_json": {"segment": 2}},
        {"segment_index": 3, "device_name": "", "file_json": {"device": "not a dict"}},
    ]
    assert muse_ids_by_segment(segments) == {0: "Muse-39E1", 1: "Muse-7A02", 2: "", 3: ""}


def _frame(i: int, segment: int) -> dict:
    keys = ("timestamp", "question_id", "question_index", "blink_rate_bpm", "blink_rate_change_percent",
            "left_gaze_position", "right_gaze_position", "face_emotion", "voice_sentiment", "stress_state")
    return {**dict.fromkeys(keys), "frame_index": i, "segment_index": segment, "turn_state": "idle",
            "user_id": "u1", "survey_run_id": "run-1"}


async def test_combined_csv_tags_each_row_with_its_segments_headband(monkeypatch):
    segments = [
        {"segment_index": 0, "device_name": "Muse-39E1", "file_json": {}},
        {"segment_index": 1, "device_name": "Muse-7A02", "file_json": {}},
    ]
    frames = [_frame(0, 0), _frame(1, 0), _frame(2, 1), _frame(3, 2)]

    async def get_segments(_run):
        return segments

    async def get_frames(_run):
        return frames

    async def no_summary(_run):
        return []

    monkeypatch.setattr(history_routes, "get_eeg_segments", get_segments)
    monkeypatch.setattr(history_routes, "get_survey_timeline_frames", get_frames)
    monkeypatch.setattr(history_routes, "_summary_rows", no_summary)
    monkeypatch.setattr(history_routes, "combine_segments",
                        lambda _files, fr: ([dict.fromkeys(EEG_COLUMNS) for _ in fr], []))

    body, _warnings = await history_routes.build_combined_csv("run-1")
    header, *rows = list(csv.reader(io.StringIO(body)))
    col = header.index("muse_id")
    assert header[col + 1] == EEG_COLUMNS[0]  # sits just before the EEG columns
    # Same headband → same id; the reconnected segment shows the other headband;
    # a segment with no recording (2) is blank.
    assert [r[col] for r in rows] == ["Muse-39E1", "Muse-39E1", "Muse-7A02", ""]
