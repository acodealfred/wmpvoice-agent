"""Per-second EEG/PPG/motion columns for a survey timeline, joined on one UTC clock.

Shared by the admin "Download Combined (CSV)" route and scripts/sync_muse_survey.py,
so both always produce the same numbers. Needs only numpy and scipy.

Timing. The Muse file's `t0_epoch_ms` is a UTC reading (taken in the browser) at the
moment the packet clock `t_ms` was zeroed. Each packet's `seq` is a raw uint16 that
does not start at zero (a retake begins mid-stream) and wraps at 65536, so
`t0_epoch_ms + seq * ...` is wrong. Instead, per stream:

    rel_i  = unwrapped seq, relative to the first packet   (channels that share seq are pooled)
    P      = 1000 * samples_per_packet / rate_hz            (46.875 ms EEG, 93.75 ms PPG)
    lag_i  = t_ms_i - rel_i * P                             (arrival jitter only ever adds to this)
    first sample epoch = t0_epoch_ms + min(lag_i)
    sample epoch       = first sample epoch + rel_i * P + 1000 * k / rate_hz

The join key is each timeline row's own `timestamp` (server UTC), never
`elapsed_seconds`. Windows trail the row: (timestamp - width, timestamp].

Known limits. The browser's clock (t0_epoch_ms) and the server's clock are assumed to
agree; `clock_gap_seconds` cross-checks that when the file has `survey_started_t_ms`.
A packet is stamped when complete, so sample times run about one packet period late
(~47 ms EEG, ~94 ms PPG).
"""
import math
from datetime import UTC, datetime

import numpy as np
from scipy.signal import butter, find_peaks, sosfiltfilt, welch

_BAND_CHANNELS = ("TP9", "TP10", "AF8")
_BANDS = (("theta", 4.0, 8.0), ("alpha", 8.0, 13.0), ("beta", 13.0, 30.0))
_TOTAL_POWER_HZ = (1.0, 45.0)
_QUALITY_WORST_LAST = ("good", "noisy", "muscle", "no_contact")

# Start (browser clock) to the agent's first turn (server clock) is normally 1-4 s. Outside
# this range the two clocks probably disagree.
_EXPECTED_START_TO_AGENT_S = (-1.5, 12.0)

EEG_COLUMNS = [
    *(f"{ch.lower()}_{band}_rel" for ch in _BAND_CHANNELS for band, _, _ in _BANDS),
    "eeg_quality",
    "pulse_bpm",
    "pulse_quality",
    "prv_rmssd_ms",
    "head_motion",
]


def unwrap_seq(seqs) -> np.ndarray:
    """Undo the 16-bit wrap (a drop of more than 32768 is a wrap), then make the first packet 0."""
    seqs = np.asarray(seqs, dtype=np.int64)
    unwrapped = seqs + np.cumsum(np.diff(seqs, prepend=seqs[0]) < -32768) * 65536
    return unwrapped - unwrapped[0]


def _timed_streams(packets: list, rate_hz: float, t0_epoch_ms: float, group=lambda p: p.get("ch")) -> dict:
    """{group: (epoch_ms, values)} — every sample of each group on the UTC clock, time-sorted.

    The timing anchor is pooled over all packets given (for EEG that is all four channels,
    which share `seq`)."""
    if not packets:
        return {}
    per_packet = len(packets[0]["v"])
    packets = [p for p in packets if len(p["v"]) == per_packet]
    rel = unwrap_seq([p["seq"] for p in packets])
    arrival = np.array([p["t_ms"] for p in packets], dtype=float)
    period = 1000.0 * per_packet / rate_hz
    first_sample = t0_epoch_ms + (arrival - rel * period).min()
    epoch = first_sample + rel[:, None] * period + 1000.0 * np.arange(per_packet) / rate_hz
    values = np.array([p["v"] for p in packets], dtype=float)
    labels = np.array([str(group(p)) for p in packets])
    streams = {}
    for name in dict.fromkeys(labels.tolist()):
        mine = labels == name
        times = epoch[mine].ravel()
        vals = values[mine].reshape(-1, *values.shape[2:])
        order = np.argsort(times, kind="stable")
        streams[name] = (times[order], vals[order])
    return streams


