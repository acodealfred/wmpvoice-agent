"""Pure validation rules for the Live Monitor — no I/O, unit-testable.

Each second gets a level per stream — ``ok`` | ``warn`` | ``bad`` | ``off`` (not in
use, e.g. the participant went on without EEG) — plus plain-English issues.
"""

LEVELS = ("off", "ok", "warn", "bad")

EEG_CHANNELS = ("TP9", "AF7", "AF8", "TP10")
EEG_EXPECTED_PER_S = 256
EEG_WARN_BELOW = 230
EEG_BAD_BELOW = 128
FLAT_STD_UV = 0.1
SWING_WARN_UV = 400.0
DROPPED_BAD_PER_S = 20
BATTERY_WARN_PERCENT = 10
NO_FACE_WARN_S = 5
NO_FACE_BAD_S = 30
NO_MIC_WARN_S = 60
# No tick for this long while the WebSocket is open → the page stopped reporting.
STALE_AFTER_S = 3.0


def worst(levels) -> str:
    """The most severe level of those given ("off" when none)."""
    return max(levels, key=LEVELS.index, default="off")


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def assess_channel(ch: str, stats, contact) -> tuple[str, list[str]]:
    """One EEG channel's second: sample count, NaNs, flat line, swings, contact."""
    stats = stats if isinstance(stats, dict) else {}
    n = _num(stats.get("n")) or 0
    nan = _num(stats.get("nan")) or 0
    std = _num(stats.get("std"))
    lo, hi = _num(stats.get("min")), _num(stats.get("max"))
    issues, levels = [], ["ok"]
    if n == 0:
        return "bad", [f"{ch}: no samples"]
    if n < EEG_BAD_BELOW:
        levels.append("bad")
        issues.append(f"{ch}: only {n}/{EEG_EXPECTED_PER_S} samples")
    elif n < EEG_WARN_BELOW:
        levels.append("warn")
        issues.append(f"{ch}: {n}/{EEG_EXPECTED_PER_S} samples")
    if nan:
        levels.append("bad")
        issues.append(f"{ch}: {nan} NaN values")
    if std is not None and std < FLAT_STD_UV:
        levels.append("bad")
        issues.append(f"{ch}: flat signal")
    if lo is not None and hi is not None and hi - lo > SWING_WARN_UV:
        levels.append("warn")
        issues.append(f"{ch}: very large swings ({round(hi - lo)} µV) — movement or poor contact")
    if contact == "floating":
        levels.append("bad")
        issues.append(f"{ch}: poor contact")
    elif contact == "marginal":
        levels.append("warn")
        issues.append(f"{ch}: weak contact")
    return worst(levels), issues


def assess_eeg(eeg) -> tuple[str, dict, list[str]]:
    """(overall level, {channel: level}, issues) for one tick's EEG block."""
    eeg = eeg if isinstance(eeg, dict) else {}
    status = eeg.get("status")
    if status != "streaming" and not eeg.get("expected"):
        return "off", {ch: "off" for ch in EEG_CHANNELS}, []
    if status != "streaming":
        return "bad", {ch: "bad" for ch in EEG_CHANNELS}, ["EEG headband disconnected"]

    channels = eeg.get("channels") if isinstance(eeg.get("channels"), dict) else {}
    contact = eeg.get("contact") if isinstance(eeg.get("contact"), dict) else {}
    ch_levels, issues = {}, []
    for ch in EEG_CHANNELS:
        ch_levels[ch], ch_issues = assess_channel(ch, channels.get(ch), contact.get(ch))
        issues += ch_issues

    levels = list(ch_levels.values())
    if eeg.get("truncated"):
        levels.append("bad")
        issues.append("EEG recording hit its size cap — later EEG is being lost")
    dropped = _num(eeg.get("dropped")) or 0
    if dropped > DROPPED_BAD_PER_S:
        levels.append("bad")
        issues.append(f"{dropped} EEG packets lost (Bluetooth)")
    elif dropped > 0:
        levels.append("warn")
        issues.append(f"{dropped} EEG packets lost")
    battery = _num(eeg.get("battery"))
    if battery is not None and battery <= BATTERY_WARN_PERCENT:
        levels.append("warn")
        issues.append(f"Headband battery low ({round(battery)}%)")
    return worst(levels), ch_levels, issues


def assess_camera(camera, no_face_streak_s: int) -> tuple[str, list[str]]:
    camera = camera if isinstance(camera, dict) else {}
    if not camera.get("enabled"):
        return "off", []
    if no_face_streak_s >= NO_FACE_BAD_S:
        return "bad", [f"No face on camera for {no_face_streak_s} s"]
    if no_face_streak_s >= NO_FACE_WARN_S:
        return "warn", [f"No face on camera for {no_face_streak_s} s"]
    return "ok", []


def assess_mic(stage: str, no_mic_streak_s: int) -> tuple[str, list[str]]:
    # The PILOT report locks the mic on purpose; nothing to judge there.
    if stage == "report":
        return "off", []
    if no_mic_streak_s >= NO_MIC_WARN_S:
        return "warn", [f"No microphone audio for {no_mic_streak_s} s"]
    return "ok", []


def assess_timeline(stage: str, timeline_active: bool) -> tuple[str, list[str]]:
    if stage in ("survey",) and not timeline_active:
        return "bad", ["Per-second timeline is not recording"]
    return ("ok" if timeline_active else "off"), []


def phase_of(stage: str, conversation_state: str, answered: int, total: int) -> str:
    """baseline_setup | baseline_eyes_open | baseline_eyes_closed | survey | report."""
    if conversation_state in ("report_delivered", "qa_mode") or (total and answered >= total):
        return "report"
    return stage


def connection_state(now: float, last_tick_at, open_ws: int) -> tuple[str, list[str]]:
    """live | stale | offline, with the issue to show for the last two."""
    if open_ws <= 0:
        return "offline", ["Browser disconnected (tab closed or network lost)"]
    if last_tick_at is None or now - last_tick_at > STALE_AFTER_S:
        return "stale", ["Browser stopped reporting (tab in background or frozen?)"]
    return "live", []
