import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SimulatedMuse, ALPHA_HZ, ALPHA_UV } from "./simulated";
import type { EegReading } from "./types";

/** Least-squares amplitude of a sinusoid at `hz` in `samples` at 256 Hz. */
function amplitudeAt(samples: number[], hz: number): number {
    let s = 0;
    let c = 0;
    samples.forEach((v, i) => {
        const t = i / 256;
        s += v * Math.sin(2 * Math.PI * hz * t);
        c += v * Math.cos(2 * Math.PI * hz * t);
    });
    return (2 / samples.length) * Math.hypot(s, c);
}

describe("SimulatedMuse", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // Fake timers also fake Date, so the simulator's clock advances with advanceTimersByTime.
    const make = (opts: { dropEvery?: number; seed?: number } = {}) => new SimulatedMuse({ now: () => Date.now(), seed: 1, ...opts });

    it("reports a simulated identity", async () => {
        const sim = make();
        const info = await sim.connect({ preset: "p21" });
        expect(sim.kind).toBe("simulated");
        expect(info.name).toBe("Muse-SIM");
        expect(info.model).toMatch(/simulated/i);
    });

    it("emits ~21 EEG packets per channel per second with consecutive sequence numbers", async () => {
        const sim = make();
        const got: EegReading[] = [];
        sim.on("eeg", r => got.push(r));
        await sim.connect({ preset: "p21" });
        await sim.start();
        vi.advanceTimersByTime(1000);
        const tp9 = got.filter(r => r.ch === "TP9");
        expect(tp9.length).toBeGreaterThanOrEqual(20);
        expect(tp9.length).toBeLessThanOrEqual(22);
        tp9.forEach((r, i) => i > 0 && expect(r.seq).toBe(tp9[i - 1].seq + 1));
        expect(new Set(got.map(r => r.ch))).toEqual(new Set(["TP9", "AF7", "AF8", "TP10"]));
        got.forEach(r => {
            expect(r.uV).toHaveLength(12);
            r.uV.forEach(v => expect(Math.abs(v)).toBeLessThanOrEqual(1000));
        });
        await sim.stop();
    });

    it("drops every Nth packet on AF7 only", async () => {
        const sim = make({ dropEvery: 5 });
        const got: EegReading[] = [];
        sim.on("eeg", r => got.push(r));
        await sim.connect({ preset: "p21" });
        await sim.start();
        vi.advanceTimersByTime(1000);
        const af7 = got.filter(r => r.ch === "AF7").map(r => r.seq);
        const tp9 = got.filter(r => r.ch === "TP9").map(r => r.seq);
        expect(af7).not.toContain(5);
        expect(af7).not.toContain(10);
        expect(tp9).toContain(5);
        expect(af7.length).toBe(tp9.length - tp9.filter(s => s % 5 === 0).length);
        await sim.stop();
    });

    it("adds a 10 Hz rhythm on TP9/TP10 only while eyes are closed", async () => {
        const collect = async (eyesClosed: boolean) => {
            const sim = make();
            sim.eyesClosed = eyesClosed;
            const tp9: number[] = [];
            const af7: number[] = [];
            sim.on("eeg", r => (r.ch === "TP9" ? tp9 : r.ch === "AF7" ? af7 : []).push(...r.uV));
            await sim.connect({ preset: "p21" });
            await sim.start();
            vi.advanceTimersByTime(2000);
            await sim.stop();
            return { tp9, af7 };
        };
        const closed = await collect(true);
        const open = await collect(false);
        expect(amplitudeAt(closed.tp9, ALPHA_HZ)).toBeGreaterThan(ALPHA_UV * 0.6);
        expect(amplitudeAt(open.tp9, ALPHA_HZ)).toBeLessThan(ALPHA_UV * 0.3);
        expect(amplitudeAt(closed.af7, ALPHA_HZ)).toBeLessThan(ALPHA_UV * 0.3);
    });

    it("produces a blink deflection on AF7 about every 4 s", async () => {
        const sim = make();
        const af7: number[] = [];
        sim.on("eeg", r => r.ch === "AF7" && af7.push(...r.uV));
        await sim.connect({ preset: "p21" });
        await sim.start();
        vi.advanceTimersByTime(9000);
        await sim.stop();
        const big = af7.filter(v => v > 100).length;
        // Three blinks (t≈0, 4, 8 s), each ~0.3 s ≈ 77 samples, roughly half above 100 µV.
        expect(big).toBeGreaterThan(60);
        expect(big).toBeLessThan(200);
    });

    it("emits IMU and telemetry, and PPG only under p50", async () => {
        const sim = make();
        const kinds: string[] = [];
        sim.on("imu", r => kinds.push(r.sensor));
        sim.on("telemetry", () => kinds.push("telemetry"));
        sim.on("ppg", () => kinds.push("ppg"));
        await sim.connect({ preset: "p21" });
        await sim.start();
        vi.advanceTimersByTime(1100);
        await sim.stop();
        expect(kinds).toContain("accelerometer");
        expect(kinds).toContain("gyroscope");
        expect(kinds).toContain("telemetry");
        expect(kinds).not.toContain("ppg");

        const sim50 = make();
        const ppg = vi.fn();
        sim50.on("ppg", ppg);
        await sim50.connect({ preset: "p50" });
        await sim50.start();
        vi.advanceTimersByTime(500);
        await sim50.stop();
        expect(ppg).toHaveBeenCalled();
    });

    it("catches up by wall-clock time when timers are throttled", async () => {
        // Emulate a background tab: one 1000 ms tick instead of 21 × 47 ms ticks.
        const sim = make();
        const got: EegReading[] = [];
        sim.on("eeg", r => got.push(r));
        await sim.connect({ preset: "p21" });
        await sim.start();
        vi.setSystemTime(Date.now() + 3000);
        vi.advanceTimersToNextTimer();
        const tp9 = got.filter(r => r.ch === "TP9");
        expect(tp9.length).toBeGreaterThanOrEqual(63);
        expect(tp9[1].tMs - tp9[0].tMs).toBeCloseTo(46.875, 3);
        await sim.stop();
    });

    it("returns a wall-clock anchor for t0, read once", async () => {
        // The same seam the real client uses, so the simulated path a manual run
        // exercises produces the same anchored file a headband would.
        const base = Date.parse("2026-09-08T09:00:00.000Z");
        let reads = 0;
        const sim = new SimulatedMuse({
            now: () => Date.now(),
            seed: 1,
            startInstant: () => {
                reads += 1;
                return { monoMs: Date.now(), epochMs: base + 60_000 * reads };
            }
        });
        await sim.connect({ preset: "p21" });
        const started = await sim.start();
        expect(reads).toBe(1);
        expect(started.epochMs).toBe(base + 60_000);
        expect(started.monoMs).toBe(Date.now());
        await sim.stop();
    });

    it("stop emits disconnected and stops the timers", async () => {
        const sim = make();
        const eeg = vi.fn();
        const disconnected = vi.fn();
        sim.on("eeg", eeg);
        sim.on("disconnected", disconnected);
        await sim.connect({ preset: "p21" });
        await sim.start();
        vi.advanceTimersByTime(100);
        await sim.stop();
        const countAtStop = eeg.mock.calls.length;
        vi.advanceTimersByTime(1000);
        expect(eeg.mock.calls.length).toBe(countAtStop);
        expect(disconnected).toHaveBeenCalledTimes(1);
    });
});
