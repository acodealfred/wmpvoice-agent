import { describe, expect, it } from "vitest";

import { CONTACT, contactNoise, contactQuality, contactSnapshot, rateLooksWrong } from "./contact";

/** A signal whose every step (so the median step) is exactly `stepUv` µV. */
function signal(stepUv: number, n: number = CONTACT.windowSamples): number[] {
    return Array.from({ length: n }, (_, i) => (i % 2 ? stepUv : 0));
}

describe("contactQuality — real readings carried over from the iOS probe", () => {
    it.each([8.8, 13.2, 16.1, 17.1, 17.6])("working sensor at %s µV is good", uv => {
        expect(contactQuality(signal(uv))).toBe("good");
        expect(contactNoise(signal(uv))).toBeCloseTo(uv);
    });

    it.each([104, 133.3, 230])("floating sensor at %s µV is floating", uv => {
        expect(contactQuality(signal(uv))).toBe("floating");
    });

    it("an in-between 35 µV is marginal, not fine", () => {
        expect(contactQuality(signal(35))).toBe("marginal");
    });

    it("thresholds are inclusive on the good side", () => {
        expect(contactQuality(signal(25))).toBe("good");
        expect(contactQuality(signal(50))).toBe("marginal");
    });
});

describe("contactQuality — window and edge cases", () => {
    it("no data, or under ~0.5 s of it, is unknown with no noise figure", () => {
        expect(contactQuality([])).toBe("unknown");
        expect(contactNoise([])).toBeNull();
        expect(contactQuality(signal(10, CONTACT.minSamples - 1))).toBe("unknown");
        expect(contactQuality(signal(10, CONTACT.minSamples))).toBe("good");
    });

    it("recovers once the window refills with clean signal (230 → 9)", () => {
        const refit = [...signal(230), ...signal(9)];
        expect(contactQuality(refit)).toBe("good");
        expect(contactNoise(refit)).toBeCloseTo(9);
    });

    it("one big spike doesn't turn a good sensor red (median, not mean)", () => {
        const s = signal(10);
        s[200] = 5000;
        expect(contactQuality(s)).toBe("good");
    });

    it("median of an even number of steps is the mean of the middle two", () => {
        // steps: 10, 20, 30, 40 → median 25
        expect(contactNoise([0, 10, 30, 60, 100])).toBe(25);
    });
});

describe("contactSnapshot", () => {
    it("judges each sensor on its own and uses the iOS field names", () => {
        const data = { TP9: signal(124), AF7: signal(15), AF8: signal(4), TP10: signal(32) } as const;
        const snap = contactSnapshot("baseline_start", 1234.56, ["TP9", "AF7", "AF8", "TP10"], ch => data[ch as keyof typeof data], 255.94);
        expect(snap).toEqual({
            label: "baseline_start",
            t_ms: 1234.6,
            muse_contact: { TP9: "floating", AF7: "good", AF8: "good", TP10: "marginal" },
            muse_contact_noise_uv: { TP9: 124, AF7: 15, AF8: 4, TP10: 32 },
            eeg_rate_hz_observed: 255.9
        });
    });

    it("a channel with no data is unknown with a null noise figure", () => {
        const snap = contactSnapshot("baseline_end", 0, ["TP9"], () => [], null);
        expect(snap.muse_contact.TP9).toBe("unknown");
        expect(snap.muse_contact_noise_uv.TP9).toBeNull();
        expect(snap.eeg_rate_hz_observed).toBeNull();
    });
});

describe("rateLooksWrong", () => {
    it("flags rates more than 10% from 256 Hz, and never an unknown rate", () => {
        expect(rateLooksWrong(256)).toBe(false);
        expect(rateLooksWrong(240)).toBe(false);
        expect(rateLooksWrong(220)).toBe(true);
        expect(rateLooksWrong(300)).toBe(true);
        expect(rateLooksWrong(null)).toBe(false);
    });
});
