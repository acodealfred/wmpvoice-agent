// Exercises the wiring a consuming app is meant to write (session/wiring.example.ts)
// against the simulated headband, and guards docs/muse-wiring.md against drifting
// from the file it claims to show verbatim.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { SimulatedMuse } from "../muse/simulated";
import type { DeviceInfo, MuseSource } from "../muse/types";
import { BENCH_PROTOCOL } from "./protocol";
import { sessionFilename } from "../ui/download";
import { EEG_RATE_HZ, EEG_SAMPLES_PER_PACKET } from "../muse/protocol";
import { startRecording } from "./wiring.example";

const EEG_PERIOD_MS = (1000 * EEG_SAMPLES_PER_PACKET) / EEG_RATE_HZ;

const BASE_EPOCH = Date.parse("2026-09-10T08:00:00.000Z");
// Deliberately earlier than, and a different instant from, when start() runs
// (which lands at BASE_EPOCH under fake timers) — the bug this file guards
// against was consent and recorded_at landing on the same millisecond.
const CONSENT_AT = "2026-09-10T07:58:12.000Z";

/** A fresh simulated headband, recording from BASE_EPOCH under fake timers. */
async function setup() {
    vi.setSystemTime(BASE_EPOCH);
    const sim = new SimulatedMuse({ now: () => Date.now(), seed: 1 });
    const recording = await startRecording(sim, CONSENT_AT);
    return { sim, recording };
}