def _window(stream, lo_ms: float, hi_ms: float) -> np.ndarray:
    times, values = stream
    a, b = np.searchsorted(times, (lo_ms, hi_ms), side="right")
    return values[a:b]


def _relative_bands(x: np.ndarray, fs: float):
    if len(x) < 0.9 * 4 * fs:
        return None
    freqs, psd = welch(x, fs=fs, nperseg=int(2 * fs))
    total = psd[(freqs >= _TOTAL_POWER_HZ[0]) & (freqs <= _TOTAL_POWER_HZ[1])].sum()
    if total <= 0:
        return None
    return [psd[(freqs >= lo) & (freqs < hi)].sum() / total for _, lo, hi in _BANDS]


def _quality(windows: list, fs: float):
    labels = []
    for x in windows:
        if len(x) < fs / 2:
            continue
        std, peak_to_peak = float(x.std()), float(x.max() - x.min())
        if peak_to_peak > 400 or std < 0.1:
            labels.append("no_contact")
        elif std > 60:
            labels.append("muscle")
        elif std > 25:
            labels.append("noisy")
        else:
            labels.append("good")
    return max(labels, key=_QUALITY_WORST_LAST.index) if labels else None


def _beats(packets: list, rate_hz: float, t0_epoch_ms: float):
    """Systolic peak times (epoch ms), intervals (s) and accepted-flags, from the infrared channel."""
    infrared = [p for p in packets if p.get("ch") == "infrared"]
    stream = _timed_streams(infrared, rate_hz, t0_epoch_ms, group=lambda p: "ir").get("ir")
    if stream is None or len(stream[0]) < rate_hz * 10:
        return None
    times, counts = stream
    sos = butter(2, [0.7, 3.5], btype="band", fs=rate_hz, output="sos")
    filtered = sosfiltfilt(sos, counts - counts.mean())
    peaks, _ = find_peaks(filtered, distance=max(1, round(0.4 * rate_hz)))
    intervals = np.diff(times[peaks]) / 1000.0
    return times[peaks], intervals, (intervals >= 0.35) & (intervals <= 1.5)


def _intervals(beats, t_ms: float, width_s: float):
    """Intervals whose two beats both fall inside (t - width, t], and whether each was accepted."""
    peak_times, intervals, accepted = beats
    a, b = np.searchsorted(peak_times, (t_ms - width_s * 1000.0, t_ms), side="right")
    end = max(b - 1, a)
    return intervals[a:end], accepted[a:end]


def _pulse(beats, t_ms: float):
    intervals, accepted = _intervals(beats, t_ms, 15.0)
    if len(intervals) == 0:
        return None, None
    valid = intervals[accepted]
    bpm = 60.0 / valid.mean() if len(valid) else None
    return bpm, 1.0 - len(valid) / len(intervals)


def _rmssd_ms(beats, t_ms: float):
    intervals, accepted = _intervals(beats, t_ms, 60.0)
    if accepted.sum() < 5:
        return None
    # Only differences between neighbouring accepted intervals: a rejected one in
    # between means the two aren't successive beats.
    diffs = np.diff(intervals)[accepted[:-1] & accepted[1:]]
    return math.sqrt(float((diffs**2).mean())) * 1000.0 if len(diffs) else None


def _head_motion(stream, t_ms: float, fs: float):
    xyz = _window(stream, t_ms - 1000.0, t_ms)
    if len(xyz) < fs / 2:
        return None
    return float(np.linalg.norm(xyz, axis=1).std())


def _round(value, places: int):
    return None if value is None else round(float(value), places)


def _epoch_ms(iso: str) -> float:
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp() * 1000.0


def _utc_text(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000.0, UTC).strftime("%Y-%m-%d %H:%M:%S")


def clock_gap_seconds(file_json: dict, frames: list[dict]):
    """Seconds from Start (browser clock, from the file) to the timeline's first agent row
    (server clock), or None when the file has no start anchor or the timeline has no agent row.

    Normally 1-4 s. Far outside that, the browser and server clocks probably disagree, and
    every EEG value is shifted by about that much."""
    t0, anchor = file_json.get("t0_epoch_ms"), file_json.get("survey_started_t_ms")
    if t0 is None or anchor is None:
        return None
    for frame in frames:
        if str(frame.get("turn_state", "")).startswith("agent"):
            return (_epoch_ms(frame["timestamp"]) - (t0 + anchor)) / 1000.0
    return None


