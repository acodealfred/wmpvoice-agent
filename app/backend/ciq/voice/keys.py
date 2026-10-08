"""Voice feature names — the DB column names and export headers, in order. Kept
free of parselmouth so db.py and the exports can import it cheaply."""

# The browser records the mic at 24 kHz mono PCM16 (components/audio/recorder.ts).
SAMPLE_RATE = 24000

# Per answer → survey_item_responses columns (ciq.voice.features.answer_features keys).
ANSWER_FEATURE_KEYS = (
    "voice_pitch_mean_hz", "voice_pitch_sd_hz", "voice_pitch_min_hz", "voice_pitch_max_hz",
    "voice_intensity_mean_db", "voice_intensity_sd_db", "voice_voiced_fraction",
    "voice_pause_count", "voice_pause_total_ms", "voice_pause_max_ms", "voice_speech_ms",
)

# Per second → survey_timeline_frames columns (ciq.voice.features.window_features keys).
WINDOW_FEATURE_KEYS = ("pitch_hz", "intensity_db", "voiced")