describe("wiring.example: startRecording", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("records at p50, with a ppg block containing packets", async () => {
        const { recording } = await setup();
        vi.advanceTimersByTime(1000);
        const { file } = recording.finish();
        expect(file.preset).toBe("p50");
        expect(file.ppg).toBeDefined();
        expect(file.ppg!.packets.length).toBeGreaterThan(0);
    });

    it("keeps the consent time it was given, distinct from recorded_at", async () => {
        const { recording } = await setup();
        const { file } = recording.finish();
        expect(file.consent.accepted_at).toBe(CONSENT_AT);
        expect(file.consent.accepted_at).not.toBe(file.recorded_at);
    });

    it("anchors t0 to start(), not to setup", async () => {
        vi.setSystemTime(BASE_EPOCH);
        // A startInstant offset from `now`, so an anchor taken anywhere else
        // (recordedAt, say) would visibly disagree with it.
        const sim = new SimulatedMuse({
            now: () => Date.now(),
            seed: 1,
            startInstant: () => ({ monoMs: Date.now(), epochMs: Date.now() + 1234 })
        });
        const recording = await startRecording(sim, CONSENT_AT);
        const { file } = recording.finish();
        expect(file.t0_epoch_ms).toBe(BASE_EPOCH + 1234);
        expect(file.t0_epoch_ms).not.toBe(Date.parse(file.recorded_at));
    });

    it("a full guided run writes all five markers in order", async () => {
        const { recording } = await setup();
        vi.advanceTimersByTime(2000);
        recording.startGuidedRun();
        vi.advanceTimersByTime(110_000);
        const { file } = recording.finish();
        const markers = file.markers!;
        expect(markers).toBeDefined();
        expect(markers.map(m => m.label)).toEqual(BENCH_PROTOCOL.map(s => s.label));
        for (let i = 0; i < markers.length; i++) {
            expect(markers[i].t_ms_end - markers[i].t_ms_start).toBe(BENCH_PROTOCOL[i].seconds * 1000);
        }
        // The run was started ~2s into the session, not at session time 0.
        expect(markers[0].t_ms_start).toBeGreaterThan(0);
    });

    it("a file saved mid-run carries the steps so far, clipped", async () => {
        const { recording } = await setup();
        recording.startGuidedRun();
        vi.advanceTimersByTime(30_000);
        const { file } = recording.finish();
        const markers = file.markers!;
        expect(markers).toHaveLength(2);
        expect(markers[0].label).toBe("baseline");
        expect(markers[0].t_ms_end - markers[0].t_ms_start).toBe(20_000);
        expect(markers[1].label).toBe("eyes closed");
        // Clipped to the time of the last EEG packet before finish(). The simulator
        // emits a packet only once it is due, on its next tick, stamped with its
        // own packet time, so that packet can trail the clock by up to two
        // periods. Five periods of slack keeps this independent of that.
        expect(markers[1].t_ms_end).toBeLessThanOrEqual(30_000);
        expect(markers[1].t_ms_end).toBeGreaterThan(30_000 - 5 * EEG_PERIOD_MS);
    });

    it("no guided run leaves the file with no markers block at all", async () => {
        const { recording } = await setup();
        vi.advanceTimersByTime(1000);
        const { file } = recording.finish();
        expect("markers" in file).toBe(false);
    });

    it("guidedState reports null, then the step in progress, then done", async () => {
        const { recording } = await setup();
        expect(recording.guidedState()).toBeNull();

        recording.startGuidedRun();
        expect(recording.guidedState()).toMatchObject({ done: false, index: 0, step: { label: "baseline" } });

        vi.advanceTimersByTime(25_000);
        expect(recording.guidedState()).toMatchObject({ done: false, step: { label: "eyes closed" } });

        vi.advanceTimersByTime(110_000);
        expect(recording.guidedState()).toEqual({ done: true });
    });

    it("the saved filename matches sessionFilename for the device and recorded_at", async () => {
        const { recording } = await setup();
        vi.advanceTimersByTime(500);
        const { file, filename } = recording.finish();
        expect(filename).toBe(sessionFilename(new Date(file.recorded_at), "Muse-SIM"));
        expect(filename).toMatch(/^muse-session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-Muse-SIM\.json$/);
    });

    it("stop() releases the headband: no more packets after it", async () => {
        const { recording } = await setup();
        vi.advanceTimersByTime(1000);
        const before = recording.finish().file.eeg.packets.length;
        expect(before).toBeGreaterThan(0);

        await recording.stop();
        vi.advanceTimersByTime(5000);
        const after = recording.finish().file.eeg.packets.length;
        expect(after).toBe(before);
    });

    it("if start() rejects, the same error is rethrown and everything is cleaned up", async () => {
        const err = new Error("kaboom");
        const unsubscribers = {
            eeg: vi.fn(),
            imu: vi.fn(),
            ppg: vi.fn(),
            telemetry: vi.fn()
        };
        const stop = vi.fn(async () => undefined);
        const fakeSource: MuseSource = {
            kind: "simulated",
            connect: async () => ({ name: "Muse-FAKE" }) as DeviceInfo,
            start: async () => {
                throw err;
            },
            stop,
            on: ((event: keyof typeof unsubscribers) => unsubscribers[event]) as MuseSource["on"]
        };

        await expect(startRecording(fakeSource, CONSENT_AT)).rejects.toBe(err);
        expect(stop).toHaveBeenCalledTimes(1);
        for (const fn of Object.values(unsubscribers)) expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe("docs/muse-wiring.md", () => {
    it("shows wiring.example.ts verbatim", async () => {
        const docUrl = new URL("../../docs/muse-wiring.md", import.meta.url);
        const srcUrl = new URL("./wiring.example.ts", import.meta.url);
        const doc = await readFile(docUrl, "utf8");
        const source = await readFile(srcUrl, "utf8");

        const begin = "<!-- BEGIN src/session/wiring.example.ts -->";
        const end = "<!-- END src/session/wiring.example.ts -->";
        const beginIdx = doc.indexOf(begin);
        const endIdx = doc.indexOf(end);
        expect(beginIdx).toBeGreaterThanOrEqual(0);
        expect(endIdx).toBeGreaterThan(beginIdx);

        const between = doc.slice(beginIdx + begin.length, endIdx);
        const fenceMatch = between.match(/```ts\n([\s\S]*?)```/);
        expect(fenceMatch).not.toBeNull();
        const docCode = fenceMatch![1];

        // Normalise only a single trailing newline, so the doc's fence and the
        // file itself need not agree on exactly how many blank lines end them.
        const normalize = (s: string) => s.replace(/\n+$/, "\n");
        expect(normalize(docCode)).toBe(normalize(source));
    });
});
