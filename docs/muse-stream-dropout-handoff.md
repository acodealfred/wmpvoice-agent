# Muse EEG stream dropout: handoff

Written 2026-10-12. Audience: whoever picks up the follow-up work. Read this top to bottom before touching code.

## Why this exists

In the first pilot (2026-10-11) the Muse EEG recording ended about 3 minutes into the baseline, and nothing in the app said so. The participant's session carried on, the waveform on screen looked fine, and the survey finished with no EEG for most of it. We investigated and found two separate problems:

1. **A real Bluetooth link drop** that we cannot fix from the app. The app must at least make it visible.
2. **A real bug in the recorder** (an undersized safety cap) that would silently cut every recording at about 7.8 minutes anyway, even with a perfect Bluetooth link. It did **not** cause the pilot dropout, but it will hit sessions that last longer than the pilot's first segment.

Your job is the app-side work described under [Tasks](#tasks). You do not need to debug Bluetooth.

## What we know (evidence)

### The pilot dropout

- Pilot export: EEG, accelerometer, gyroscope and PPG all stop within about 30 ms of each other at **181.8 s**. Before that: 0 dropped packets, no gap over 200 ms. The recording was not truncated (15,504 packets, far under the cap). Headset `Muse-3987`, battery 10%.
- The session clock (`sessionTMsRef` in `useMuse.ts`) froze at the same moment, so packets stopped reaching the page, not just the recorder.
- Evidence that the survey continued: the timeline CSV runs for minutes after the EEG ends.

### Reproduction outside the app

The standalone bridge (`CIQ UI UX/muse-web-bridge`, no MVP code at all) reproduced it on the pilot laptop:

| Laptop | Headset | Result |
|---|---|---|
| Dev laptop (Intel MBP, macOS 26.6.2) | Muse-3987 | two clean 12-minute runs |
| Pilot laptop (M5 MBP, macOS 27.0.1, Chrome 155.0.8059.40) | Muse-3987 | stopped at 6:40 |
| Pilot laptop | Muse-39E1 | stopped at 0:43 |
| Pilot laptop, **after Bluetooth was toggled off/on** | Muse-39E1 | clean 12:01 (Wi-Fi off) and clean 12:23 (Wi-Fi on) |

### What the Mac's Bluetooth log said

For both drops on the pilot laptop, `bluetoothd` logged `LE Link disconnected ... reason 708 ... localRole=Central` for Chrome, about **2.04 s** after the last data packet. Signal strength was fine (RSSI -61 to -68 dBm). There was no power-off, no sleep, and no disconnect request from Chrome. Code 708 is undocumented and we could not decode it.

### Ruled out

- The MVP's own recording code (the bridge failed the same way).
- A faulty headset (two headsets failed on the pilot laptop, one passed on the other).
- Low battery (the headset passed at a lower level than where it failed).
- Wi-Fi interference (passed with Wi-Fi on).

### Leading hypothesis (unproven)

A stale Bluetooth stack state on the M5 Mac that a Bluetooth off/on cleared. Only two clean runs back it, so it may come back. **Do not treat this as solved.**

### The recorder cap bug (separate, confirmed in source)

`app/frontend/src/session/recorder.ts:17` sets `MAX_PACKETS_PER_STREAM = 40_000`. The check at `:148-151` is applied to one `this.eeg` array that holds packets from **all four channels** (each record has a `ch` field, `:152`).

- EEG: 256 Hz, 12 samples per packet (`protocol.ts:33-34`), so about 21.3 packets/s per channel and about 85.3 across four. 40,000 / 85.3 = **about 469 s (7 min 49 s)**. With the `p20` preset (adds AUX) it is about 6.25 min.
- The comment at `recorder.ts:12-13` says "~30 minutes". That is true per channel only.
- Past the cap, packets are dropped silently and `truncated` is set. The live chart is fed from separate buffers, so it keeps moving.
- The existing test (`session/recorder.test.ts:158-164`) pushes a single channel (`"TP9"`), so it never exercised the four-channel case.
- Other streams: PPG (3 channels, 64 Hz, 6 samples/packet) reaches the cap at about 20.8 min, and each IMU sensor (52 Hz, 3 samples/packet) at about 38 min.

## What the app can and cannot do

- **Cannot:** auto-reconnect. A reconnect re-runs `source.start()`, which re-anchors the packet clock and breaks alignment with the survey timeline and markers (`useMuse.ts` around line 150, `app/frontend/docs/muse-wiring.md` §3). This has been decided and is final. Do not propose or build it.
- **Cannot:** prevent the Bluetooth drop.
- **Can:** notice that packets stopped, say so clearly in the UI, and mark the saved session so analysis never treats missing EEG as real data.

## Already done (do not redo)

1. **`app/frontend/src/session/stream-monitor.ts`** (+ `stream-monitor.test.ts`, 8 tests). A `StreamMonitor` class that tracks the last packet time per stream (`eeg`, `imu`, `ppg`, `telemetry`), flags a `stall` after 2 s of silence, logs `resumed` when packets return, and logs `disconnected` and a 15 s `heartbeat` with packet counts, battery and `visibilityState`.
2. **Wired into `app/frontend/src/hooks/useMuse.ts`.** It calls `monitor.note(...)` for every packet **before** the pause check, so silence means silence on the link. Events print to the console with the prefix `[muse-diag]`, and the monitor is exposed as `window.__museDiag` (`copy(JSON.stringify(__museDiag.events()))` exports the events).
3. A 12-minute countdown in `muse-web-bridge` (`src/ui/run-timer.ts`). Not part of the MVP; for hardware soak tests only.

The monitor only observes. Use it for tasks 2 and 3; do not duplicate its logic.

## Tasks

Do them in this order, as three separate small PRs. Follow the repo's `.claude/CLAUDE.md` (targeted reads, no broad scans). Write the failing test first for every change, and make sure each test asserts real behavior.

### Task 1: Fix the recorder cap

**Goal:** a recording from a full-length session (30+ minutes) must not be silently truncated by an undersized cap, and the cap's comment must be true.

**Suggested approach (confirm with the lead before implementing):** count the cap **per EEG channel** (and keep it per stream for IMU/PPG), so 40,000 packets per channel is the roughly 31 minutes the comment claims. Keep the safety valve and the `truncated` flag.

**Acceptance criteria**
- A new test pushes four interleaved channels at the real rate for at least 10 minutes (about 51,000 packets) and asserts that **all** packets are kept and `truncated` is absent. It must fail on the current code.
- A test that exceeds the per-channel limit asserts `truncated === true` and that the packet count per channel stops at the limit.
- IMU and PPG limits are unchanged and their tests still pass.
- `recorder.ts` comment at lines 10-17 states the real duration and the per-channel basis.
- **Check the upload size limit.** `app/backend/ciq/eeg/routes.py:18` (`_EEG_UPLOAD_MAX_SIZE = 50 MB`) was sized against the old worst case (see the comment above it, which assumes every stream capped at 40,000 packets total). A per-channel cap raises the worst case about 4x for EEG. For scale, the pilot's 181 s export is about 3.5 MB, so roughly 20 KB per second, which puts 31 minutes near 36 MB. Measure with a realistic generated session (see `app/frontend/src/session/example.ts` or `npm run example:session` in the bridge) and either confirm 50 MB is still enough or change it and the comment. **Ask before changing the limit.**
- `app/backend/ciq/eeg/combine.py:225` already warns when `truncated` is set. Do not change it.

### Task 2: "No data" overlay on the waveform

**Goal:** an operator (or participant) can never mistake a stalled stream for a live one.

Today `components/ui/eeg-waveform.tsx` redraws the last 5 seconds of its buffer on a timer. If packets stop, the canvas either keeps showing the last frame (status "disconnected", the loop stops) or keeps redrawing the same window (status still "streaming"). Nothing signals the stall.

**Approach:** expose a stalled signal from `useMuse()` (derived from the existing `StreamMonitor`, for example by adding a callback or an `isStalled("eeg")` method and a `stalled` piece of state in the hook), and show an overlay such as "NO DATA — headset stopped sending" on the waveform when it is set. Clear it when packets resume. Keep per-packet work out of React state: the 256 Hz stream must not force re-renders (see the comments in `useMuse.ts` and `eeg-waveform.tsx`).

**Acceptance criteria**
- Unit tests for the new monitor/hook-facing logic (stall set after the threshold, cleared on resume, not set before the first packet).
- A rendered check of the overlay that does not need real hardware. `muse/simulated.ts` is a fake headband; use it, and add a way for a test to stop its packets.
- No change to the waveform's normal drawing, colors or scale. **This edits existing UI. Get the lead's approval of the overlay's text and look before merging.**
- `npm run build` (type check) passes.

### Task 3: Mark incomplete sessions

**Goal:** when the stream ended before the session did, the saved session says so, and the UI does not claim success.

Two parts:

1. **Saved file.** Record that the stream stalled or disconnected, and when, in the session JSON (an optional field on `SessionFile` in `recorder.ts`, for example `incomplete: { reason, at_t_ms }`). It must be optional so existing consumers and stored sessions still parse. The backend stores the whole file as `file_json` (`db.py`, `save_eeg_session`), and `app/backend/ciq/eeg/combine.py` reads it, so check both for strict-schema assumptions. Do **not** bump `SESSION_SCHEMA` (`muse-web-bridge/3`) without asking.
2. **UI message.** `components/ui/eeg-connect-panel.tsx:137` says "Recording complete and saved to your assessment." whenever `hasRecording` is true and the headband is no longer connected, even if the link dropped mid-session. Make that message accurate when the session is incomplete.

**Acceptance criteria**
- A test that a recorder told about a stall produces a file with the field set; a normal recording has no such key (same pattern as the existing `truncated` tests at `recorder.test.ts:158-172`).
- A backend test (pytest, `app/backend/tests/`) that a session with the new field uploads and round-trips through `save_eeg_session`. There is currently no test for the EEG upload route, so you will be adding one.
- If `combine.py` should treat the new field the way it treats `truncated`, add a warning plus a test. Ask first if unsure.
- Existing EEG sessions (no field) still load and combine unchanged.

## How to run things

From `app/frontend`:
- `npm test` runs the Vitest suite. It had 206 passing tests when these notes were written.
- `npm run build` runs the TypeScript check and the production build.
- `npm run format` runs Prettier.

From `app/backend`:
- `pytest -q`, or `pytest tests/unit/ -v` and `pytest tests/integration/ -v`.
- `ruff check app/backend` from the repo root.

The headset itself is only needed for a final manual check. Ask the lead; do not block on hardware. The standalone bridge has one unrelated failing test (`src/session/timing.test.ts`, which reads a missing `docs/muse-sync.md`). Ignore it.

## Rules for this work

- Tests for every change, written first, asserting real outcomes (never empty or vacuous).
- Do not edit or overwrite fixed features, workflows or code segments beyond what each task needs. Existing UI changes (tasks 2 and 3) need the lead's approval before merging.
- Do not touch the Bluetooth connect/start code in `muse/client.ts` or the packet clock anchoring.
- No auto-reconnect.
- Verify every claim in this document against the code before relying on it, and tell the lead if one does not hold. The line numbers above were correct on 2026-10-12.

## Out of scope for now

- A low-battery warning at connect time. The headset reports battery in telemetry, but we do not have a trustworthy threshold: runs at 10% and 5% passed, and a run at 20% failed.
- Uploading partial recordings mid-session. Today the upload happens only when the survey completes (`App.tsx` around lines 449-458), so a mid-session drop only becomes visible at the end. Worth a follow-up, but a bigger change.
- Fixing the Bluetooth drop itself. See the hypothesis above; the lead is tracking it.

## Open questions for the lead

1. Per-channel cap versus a larger total cap (task 1)?
2. Wording and look of the overlay (task 2)?
3. Field name and shape for the incomplete marker (task 3)?
