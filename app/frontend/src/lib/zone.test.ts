import { describe, expect, it } from "vitest";

import type { ZoneKey, ZoneLean } from "@/types";

import { formatZoneDate, isScaleMuted, leanHint, leanLabel, trendBadge, trendDetail, zoneColor, zoneLabel } from "./zone";

const ZONES: ZoneKey[] = ["well", "mild", "moderate", "high"];
const LEANS: ZoneLean[] = ["fatigue", "burnout", "mixed", "none"];

describe("zone labels and colours", () => {
    it("labels every zone", () => {
        expect(ZONES.map(zoneLabel)).toEqual(["Doing well", "Mild strain", "Moderate strain", "High strain"]);
    });

    it("gives every zone a distinct theme colour", () => {
        const colors = ZONES.map(zoneColor);
        expect(new Set(colors).size).toBe(ZONES.length);
        colors.forEach(c => expect(c).toMatch(/^var\(--ciq-/));
    });

    it("labels and explains every lean", () => {
        expect(LEANS.map(leanLabel)).toEqual(["Fatigue-leaning", "Burnout-leaning", "Mixed", "No clear lean"]);
        LEANS.forEach(l => expect(leanHint(l).length).toBeGreaterThan(0));
    });
});

describe("scale state", () => {
    it("greys out the line when there is no marker", () => {
        expect(isScaleMuted(null)).toBe(true);
        expect(isScaleMuted(0)).toBe(false);
        expect(isScaleMuted(38)).toBe(false);
    });
});

describe("trend badge", () => {
    const compared = { delta: 0, ref: 40, compared: 2, points: [] };

    it("covers every status", () => {
        expect(trendBadge({ status: "none", points: [] })).toEqual({ text: "No check-ins yet", tone: "neutral" });
        expect(trendBadge({ status: "first", points: [] })).toEqual({ text: "First check-in", tone: "neutral" });
        expect(trendBadge({ status: "improving", ...compared })).toEqual({ text: "Improving", tone: "good" });
        expect(trendBadge({ status: "steady", ...compared })).toEqual({ text: "Steady", tone: "neutral" });
        expect(trendBadge({ status: "worsening", ...compared })).toEqual({ text: "Worsening", tone: "bad" });
    });

    it("explains the comparison only when there was one", () => {
        expect(trendDetail({ status: "first", points: [] })).toBeNull();
        expect(trendDetail({ status: "worsening", delta: 7, ref: 36, compared: 1, points: [] })).toBe("Strain +7 vs your previous check-in (average 36).");
        expect(trendDetail({ status: "improving", delta: -9, ref: 50, compared: 3, points: [] })).toBe("Strain -9 vs your previous 3 check-ins (average 50).");
    });
});

describe("formatZoneDate", () => {
    it("formats a UTC calendar date without shifting the day", () => {
        expect(formatZoneDate("2026-09-08")).toBe("Sep 8");
        expect(formatZoneDate("2026-01-01")).toBe("Jan 1");
    });

    it("passes through anything it cannot parse", () => {
        expect(formatZoneDate("")).toBe("");
    });
});
