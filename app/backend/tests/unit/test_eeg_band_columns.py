"""Per-channel EEG band columns in the combined CSV (ciq.eeg.combine)."""
from datetime import UTC, datetime

import numpy as np

from ciq.eeg import combine

_T0_MS = 1_790_000_000_000.0
_RATE_HZ = 256
_PER_PACKET = 12


def _eeg_file(channels, seconds=6.0, freq_hz=10.0):
    """A recording of a clean `freq_hz` sine on each channel, packets as the browser stores them."""
    period_ms = 1000.0 * _PER_PACKET / _RATE_HZ
    packets = []
    for seq in range(int(seconds * 1000 / period_ms)):
        t = (seq * _PER_PACKET + np.arange(_PER_PACKET)) / _RATE_HZ
        v = (20.0 * np.sin(2 * np.pi * freq_hz * t)).tolist()
        for ch in channels:
            packets.append({"ch": ch, "seq": seq, "t_ms": (seq + 1) * period_ms, "v": v})
    return {"t0_epoch_ms": _T0_MS, "eeg": {"rate_hz": _RATE_HZ, "packets": packets}}


def _frame_at(seconds_after_t0: float) -> dict:
    ts = datetime.fromtimestamp((_T0_MS + seconds_after_t0 * 1000) / 1000, UTC).isoformat()
    return {"timestamp": ts}


def test_band_columns_follow_muse_channel_order():
    bands = [c for c in combine.EEG_COLUMNS if c.endswith("_rel")]
    assert bands == [f"{ch}_{band}_rel" for ch in ("tp9", "af7", "af8", "tp10") for band in ("theta", "alpha", "beta")]
    assert combine.EEG_COLUMNS[len(bands):] == ["eeg_quality", "pulse_bpm", "pulse_quality", "prv_rmssd_ms", "head_motion"]


def test_af7_band_columns_are_filled():
    (row,), _ = combine.compute_unified_columns(_eeg_file(["TP9", "AF7", "AF8", "TP10"]), [_frame_at(5.5)])
    for ch in ("tp9", "af7", "af8", "tp10"):
        assert row[f"{ch}_alpha_rel"] is not None
        # A 10 Hz sine is alpha.
        assert row[f"{ch}_alpha_rel"] > row[f"{ch}_theta_rel"]
        assert row[f"{ch}_alpha_rel"] > row[f"{ch}_beta_rel"]


def test_missing_af7_leaves_its_columns_empty_and_warns():
    (row,), warnings = combine.compute_unified_columns(_eeg_file(["TP9", "AF8", "TP10"]), [_frame_at(5.5)])
    assert all(row[f"af7_{band}_rel"] is None for band in ("theta", "alpha", "beta"))
    assert row["tp9_alpha_rel"] is not None
    assert any("No AF7 packets" in w for w in warnings)
