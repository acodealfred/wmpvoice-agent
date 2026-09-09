import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SimulatedMuse } from "../muse/simulated";
import { Recorder, SESSION_SCHEMA } from "./recorder";

// The whole pipeline a real session runs — headband bytes -> decoders -> recorder
// -> the JSON that Save writes — against the simulated headband. Unit tests cover
// each stage; this checks the file that actually comes out the far end, because
// no muse-web-bridge/2 recording had ever been produced when it was written.
describe("the session file a real run produces", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // The wall clock when streaming starts. Deliberately a different instant from
    // recordedAt below, so an anchor taken from the header would be visible.
    const START_EPOCH = Date.parse("2026-09-08T11:22:33.000Z");

    async function record(seconds: number) {
        // Fake timers also fake Date, so the simulator's clock advances with the timers.
        vi.setSystemTime(START_EPOCH);
        const sim = new SimulatedMuse({ now: () => Date.now(), seed: 1, dropEvery: 10 });
        const device = await sim.connect({ preset: "p50" });
        const rec = new Recorder({
            device,
            preset: "p50",
            consentAcceptedAt: "2026-09-04T10:00:00.000Z",
            recordedAt: "2026-09-04T10:00:05.000Z"
        });
        sim.on("eeg", r => rec.push(r));
        sim.on("imu", r => rec.push(r));
        sim.on("ppg", r => rec.push(r));
        sim.on("telemetry", r => rec.push(r));
        const started = await sim.start();
        rec.markStarted(started.epochMs);
        vi.advanceTimersByTime(seconds * 1000);
        await sim.stop();
        return rec.finish();
    }

    it("is a muse-web-bridge/3 file with every block the schema promises", async () => {
        const file = await record(3);
        expect(file.schema).toBe(SESSION_SCHEMA);
        expect(file.schema).toBe("muse-web-bridge/3");

        // Self-describing microvolt scale.
        expect(file.eeg.uv_per_lsb).toBe(0.48828125);
        expect(file.eeg.zero_code).toBe(2048);

        // Roughly 21 packets/s per channel over 3 s.
        expect(file.eeg.packets.length).toBeGreaterThan(200);
        // The simulator drops every 10th AF7 packet by design; the counter must see it.
        expect(file.eeg.dropped_packets.AF7).toBeGreaterThan(0);
        expect(file.eeg.dropped_packets.TP9).toBe(0);

        // p50 carries PPG, with its own drop counter.
        expect(file.ppg).toBeDefined();
        expect(file.ppg!.packets.length).toBeGreaterThan(20);
        expect(file.ppg!.dropped_packets).toEqual({ ambient: 0, infrared: 0, red: 0 });

        // Telemetry keeps everything the characteristic carries, not just the percentage.
        expect(file.telemetry.length).toBeGreaterThanOrEqual(2);
        for (const row of file.telemetry) {
            expect(row.battery_percent).toBeGreaterThan(0);
            // The wire format is a 16-bit count of 2.2 mV steps, so a byte-level
            // round trip lands within one step of the value the simulator asked for.
            expect(Math.abs(row.fuel_gauge_mv - 3700)).toBeLessThan(2.2);
            expect(row.temperature).toBe(30);
        }

        // No guided run happened, so no markers block at all.
        expect("markers" in file).toBe(false);
    });

    it("anchors t0 to the wall clock, so any packet's seq gives an epoch time", async () => {
        const file = await record(4);
        // The clock as it stood when streaming was asked for — not recorded_at,
        // which is four days earlier here.
        expect(file.t0_epoch_ms).toBe(START_EPOCH);
        expect(file.t0_epoch_ms).not.toBe(Date.parse(file.recorded_at));
        const anchor = file.t0_epoch_ms!;

        // epoch(sample) = anchor + 1000 * (seq-derived seconds), at each rate.
        // EEG: (seq * 12 + k) / 256 s.
        const eeg = file.eeg.packets.find(p => p.ch === "TP9" && p.seq === 64)!;
        expect(eeg).toBeDefined();
        expect(anchor + ((eeg.seq * 12) / 256) * 1000).toBe(START_EPOCH + 3000);
        // The k-th sample inside the packet, not just its first.
        expect(anchor + ((eeg.seq * 12 + 11) / 256) * 1000).toBeCloseTo(START_EPOCH + 3000 + (11 / 256) * 1000, 6);

        // PPG: (seq * 6 + k) / 64 s.
        const ppg = file.ppg!.packets.find(p => p.ch === "infrared" && p.seq === 32)!;
        expect(ppg).toBeDefined();
        expect(anchor + ((ppg.seq * 6) / 64) * 1000).toBe(START_EPOCH + 3000);

        // IMU: (seq * 3 + k) / 52 s.
        const imu = file.accelerometer.packets.find(p => p.seq === 52)!;
        expect(imu).toBeDefined();
        expect(anchor + ((imu.seq * 3) / 52) * 1000).toBe(START_EPOCH + 3000);

        // The simulator has no BLE jitter, so its arrival stamps agree with the
        // seq-derived times. On a real headband they would not, which is why seq
        // is the timeline and t_ms is not.
        expect(eeg.t_ms).toBeCloseTo(3000, 1);
        expect(ppg.t_ms).toBeCloseTo(3000, 1);
        expect(imu.t_ms).toBeCloseTo(3000, 1);
    });

    it("survives JSON serialisation intact — that is what Save writes", async () => {
        const file = await record(2);
        const text = JSON.stringify(file);
        expect(text).not.toMatch(/NaN|Infinity|undefined/);
        const back = JSON.parse(text);
        expect(back.schema).toBe("muse-web-bridge/3");
        expect(back.eeg.uv_per_lsb).toBe(0.48828125);
        expect(back.telemetry[0]).toEqual(file.telemetry[0]);
        expect(back.t0_epoch_ms).toBe(file.t0_epoch_ms);
        expect(back.ppg.dropped_packets).toEqual(file.ppg!.dropped_packets);
        expect(back.eeg.packets.length).toBe(file.eeg.packets.length);
    });
});
