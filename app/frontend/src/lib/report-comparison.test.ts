import { describe, expect, it } from "vitest";

import type { ComparisonMeasure } from "@/types";
import { describeChange, riskChange, sinceLabel } from "./report-comparison";

const measure = (over: Partial<ComparisonMeasure>): ComparisonMeasure => ({
    id: "bat4",
    label: "BAT-4",
    previousScore: 3.5,
    currentScore: 2.5,
    delta: -1,
    scoreRange: [1, 5],
    direction: "improved",
    previousRisk: "High",
    currentRisk: "Moderate",
    ...over
});

describe("describeChange", () => {
    it("lower is better for burnout measures", () => {
        expect(describeChange(measure({}))).toEqual({ arrow: "▼", label: "Improved", tone: "good", detail: "3.5 → 2.5" });
        expect(describeChange(measure({ direction: "worse", previousScore: 40, currentScore: 75 }))).toEqual({
            arrow: "▲",
            label: "Gone up",
            tone: "bad",
            detail: "40 → 75"
        });
        expect(describeChange(measure({ direction: "same" })).label).toBe("About the same");
    });
});

describe("riskChange", () => {
    it("only when the level changed", () => {
        expect(riskChange(measure({}))).toBe("High → Moderate");
        expect(riskChange(measure({ currentRisk: "High" }))).toBeNull();
        expect(riskChange(measure({ previousRisk: null }))).toBeNull();
    });
});

describe("sinceLabel", () => {
    it("words for today and yesterday, days otherwise", () => {
        expect(sinceLabel(0)).toBe("earlier today");
        expect(sinceLabel(1)).toBe("yesterday");
        expect(sinceLabel(14)).toBe("14 days ago");
        expect(sinceLabel(null)).toBe("");
    });
});
