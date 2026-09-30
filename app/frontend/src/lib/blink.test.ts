import { describe, expect, it } from "vitest";
import { BlinkDetector, computeEAR, isPoseUsable, rateBetween, type Point } from "./blink";

const FRAME_MS = 33;
const OPEN_EAR = 0.3;
const CLOSED_EAR = 0.08;

// Drives a detector at ~30 fps. `closures` are [startMs, durationMs] windows with the eye shut.
function run(det: BlinkDetector, totalMs: number, closures: [number, number][] = [], opts: { from?: number; usable?: (t: number) => boolean } = {}) {
    const from = opts.from ?? 0;
    let counted = 0;
    for (let t = from; t < from + totalMs; t += FRAME_MS) {
        const closed = closures.some(([s, d]) => t >= s && t < s + d);
        const usable = opts.usable ? opts.usable(t) : true;
        if (det.update({ t, ear: closed ? CLOSED_EAR : OPEN_EAR, blinkScore: closed ? 0.8 : 0.05, usable })) counted++;
    }
    return counted;
}

describe("BlinkDetector", () => {
    it("counts a normal ~150 ms blink once", () => {
        const det = new BlinkDetector();
        expect(run(det, 3000, [[1000, 150]])).toBe(1);
    });

    it("ignores a single-frame dip (landmark noise)", () => {
        const det = new BlinkDetector();
        expect(run(det, 3000, [[1000, 20]])).toBe(0);
    });

    it("does not count a long closure (deliberate / looking down) as a blink", () => {
        const det = new BlinkDetector();
        expect(run(det, 4000, [[1000, 1000]])).toBe(0);
    });

    it("counts one blink when EAR jitters around the threshold (hysteresis)", () => {
        const det = new BlinkDetector();
        const ears = [0.3, 0.3, 0.3, 0.3, 0.17, 0.19, 0.17, 0.2, 0.17, 0.3, 0.3, 0.3];
        let counted = 0;
        ears.forEach((ear, i) => {
            if (det.update({ t: i * FRAME_MS, ear, blinkScore: 0, usable: true })) counted++;
        });
        expect(counted).toBe(1);
    });

    it("adapts to a narrow-eyed person (low resting EAR)", () => {
        const det = new BlinkDetector();
        let counted = 0;
        for (let t = 0; t < 3000; t += FRAME_MS) {
            const closed = t >= 1500 && t < 1650;
            if (det.update({ t, ear: closed ? 0.06 : 0.15, blinkScore: 0, usable: true })) counted++;
        }
        expect(counted).toBe(1);
    });

    it("adapts to a high resting eyeBlink blendshape score", () => {
        const det = new BlinkDetector();
        let counted = 0;
        for (let t = 0; t < 3000; t += FRAME_MS) {
            const closed = t >= 1500 && t < 1650;
            // EAR barely moves; only the blendshape reveals the blink.
            if (det.update({ t, ear: 0.3, blinkScore: closed ? 0.95 : 0.55, usable: true })) counted++;
        }
        expect(counted).toBe(1);
    });

    it("recovers when it has been stuck 'closed' (resting openness changed)", () => {
        const det = new BlinkDetector();
        run(det, 1000); // learns open EAR 0.3
        let counted = 0;
        // Now rests at 0.15 (e.g. looking at a lower screen), blinking down to 0.05.
        for (let t = 1000; t < 8000; t += FRAME_MS) {
            const closed = t >= 6000 && t < 6150;
            if (det.update({ t, ear: closed ? 0.05 : 0.15, blinkScore: 0, usable: true })) counted++;
        }
        expect(counted).toBe(1);
    });

    it("rate uses valid seconds, not 'count x 2' (correct before the window fills)", () => {
        const det = new BlinkDetector();
        // 5 blinks in 20 s -> 15/min.
        run(det, 20_000, [[2000, 150], [6000, 150], [10000, 150], [14000, 150], [18000, 150]]);
        expect(det.rate(20_000)).toBeCloseTo(15, 0);
    });

    it("returns null until enough valid time has accumulated", () => {
        const det = new BlinkDetector();
        run(det, 10_000, [[2000, 150]]);
        expect(det.rate(10_000)).toBeNull();
    });

    it("returns a real zero when there is data but no blinks", () => {
        const det = new BlinkDetector();
        run(det, 20_000);
        expect(det.rate(20_000)).toBe(0);
    });

    it("excludes unusable frames (no face / bad pose) from the time base", () => {
        const det = new BlinkDetector();
        // 40 s, but the face is unusable for the middle 20 s. 5 blinks in the 20 usable s.
        const usable = (t: number) => t < 10_000 || t >= 30_000;
        run(det, 40_000, [[2000, 150], [6000, 150], [32000, 150], [35000, 150], [38000, 150]], { usable });
        expect(det.totals().validMs).toBeGreaterThan(19_000);
        expect(det.totals().validMs).toBeLessThan(21_000);
        expect(det.rate(40_000)).toBeCloseTo(15, 0);
    });

    it("does not count time across dropped-frame gaps", () => {
        const det = new BlinkDetector();
        det.update({ t: 0, ear: OPEN_EAR, blinkScore: 0, usable: true });
        det.update({ t: 33, ear: OPEN_EAR, blinkScore: 0, usable: true });
        det.update({ t: 5000, ear: OPEN_EAR, blinkScore: 0, usable: true }); // 5 s stall
        expect(det.totals().validMs).toBe(33);
    });

    it("drops blinks older than the trailing window", () => {
        const det = new BlinkDetector();
        run(det, 90_000, [[5000, 150], [10000, 150], [80000, 150]]);
        // Only the blink at 80 s is inside the last 60 s.
        expect(det.rate(90_000)).toBeCloseTo(1, 0);
    });
});