def compute_unified_columns(file_json: dict, frames: list[dict]) -> tuple[list[dict], list[str]]:
    """({column: value | None} per timeline frame, in EEG_COLUMNS order; plain-text warnings).

    `frames` need only `timestamp` (ISO, UTC) and, for the clock cross-check, `turn_state`.
    Nothing is dropped: a row with no usable EEG simply has empty cells."""
    rows = [dict.fromkeys(EEG_COLUMNS) for _ in frames]
    t0 = file_json.get("t0_epoch_ms")
    if t0 is None:
        return rows, ["The recording has no t0_epoch_ms (streaming never started), so it cannot be lined up with the timeline."]
    warnings = []

    eeg = file_json.get("eeg") or {}
    eeg_fs = eeg.get("rate_hz") or 256
    eeg_streams = _timed_streams(eeg.get("packets") or [], eeg_fs, t0)
    if not eeg_streams:
        warnings.append("The recording has no EEG packets.")
    for ch in _BAND_CHANNELS:
        if eeg_streams and ch not in eeg_streams:
            warnings.append(f"No {ch} packets in the recording, so the {ch.lower()}_* band columns are empty.")

    ppg = file_json.get("ppg") or {}
    beats = _beats(ppg.get("packets") or [], ppg.get("rate_hz") or 64, t0)
    if beats is None:
        warnings.append("No usable infrared PPG in the recording, so the pulse and PRV columns are empty.")

    accel = file_json.get("accelerometer") or {}
    accel_fs = accel.get("rate_hz") or 52
    accel_stream = _timed_streams(accel.get("packets") or [], accel_fs, t0, group=lambda p: "accel").get("accel")
    if accel_stream is None:
        warnings.append("No accelerometer packets in the recording, so head_motion is empty.")

    if file_json.get("truncated"):
        warnings.append("The recording hit the recorder's packet cap and stops early; later rows have no EEG.")

    row_ms = [_epoch_ms(f["timestamp"]) for f in frames]
    for row, t in zip(rows, row_ms):
        for ch in _BAND_CHANNELS:
            stream = eeg_streams.get(ch)
            bands = _relative_bands(_window(stream, t - 4000.0, t), eeg_fs) if stream else None
            for (band, _, _), value in zip(_BANDS, bands or [None] * len(_BANDS)):
                row[f"{ch.lower()}_{band}_rel"] = _round(value, 4)
        row["eeg_quality"] = _quality([_window(s, t - 1000.0, t) for s in eeg_streams.values()], eeg_fs)
        if beats:
            bpm, quality = _pulse(beats, t)
            row["pulse_bpm"] = _round(bpm, 2)
            row["pulse_quality"] = _round(quality, 3)
            row["prv_rmssd_ms"] = _round(_rmssd_ms(beats, t), 2)
        if accel_stream:
            row["head_motion"] = _round(_head_motion(accel_stream, t, accel_fs), 5)

    if row_ms and eeg_streams and not any(r["eeg_quality"] for r in rows):
        starts = [s[0][0] for s in eeg_streams.values()]
        ends = [s[0][-1] for s in eeg_streams.values()]
        warnings.append(
            f"No overlap: the recording spans {_utc_text(min(starts))} to {_utc_text(max(ends))} UTC "
            f"but the timeline spans {_utc_text(min(row_ms))} to {_utc_text(max(row_ms))} UTC."
        )

    gap = clock_gap_seconds(file_json, frames)
    if gap is not None and not _EXPECTED_START_TO_AGENT_S[0] <= gap <= _EXPECTED_START_TO_AGENT_S[1]:
        warnings.append(
            f"Clock check: Start (browser clock) to the agent's first turn (server clock) is {gap:.1f} s, "
            "normally 1-4 s, so the two clocks may disagree and EEG values may be shifted by about that much."
        )
    return rows, warnings
