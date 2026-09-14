# Wiring the Muse into CIQ: write exactly this

The Muse library was handed over as `src/muse/` and a handful of pure `session/`
and `ui/` files, but the page code that actually runs them — connect, start,
label the guided steps, save — was left for the receiving developer to write by
hand. The first CIQ recording (2026-09-11) came out of that with no `markers`
block, and with `recorded_at`, `t0_epoch_ms` and `consent.accepted_at` all
identical to the millisecond. This doc is the wiring that avoids both: read it
once, then use the file below as-is.

## The four things that matter

1. **Connect with `p50`.** It is the only preset that streams PPG — on `p21` or
   `p20` the session file has no pulse data at all, and there is no way to add
   it after the fact.
2. **Take the consent timestamp in the consent handler, before pairing.** The
   prototype page only enables its Pair button once the consent box is ticked,
   so the moment someone agrees is always earlier than the moment they connect.
   Capture it there, not when `connect()` resolves.
3. **Take `t0` from `start()`'s own return value, never a separate `Date.now()`
   call.** Only `start()` knows the instant the packet clock was zeroed —
   anything read a moment before or after it names an instant the packets are
   not actually counted from.
4. **Call `setMarkers` on every EEG packet while a guided run is active.**
   Markers are derived from session time, not wall time, so they need to be
   recomputed as that clock advances. Skip this line and the file has no
   `markers` block even when the participant ran every step.

## The code

The file is `src/session/wiring.example.ts`. Import it directly, or paste its
contents into a hook — it has no page-specific code in it.

<!-- BEGIN src/session/wiring.example.ts -->
```ts
// The wiring an app writes to record a session: the same steps the prototype page
// takes in main.ts, with nothing page-specific. docs/muse-wiring.md shows this file
// verbatim, and wiring.example.test.ts keeps the two identical.
import type { MuseSource } from "../muse";
import { Recorder, type SessionFile } from "./recorder";
import { BENCH_PROTOCOL, ProtocolRun, type ProtocolState } from "./protocol";
import { sessionFilename } from "../ui/download";

export interface MuseRecording {
    /** Begin the guided bench protocol from the current session time. */
    startGuidedRun(): void;
    /** The step to show on screen, or null before a guided run starts. */
    guidedState(): ProtocolState | null;
    /** The file to save, and its name. Recording carries on; call it as often as you like. */
    finish(): { file: SessionFile; filename: string };
    /** Stop streaming and release the headband. */
    stop(): Promise<void>;
}

/** `consentAcceptedAt` is when the person agreed: take it in your consent handler, before pairing. */
export async function startRecording(source: MuseSource, consentAcceptedAt: string): Promise<MuseRecording> {
    // p50 is the only preset that streams PPG. On p21 the file has no pulse data.
    const preset = "p50";
    const device = await source.connect({ preset });
    const recordedAt = new Date();
    const recorder = new Recorder({ device, preset, consentAcceptedAt, recordedAt: recordedAt.toISOString() });

    // Session time as the packets carry it, so markers share a clock with the samples.
    let sessionTMs = 0;
    let guided: ProtocolRun | null = null;

    const off = [
        source.on("eeg", r => {
            sessionTMs = r.tMs;
            recorder.push(r);
            // Without this line the file has no markers, even when the steps were run.
            if (guided) recorder.setMarkers(guided.marks(sessionTMs));
        }),
        source.on("imu", r => recorder.push(r)),
        source.on("ppg", r => recorder.push(r)),
        source.on("telemetry", r => recorder.push(r))
    ];

    try {
        // t0 comes from start() itself, never a separate Date.now(): only start()
        // knows the instant the packet clock was zeroed.
        const started = await source.start();
        recorder.markStarted(started.epochMs);
    } catch (e) {
        // Streaming never began. Release the headband so it can be paired again.
        for (const f of off) f();
        await source.stop().catch(() => undefined);
        throw e;
    }

    return {
        startGuidedRun: () => {
            guided = new ProtocolRun(BENCH_PROTOCOL, sessionTMs);
        },
        guidedState: () => (guided ? guided.at(sessionTMs) : null),
        finish: () => ({ file: recorder.finish(), filename: sessionFilename(recordedAt, device.name) }),
        stop: async () => {
            for (const f of off) f();
            await source.stop();
        }
    };
}
```
<!-- END src/session/wiring.example.ts -->

## Using it from a React hook

- Hold the object `startRecording` resolves to in a `useRef` — it is the handle
  for the rest of the recording, not something to re-derive from state.
- The Start-steps button calls `startGuidedRun()` on it. Nothing else needs to
  happen for markers to start accumulating; the wiring above does that per
  packet on its own.
- Render `guidedState()` on a roughly 500 ms interval to drive the on-screen
  step name and countdown. It is a pure read, safe to poll.
- Save calls `finish()` to get `{ file, filename }`, then `downloadJson(file,
  filename)` from `src/ui/download.ts`.
- Subscribe to `source.on("disconnected", ...)` separately, outside this
  wiring, to tell the user the headband dropped. The recording is not lost —
  `finish()` still works after a disconnect, since it reads whatever was
  captured before the connection ended.
- Call `stop()` on unmount so the headband is released rather than left
  connected to a component that no longer exists.

## Before you record

- Run the laptop on battery, away from power strips. The first CIQ recording
  carried 13–28 dB of 50 Hz mains hum on three channels, against ≤3 dB on the
  2026-09-04 bench recording. A charger and poor electrode contact are the
  usual sources.
- Wait until all four traces settle before starting. Clear hair away from the
  forehead sensors (AF7, AF8) and make sure the sensors behind the ears (TP9,
  TP10) touch skin. AF7 sat at a mean of −462 µV through the whole first CIQ
  file, which points to poor contact from start to finish.
- Keep the laptop near the headband with nothing between them. That same file
  lost roughly 10 seconds of data to two Bluetooth gaps.
- Sit still, and run the full guided steps rather than a partial run — the
  protocol order in `src/session/protocol.ts` is deliberate and covers baseline,
  eyes closed, eyes open, blinks and jaw clench in that sequence.
- Analysis discards the first ~20 s of the eyes-closed block while the signal
  settles, so only its last 40 s count. Do not cut the run short.

## Check the saved file

Before handing a recording off for analysis, open it and confirm:

- `"preset": "p50"`.
- A `ppg` block is present and its `packets` array is non-empty.
- A `markers` block is present with five entries in order — `baseline`, `eyes
  closed`, `eyes open`, `blinks`, `jaw clench` (the labels come from
  `BENCH_PROTOCOL` in `src/session/protocol.ts`). If it is missing, the guided
  run either was not started or `setMarkers` was not wired to every EEG packet.
- `consent.accepted_at` is earlier than `recorded_at` — consent happens before
  pairing, so it cannot come after.
- `t0_epoch_ms` is at or after `recorded_at`. They are not required to differ:
  with a fast `start()` they can land on the same millisecond, which is fine —
  what matters is that `t0_epoch_ms` came from `start()` itself and not from a
  separately read clock.
- The filename matches `muse-session-<time>-<device>.json`.
- `dropped_packets` is at or near zero on every channel.
