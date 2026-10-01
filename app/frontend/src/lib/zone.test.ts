import { describe, it, expect } from "vitest";
import {
    LEAN_HINT, LEAN_LABEL, ZONE_BANDS, ZONE_DISCLAIMER, ZONE_EMPTY_TEXT, ZONE_LABEL, ZONE_TONE,
    hasMarker, scaleAriaLabel, trendBadge,
} from "./zone";
import type { ZoneResult } from "@/types";

const base: ZoneResult = {
    surveyRunId: "r1", date: "2026-10-01", fatigue: 50, burnout: 25, severity: 43,
    zone: "mild", lean: "fatigue", leanValue: -25, marker: 38, signals: [],
};

describe("zone labels and tones", () => {
    it.each([
        ["well", "Doing well", "green"],
        ["mild", "Mild strain", "blue"],
        ["moderate", "Moderate strain", "amber"],
        ["high", "High strain", "red"],
    ] as const)("%s → %s / %s", (zone, label, tone) => {
        expect(ZONE_LABEL[zone]).toBe(label);
        expect(ZONE_TONE[zone]).toBe(tone);
    });

    it("lean labels", () => {
        expect(LEAN_LABEL.fatigue).toBe("Fatigue-leaning");
        expect(LEAN_LABEL.burnout).toBe("Burnout-leaning");
        expect(LEAN_LABEL.mixed).toBe("Mixed");
        expect(LEAN_LABEL.none).toBe("");
        expect(LEAN_HINT.fatigue).toMatch(/rest/i);
        expect(LEAN_HINT.burnout).toMatch(/change/i);
    });

    it("bands match the backend zone edges", () => {
        expect(ZONE_BANDS.map(b => [b.from, b.to, b.zone])).toEqual([
            [0, 25, "well"], [25, 50, "mild"], [50, 75, "moderate"], [75, 100, "high"],
        ]);
    });

    it("copy is exact", () => {
        expect(ZONE_EMPTY_TEXT).toBe("Complete a check-in to see your zone");
        expect(ZONE_DISCLAIMER).toBe("A wellbeing guide, not a diagnosis.");
    });
});

describe("trendBadge", () => {
    it.each([
        ["none", "No check-ins yet", "neutral"],
        ["first", "First check-in", "neutral"],
        ["improving", "Improving", "green"],
        ["steady", "Steady", "blue"],
        ["worsening", "Worsening", "red"],
    ] as const)("%s", (status, text, tone) => {
        expect(trendBadge(status)).toEqual({ text, tone });
    });
});

describe("marker", () => {
    it("shows a marker when present", () => {
        expect(hasMarker(base)).toBe(true);
        expect(scaleAriaLabel(base)).toBe("Fatigue to burnout scale: marker at 38 of 100, fatigue-leaning");
    });

    it("greys out when marker is null (zone well)", () => {
        const well: ZoneResult = { ...base, zone: "well", lean: "none", marker: null };
        expect(hasMarker(well)).toBe(false);
        expect(scaleAriaLabel(well)).toBe("Fatigue to burnout scale: low strain, no lean");
    });

    it("treats marker 0 as present", () => {
        expect(hasMarker({ ...base, marker: 0 })).toBe(true);
    });
});
