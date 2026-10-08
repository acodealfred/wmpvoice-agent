# Voice features (pitch, loudness, pauses)

Status: **implemented, on by default** (`ENABLE_VOICE_FEATURES`, set `false` to stop).
Code: `app/backend/ciq/voice/` · Library: `praat-parselmouth` (Praat, GPL-3 — approved).

## What is measured

Only the **user's** mic audio, only **during the survey**. Never during the baseline
protocol, never while the agent is speaking (its voice can leak into the mic). Raw
audio is held in memory for the live connection only and is **never stored**.

### Every second → `survey_timeline_frames`

| Column | Meaning |
|---|---|
| `pitch_hz` | Median pitch (F0) of the voiced part of that second; NULL when the user wasn't speaking |
| `intensity_db` | Mean loudness (dB, relative — see cautions) |
| `voiced` | 1 when at least 20% of the second had a pitch (the user was speaking), else 0 |

### Every answer → `survey_item_responses`

Computed over everything the user said since the previous recorded answer.

| Column | Meaning |
|---|---|
| `voice_pitch_mean_hz`, `voice_pitch_sd_hz`, `voice_pitch_min_hz`, `voice_pitch_max_hz` | Pitch level and variability (low SD = flat / monotone) |
| `voice_intensity_mean_db`, `voice_intensity_sd_db` | Loudness level and variability |
| `voice_voiced_fraction` | Share of the analysed audio with voiced speech |
| `voice_pause_count`, `voice_pause_total_ms`, `voice_pause_max_ms` | Silent gaps **≥ 250 ms between** speech (leading/trailing silence is not a pause) |
| `voice_speech_ms` | Talking time: first-to-last voiced frame minus pauses |

All NULL when the feature is off or there was too little speech (< 0.1 s voiced).
These values are **recorded and exported only** — not shown in the UI, not given to
the AI agent, not used in the report.

## Where it appears

- **Timeline CSV / combined CSV** (Admin panel and Data Validation downloads, and the
  Data Validation ZIP): `pitch_hz`, `intensity_db`, `voiced` are the **last three
  per-second columns** of the timeline block. In the combined CSV they sit before the
  EEG columns, so the EEG columns moved right by 3.
- **SURVEY RESPONSES** block at the bottom of both CSVs: the 11 per-answer columns
  after `effective_score`.

## How it works (performance)

```
WS /realtime  input_audio_buffer.append  ──► capture_mic_audio: append to per-session
                                              VoiceBuffer (no analysis on the relay)
timeline sampler (1 Hz)                  ──► refresh_window_features: last 1 s → voice pool
input_audio_buffer.speech_stopped        ──► schedule_answer_analysis: answer audio → voice pool
record_survey_response tool              ──► finalize_answer_features: wait ≤ 2 s, attach, clear
WS disconnect / new survey               ──► reset_voice: drop all audio
```

- Analysis runs in a dedicated 2-thread pool (`ciq/voice/executor.py`), never on the
  event loop; measured ≈ 4 ms of CPU per second of speech per user.
- Per-session answer buffer is capped at 120 s (≈ 5.8 MB, oldest dropped).
- Any Praat error → that reading is NULL and a warning is logged; the conversation is
  never affected.
- The report-time save of answers (from the browser) carries no voice values; the DB
  upsert uses `COALESCE`, so the live answer's values are kept.

## Cautions for analysis

- **Loudness is relative.** The browser's echo cancellation, noise suppression and
  auto-gain change levels. Compare a user's answers with their own other answers,
  never across users or devices.
- Pitch is robust to those; pauses depend on a pitch-based voicing decision, so a very
  noisy room can split or merge pauses.
- An answer's audio includes anything the user said since the previous answer
  (e.g. a clarification request), not only the answer itself.

## Turning it off

Set `ENABLE_VOICE_FEATURES=false` in the backend environment: capture stops immediately,
new rows get NULL voice columns, nothing else changes.
