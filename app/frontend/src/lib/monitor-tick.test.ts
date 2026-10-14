import { describe, expect, it } from "vitest";

import { EegHealthAccumulator, totalDropped } from "./monitor-tick";

describe("EegHealthAccumulator", () => {
    it("summarises each channel's samples since the last take", () => {
        const acc = new EegHealthAccumulator();
        acc.add("TP9", [1, 2, 3, 4]);
        acc.add("TP9", [5]);
        const { TP9 } = acc.take(["TP9"]);
        expect(TP9).toEqual({ n: 5, nan: 0, min: 1, max: 5, std: 1.4 });
    });

    it("counts non-finite samples and keeps them out of the statistics", () => {
        const acc = new EegHealthAccumulator();
        acc.add("AF7", [NaN, 10, Infinity, 10]);
        expect(acc.take(["AF7"]).AF7).toEqual({ n: 4, nan: 2, min: 10, max: 10, std: 0 });
    });

    it("reports a silent channel as zero samples", () => {
        const acc = new EegHealthAccumulator();
        acc.add("TP9", [1]);
        expect(acc.take(["TP9", "AF8"]).AF8).toEqual({ n: 0, nan: 0, min: null, max: null, std: null });
    });

    it("an all-NaN second has no statistics", () => {
        const acc = new EegHealthAccumulator();
        acc.add("TP10", [NaN, NaN]);
        expect(acc.take(["TP10"]).TP10).toEqual({ n: 2, nan: 2, min: null, max: null, std: null });
    });

    it("resets after each take", () => {
        const acc = new EegHealthAccumulator();
        acc.add("TP9", [1, 2]);
        acc.take(["TP9"]);
        expect(acc.take(["TP9"]).TP9?.n).toBe(0);
    });
});

describe("totalDropped", () => {
    it("sums the per-channel counts", () => {
        expect(totalDropped({ TP9: 2, AF7: 3 })).toBe(5);
        expect(totalDropped({})).toBe(0);
    });
});
