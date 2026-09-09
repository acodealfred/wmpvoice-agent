import { describe, it, expect } from "vitest";
import { stabilityOf, RollingWindow, FLAT_STD_UV, STABLE_STD_UV, NOISY_STD_UV, RAIL_UV } from "./stability";

const sine = (amp: number, n = 256) => Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 10 * i) / 256));
const noise = (std: number, n = 256) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? std : -std));

describe("stabilityOf", () => {
    it("needs a minimum number of samples", () => {
        expect(stabilityOf([])).toBe("settling");
        expect(stabilityOf(new Array(31).fill(10))).toBe("settling");
    });

    it.each([
        ["flat (no contact)", noise(FLAT_STD_UV - 0.1), "unstable"],
        ["just above flat", noise(FLAT_STD_UV + 0.1), "stable"],
        ["clean EEG", sine(20), "stable"],
        ["at the stable limit", noise(STABLE_STD_UV), "stable"],
        ["above the stable limit", noise(STABLE_STD_UV + 1), "settling"],
        ["very noisy", noise(NOISY_STD_UV + 1), "unstable"]
    ] as const)("%s → %s", (_label, samples, expected) => {
        expect(stabilityOf(samples)).toBe(expected);
    });

    it("treats any railed sample as unstable", () => {
        const s = sine(20);
        s[100] = RAIL_UV;
        expect(stabilityOf(s)).toBe("unstable");
        s[100] = -RAIL_UV;
        expect(stabilityOf(s)).toBe("unstable");
    });
});

describe("thresholds", () => {
    it("keeps the values calibrated against LibMuse HSI on 2026-09-04", () => {
        // 532 channel-seconds of LibMuse EEG, rescaled to our units and scored
        // against its own HSI. 60 µV keeps 91% of HSI-good seconds as "stable";
        // the old 40 µV kept only 78%.
        expect(STABLE_STD_UV).toBe(60);
        expect(NOISY_STD_UV).toBe(150);
        expect(RAIL_UV).toBe(990);
        expect(FLAT_STD_UV).toBe(1.5);
    });
});

describe("RollingWindow", () => {
    it("keeps the most recent `size` samples in order", () => {
        const w = new RollingWindow(4);
        w.push([1, 2, 3]);
        expect(Array.from(w.values())).toEqual([1, 2, 3]);
        w.push([4, 5, 6]);
        expect(Array.from(w.values())).toEqual([3, 4, 5, 6]);
        expect(w.count()).toBe(4);
    });
});