describe("rateBetween", () => {
    it("computes per-window rate from cumulative totals", () => {
        expect(rateBetween({ blinks: 10, validMs: 60_000 }, { blinks: 16, validMs: 90_000 }, 10_000)).toBeCloseTo(12);
    });
    it("returns null when the window is too short", () => {
        expect(rateBetween({ blinks: 0, validMs: 0 }, { blinks: 1, validMs: 5_000 }, 10_000)).toBeNull();
    });
});

describe("computeEAR", () => {
    // Builds landmarks for an eye of the given pixel width/height at a roll angle.
    function eye(landmarks: Point[], idx: number[], cx: number, cy: number, w: number, h: number, rollRad: number, fw: number, fh: number) {
        const pts: [number, number][] = [
            [-w / 2, 0],
            [-w / 6, -h / 2],
            [w / 6, -h / 2],
            [w / 2, 0],
            [w / 6, h / 2],
            [-w / 6, h / 2]
        ];
        pts.forEach(([x, y], k) => {
            const rx = x * Math.cos(rollRad) - y * Math.sin(rollRad);
            const ry = x * Math.sin(rollRad) + y * Math.cos(rollRad);
            landmarks[idx[k]] = { x: (cx + rx) / fw, y: (cy + ry) / fh };
        });
    }
    function face(roll: number, fw: number, fh: number): Point[] {
        const lm: Point[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
        eye(lm, [33, 160, 158, 133, 153, 144], 500, 400, 60, 18, roll, fw, fh);
        eye(lm, [362, 385, 387, 263, 373, 380], 650, 400, 60, 18, roll, fw, fh);
        return lm;
    }

    it("gives the true aspect ratio on a 16:9 frame (pixel space)", () => {
        expect(computeEAR(face(0, 1280, 720), 1280, 720)).toBeCloseTo(0.3, 3);
    });

    it("is invariant to head roll", () => {
        expect(computeEAR(face(0.4, 1280, 720), 1280, 720)).toBeCloseTo(0.3, 3);
    });
});

describe("isPoseUsable", () => {
    it("accepts a frontal face and rejects a turned-away one", () => {
        expect(isPoseUsable(10, -5)).toBe(true);
        expect(isPoseUsable(0, 50)).toBe(false);
        expect(isPoseUsable(-45, 0)).toBe(false);
    });
});
