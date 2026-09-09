import { describe, it, expect } from "vitest";
import { detectBeats, pulseMetrics } from "./pulse";

const FS = 64; // PPG rate on a Muse 2

/** A PPG-ish waveform: a sharp systolic upstroke then a slower decay. */
function synth(beatMs: number[], durationMs: number, opts: { drift?: number; dc?: number } = {}): number[] {
    const n = Math.round((durationMs / 1000) * FS);
    const dc = opts.dc ?? 500_000;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        const tMs = (i / FS) * 1000;
        let v = dc;
        if (opts.drift) v += opts.drift * Math.sin((2 * Math.PI * tMs) / 20_000); // slow baseline wander
        for (const b of beatMs) {
            const dt = (tMs - b) / 1000;
            if (dt >= -0.05 && dt <= 0.6) v += 20_000 * Math.exp(-((dt - 0.15) ** 2) / (2 * 0.06 ** 2));
        }
        out.push(v);
    }
    return out;
}

const every = (ms: number, count: number, start = 500) => Array.from({ length: count }, (_, i) => start + i * ms);

describe("detectBeats", () => {
    it("finds every beat of a regular pulse and spaces them correctly", () => {
        const beats = every(1000, 12);
        const found = detectBeats(synth(beats, 13_500), FS);
        expect(found.length).toBe(beats.length);
        const ibi = found.slice(1).map((t, i) => t - found[i]);
        for (const v of ibi) expect(v).toBeGreaterThan(970);
        for (const v of ibi) expect(v).toBeLessThan(1030);
    });

    it("is not fooled by slow baseline wander", () => {
        const beats = every(850, 14);
        const found = detectBeats(synth(beats, 13_000, { drift: 15_000 }), FS);
        expect(found.length).toBe(beats.length);
    });

    it("recovers the true beat-to-beat variation, not just the average", () => {
        // Alternating 800/900 ms: RMSSD should come out near 100, SDNN near 50.
        const beats: number[] = [500];
        for (let i = 0; i < 15; i++) beats.push(beats[beats.length - 1] + (i % 2 === 0 ? 800 : 900));
        const found = detectBeats(synth(beats, beats[beats.length - 1] + 1500), FS);
        expect(found.length).toBe(beats.length);
        const m = pulseMetrics(found);
        expect(m.rmssdMs!).toBeGreaterThan(80);
        expect(m.rmssdMs!).toBeLessThan(120);
        expect(m.sdnnMs!).toBeGreaterThan(35);
        expect(m.sdnnMs!).toBeLessThan(65);
    });

    it("refuses two beats inside the refractory period", () => {
        // A dicrotic notch 120 ms after the systolic peak must not count as a beat.
        const found = detectBeats(synth([500, 620, 1500, 1620, 2500], 3500), FS);
        expect(found.length).toBe(3);
    });

    it("keeps finding beats when the pulse amplitude changes across the recording", () => {
        // Real PPG amplitude drifts with contact and perfusion. A threshold taken
        // from the whole recording at once goes deaf during the weak stretches.
        const beats = every(820, 40);
        const span = beats[beats.length - 1] + 1500;
        const strong = synth(beats, span);
        // Taper the pulse component down to a tenth over the recording.
        const dc = 500_000;
        const faded = strong.map((v, i) => dc + (v - dc) * (1 - 0.9 * (i / strong.length)));
        const found = detectBeats(faded, FS);
        expect(found.length).toBeGreaterThanOrEqual(beats.length - 2);
        expect(found.length).toBeLessThanOrEqual(beats.length);
    });

    it("is not deafened by one large artefact elsewhere in the recording", () => {
        // A jaw clench or a knock dwarfs the pulse; it must not raise the bar for
        // every other beat in the recording.
        const beats = every(820, 40);
        const span = beats[beats.length - 1] + 1500;
        const x = synth(beats, span);
        const at = Math.round((10 / (span / 1000)) * x.length);
        for (let i = at; i < at + FS; i++) x[i] += 400_000; // ~20x the pulse
        const found = detectBeats(x, FS);
        expect(found.length).toBeGreaterThanOrEqual(beats.length - 3);
    });

    it("returns nothing for a signal too short to hold a beat", () => {
        expect(detectBeats([1, 2, 3], FS)).toEqual([]);
        expect(detectBeats(new Array(32).fill(500_000), FS)).toEqual([]);
    });

    it("returns nothing for a flat signal with no pulse in it", () => {
        expect(detectBeats(new Array(FS * 10).fill(500_000), FS)).toEqual([]);
    });
});

describe("pulseMetrics", () => {
    it("computes bpm, SDNN and RMSSD from beat times", () => {
        const beats = every(800, 20);
        const m = pulseMetrics(beats);
        expect(m.bpm!).toBeCloseTo(75, 1);
        expect(m.sdnnMs!).toBeCloseTo(0, 5);
        expect(m.rmssdMs!).toBeCloseTo(0, 5);
        expect(m.ibiMs.length).toBe(19);
        expect(m.rejected).toBe(0);
    });

    it("rejects a physiologically impossible interval instead of reporting it", () => {
        // A missed beat leaves a double-length gap; it must not inflate RMSSD.
        const beats = [0, 800, 1600, 3200, 4000, 4800, 5600, 6400, 7200, 8000];
        const m = pulseMetrics(beats);
        expect(m.rejected).toBe(1);
        expect(m.ibiMs).not.toContain(1600);
        expect(m.rmssdMs!).toBeLessThan(10);
    });

    it("reports the same bpm whether or not a beat was missed", () => {
        // On a poor-contact recording the detector under-counts beats by ~24%.
        // Rate by (count / duration) would then read 57 bpm for a 75 bpm heart;
        // rate from accepted intervals is immune, because the double-length gap
        // a missed beat leaves is rejected rather than averaged in.
        const full = every(800, 30);
        const missing = full.filter((_, i) => i % 5 !== 3); // drop every fifth beat
        expect(pulseMetrics(full).bpm!).toBeCloseTo(75, 1);
        expect(pulseMetrics(missing).bpm!).toBeCloseTo(75, 1);
        expect(pulseMetrics(missing).rejected).toBe(6);
    });

    it("drops intervals outside any plausible heart rate", () => {
        const m = pulseMetrics([0, 100, 900, 1700, 2500, 3300, 9000]);
        expect(m.ibiMs.every(v => v >= 300 && v <= 2000)).toBe(true);
        expect(m.rejected).toBeGreaterThanOrEqual(2);
    });

    it("reports nulls rather than nonsense when there is too little to go on", () => {
        expect(pulseMetrics([]).bpm).toBeNull();
        expect(pulseMetrics([1000]).bpm).toBeNull();
        const one = pulseMetrics([0, 800]);
        expect(one.bpm).toBeCloseTo(75, 1);
        expect(one.rmssdMs).toBeNull(); // needs two successive intervals
    });
});
