// Builds an example session file from the simulated headband, with no hardware
// and no browser, so a consuming app has something concrete to read against the
// schema. `scripts/make-example-session.ts` writes the committed fixture.
//
// What this file is NOT: evidence that anything works on real hardware. The
// simulator's PPG is a constant-amplitude sine, identical on all three optical
// channels — real PPG is neither. Do not calibrate a beat detector against it
// (docs/muse-2-findings.md records what real data does instead).
import { SimulatedMuse } from "../muse/simulated";
import type { Preset } from "../muse/protocol";
import type { StartInstant } from "../muse/types";
import { Recorder, type SessionFile } from "./recorder";

/** 2026-09-04T09:15:00Z — the hardware validation date, so the fixture reads as of a piece with the findings. */
export const EXAMPLE_EPOCH_MS = Date.parse("2026-09-04T09:15:00.000Z");
export const EXAMPLE_SEED = 20260904;
/** The page is set up before streaming begins; the fixture keeps that gap visible. */
const EXAMPLE_RECORDED_AT = "2026-09-04T09:14:52.000Z";
const EXAMPLE_CONSENT_AT = "2026-09-04T09:14:40.000Z";

export interface ExampleOptions {
    durationMs?: number;
    preset?: Preset;
    dropEvery?: number;
    /**
     * Virtual-clock step. This is part of the fixture's identity, not a free
     * knob: `seq` and `t_ms` come from per-stream counters and so are unaffected,
     * but the simulator draws every stream's noise from ONE shared PRNG, so the
     * step size changes how those draws interleave and therefore the sample
     * values. Change it and the committed fixture changes.
     */
    stepMs?: number;
}

type IntervalFn = () => void;

/**
 * Runs the simulator on a virtual clock: `setInterval` is captured rather than
 * scheduled, and time is advanced by hand. The result is deterministic and
 * takes milliseconds instead of the wall-clock duration it represents.
 */
export async function generateExampleSession(opts: ExampleOptions = {}): Promise<SessionFile> {
    const durationMs = opts.durationMs ?? 20_000;
    const preset = opts.preset ?? "p50";
    const stepMs = opts.stepMs ?? 250;

    const callbacks: IntervalFn[] = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let virtualMs = 0;

    globalThis.setInterval = ((fn: IntervalFn) => {
        callbacks.push(fn);
        return callbacks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = (() => {}) as typeof globalThis.clearInterval;

    try {
        const source = new SimulatedMuse({
            seed: EXAMPLE_SEED,
            dropEvery: opts.dropEvery ?? 97,
            now: () => virtualMs,
            startInstant: (): StartInstant => ({ monoMs: virtualMs, epochMs: EXAMPLE_EPOCH_MS })
        });
        // Alpha only appears on TP9/TP10 when the eyes are closed; a flat trace
        // would make a poor example.
        source.eyesClosed = true;

        const device = await source.connect({ preset });
        const recorder = new Recorder({
            device,
            preset,
            consentAcceptedAt: EXAMPLE_CONSENT_AT,
            recordedAt: EXAMPLE_RECORDED_AT
        });
        for (const event of ["eeg", "imu", "ppg", "telemetry"] as const) {
            source.on(event, r => recorder.push(r));
        }

        const t0 = await source.start();
        recorder.markStarted(t0.epochMs);

        for (virtualMs = stepMs; virtualMs <= durationMs; virtualMs += stepMs) {
            for (const fn of callbacks) fn();
        }
        // Land exactly on the boundary, so the packet count is the one the
        // duration implies rather than one step short of it.
        virtualMs = durationMs;
        for (const fn of callbacks) fn();

        await source.stop();
        return recorder.finish();
    } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
    }
}
