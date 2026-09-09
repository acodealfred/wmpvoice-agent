import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import type { SessionFile } from "./recorder";
import { generateExampleSession, EXAMPLE_EPOCH_MS, EXAMPLE_SEED } from "./example";
import { SESSION_SCHEMA } from "./recorder";
import { EEG_RATE_HZ, EEG_SAMPLES_PER_PACKET, IMU_RATE_HZ, IMU_SAMPLES_PER_PACKET, PPG_RATE_HZ, PPG_SAMPLES_PER_PACKET } from "../muse/protocol";

const EEG_PERIOD_MS = (1000 * EEG_SAMPLES_PER_PACKET) / EEG_RATE_HZ;
const IMU_PERIOD_MS = (1000 * IMU_SAMPLES_PER_PACKET) / IMU_RATE_HZ;
const PPG_PERIOD_MS = (1000 * PPG_SAMPLES_PER_PACKET) / PPG_RATE_HZ;

const DURATION_MS = 20_000;
const DROP_EVERY = 97;

describe("generateExampleSession", () => {
    let file: SessionFile;
    beforeAll(async () => {
        file = await generateExampleSession({ durationMs: DURATION_MS, preset: "p50", dropEvery: DROP_EVERY });
    });

    it("writes the current schema, not a stale one", () => {
        expect(file.schema).toBe(SESSION_SCHEMA);
        expect(file.schema).toBe("muse-web-bridge/3");
    });

    it("is byte-for-byte reproducible, so the committed fixture has no churn", async () => {
        const again = await generateExampleSession({ durationMs: DURATION_MS, preset: "p50", dropEvery: DROP_EVERY });
        expect(JSON.stringify(again)).toBe(JSON.stringify(file));
    });

    it("keeps packet structure independent of the virtual-clock step", async () => {
        // seq and t_ms come from per-stream counters, so the timeline must not
        // move with the stepping. Sample VALUES legitimately do move: the
        // simulator draws every stream's noise from one shared PRNG, so a
        // different step interleaves those draws differently. That is why
        // stepMs is pinned for the committed fixture rather than left open.
        const coarse = await generateExampleSession({ durationMs: DURATION_MS, preset: "p50", dropEvery: DROP_EVERY, stepMs: 1000 });
        const timeline = (f: SessionFile) => ({
            eeg: f.eeg.packets.map(p => `${p.ch}:${p.seq}:${p.t_ms}`),
            accel: f.accelerometer.packets.map(p => `${p.seq}:${p.t_ms}`),
            gyro: f.gyroscope.packets.map(p => `${p.seq}:${p.t_ms}`),
            ppg: f.ppg?.packets.map(p => `${p.ch}:${p.seq}:${p.t_ms}`),
            dropped: f.eeg.dropped_packets,
            telemetry: f.telemetry.length
        });
        expect(timeline(coarse)).toEqual(timeline(file));
    });

    it("anchors the packet timeline to a fixed wall clock", () => {
        expect(file.t0_epoch_ms).toBe(EXAMPLE_EPOCH_MS);
        // recorded_at is set up before streaming starts, so it must be the
        // earlier of the two instants — the distinction the schema documents.
        expect(Date.parse(file.recorded_at)).toBeLessThanOrEqual(EXAMPLE_EPOCH_MS);
    });

    it("emits every packet due in the window, on every stream", () => {
        const eegTicks = Math.floor(DURATION_MS / EEG_PERIOD_MS);
        const imuTicks = Math.floor(DURATION_MS / IMU_PERIOD_MS);
        const ppgTicks = Math.floor(DURATION_MS / PPG_PERIOD_MS);

        const perChannel = (ch: string) => file.eeg.packets.filter(p => p.ch === ch).length;
        expect(perChannel("TP9")).toBe(eegTicks);
        expect(perChannel("TP10")).toBe(eegTicks);
        expect(perChannel("AF8")).toBe(eegTicks);

        expect(file.accelerometer.packets).toHaveLength(imuTicks);
        expect(file.gyroscope.packets).toHaveLength(imuTicks);
        expect(file.ppg?.packets).toHaveLength(ppgTicks * 3);
        expect(file.telemetry).toHaveLength(Math.floor(DURATION_MS / 1000));
    });

    it("carries the dropped AF7 packets the simulator injects, and counts them", () => {
        const eegTicks = Math.floor(DURATION_MS / EEG_PERIOD_MS);
        let expectedDrops = 0;
        for (let seq = 0; seq < eegTicks; seq++) if (seq % DROP_EVERY === 0) expectedDrops++;
        expect(expectedDrops).toBeGreaterThan(0);

        expect(file.eeg.packets.filter(p => p.ch === "AF7")).toHaveLength(eegTicks - expectedDrops);
        // The first AF7 packet is seq 0, which is dropped; a gap before the very
        // first observed packet is not a drop, so the counter sees one fewer.
        expect(file.eeg.dropped_packets.AF7).toBe(expectedDrops - 1);
        expect(file.eeg.dropped_packets.TP9).toBe(0);
    });

    it("records the microvolt scale it used rather than leaving it implied", () => {
        expect(file.eeg.units).toBe("uV");
        expect(file.eeg.uv_per_lsb).toBeGreaterThan(0);
        expect(file.eeg.zero_code).toBe(2048);
        expect(file.eeg.channels).toEqual(["TP9", "AF7", "AF8", "TP10"]);
    });

    it("includes PPG under p50 and omits it otherwise", async () => {
        expect(file.ppg?.channels).toEqual(["ambient", "infrared", "red"]);
        const p21 = await generateExampleSession({ durationMs: 2000, preset: "p21", dropEvery: DROP_EVERY });
        expect(p21.ppg).toBeUndefined();
    });

    it("puts a real alpha rhythm on the temporal channels, so the file shows something", () => {
        // eyesClosed is on for the whole run, and the simulator only adds alpha
        // to TP9/TP10. A flat fixture would teach the reader nothing.
        const spread = (ch: string) => {
            const v = file.eeg.packets.filter(p => p.ch === ch).flatMap(p => p.v);
            const mean = v.reduce((a, b) => a + b, 0) / v.length;
            return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
        };
        expect(spread("TP9")).toBeGreaterThan(spread("AF8") * 0.5);
        expect(spread("TP9")).toBeGreaterThan(10);
    });

    it("uses the documented seed, so the fixture can be regenerated", () => {
        expect(EXAMPLE_SEED).toBeGreaterThan(0);
    });

    it("matches the committed fixture — regenerate with `npm run example:session`", async () => {
        // The guard that stops docs/example-session.json going stale. It is the
        // file a receiving developer reads to understand the schema, so a schema
        // change that leaves it behind is a change that ships a lie.
        const url = new URL("../../docs/example-session.json", import.meta.url);
        const committed = JSON.parse(await readFile(url, "utf8"));
        const fresh = await generateExampleSession();
        expect(committed).toEqual(fresh);
    });
});
