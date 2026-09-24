#!/usr/bin/env python3
"""Join a Muse session recording (JSON) with its survey timeline (CSV) on one UTC clock.

    python scripts/sync_muse_survey.py SESSION.json TIMELINE.csv [-o OUT.csv]

Every timeline row is kept, in order, with all its original columns, and the EEG
columns (band power, signal quality, pulse, PRV, head motion) are added to it. Rows
are joined on the CSV's own `timestamp` column, never `elapsed_seconds`.

All the maths lives in app/backend/ciq/eeg/combine.py, the same module behind the
admin "Download Combined (CSV)" button, so the two always agree. Needs numpy and scipy:
    pip install numpy scipy
"""
import argparse
import csv
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path

COMBINE_PATH = Path(__file__).resolve().parents[1] / "app" / "backend" / "ciq" / "eeg" / "combine.py"


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def load_combine():
    spec = importlib.util.spec_from_file_location("muse_combine", COMBINE_PATH)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except ImportError as e:
        fail(f"{e}. Install the dependencies with: pip install numpy scipy")
    return module


def read_session(path: Path) -> dict:
    try:
        session = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"session file not found: {path}")
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        fail(f"{path} is not valid JSON: {e}")
    if not isinstance(session, dict) or "eeg" not in session:
        fail(f"{path} does not look like a muse-web-bridge session file (no 'eeg' section).")
    return session


def read_timeline(path: Path) -> tuple[list[str], list[dict]]:
    try:
        with path.open(newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            columns, rows = reader.fieldnames or [], list(reader)
    except FileNotFoundError:
        fail(f"timeline file not found: {path}")
    if "timestamp" not in columns:
        fail(f"{path} has no 'timestamp' column (it should be a survey timeline export).")
    if not rows:
        fail(f"{path} has no rows.")
    for number, row in enumerate(rows, start=2):
        try:
            datetime.fromisoformat(row["timestamp"])
        except (TypeError, ValueError):
            fail(f"{path} line {number}: cannot read timestamp {row['timestamp']!r} (expected ISO 8601, UTC).")
    return columns, rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Join a Muse session JSON with a survey timeline CSV on the UTC clock.")
    parser.add_argument("session", type=Path, help="Muse session .json (the raw EEG download)")
    parser.add_argument("timeline", type=Path, help="survey timeline .csv (the timeline download)")
    parser.add_argument("-o", "--output", type=Path, help="output CSV (default: <timeline>_with_muse.csv)")
    args = parser.parse_args()

    combine = load_combine()
    session = read_session(args.session)
    columns, frames = read_timeline(args.timeline)

    try:
        eeg_rows, warnings = combine.compute_unified_columns(session, frames)
    except (KeyError, TypeError, ValueError, IndexError) as e:
        fail(f"the session file is malformed: {e!r}")

    output = args.output or args.timeline.with_name(f"{args.timeline.stem}_with_muse.csv")
    fieldnames = [c for c in columns if c not in combine.EEG_COLUMNS] + combine.EEG_COLUMNS
    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for frame, eeg in zip(frames, eeg_rows):
            writer.writerow({**frame, **{c: "" if v is None else v for c, v in eeg.items()}})

    eeg = session.get("eeg") or {}
    print(
        f"session: {len(eeg.get('packets') or [])} EEG, {len((session.get('ppg') or {}).get('packets') or [])} PPG, "
        f"{len((session.get('accelerometer') or {}).get('packets') or [])} accelerometer packets"
    )
    print(f"timeline: {len(frames)} rows -> {output}")
    for column in combine.EEG_COLUMNS:
        filled = sum(1 for r in eeg_rows if r[column] is not None)
        print(f"  {column:16} {filled:5} / {len(frames)} rows filled")
    gap = combine.clock_gap_seconds(session, frames)
    if gap is not None:
        print(f"clock check: Start to the agent's first turn = {gap:.1f} s (normally 1-4 s)")
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)


if __name__ == "__main__":
    main()
