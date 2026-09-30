import { describe, expect, it } from "vitest";

import { formatServerDate, parseServerDate } from "./datetime";

const TIME = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;

describe("parseServerDate", () => {
    it("reads an offset-less backend timestamp as UTC, not browser-local time", () => {
        expect(parseServerDate("2026-09-30T06:33:04.123456").toISOString()).toBe("2026-09-30T06:33:04.123Z");
    });

    it("keeps an explicit offset", () => {
        expect(parseServerDate("2026-09-30T06:33:04+00:00").toISOString()).toBe("2026-09-30T06:33:04.000Z");
        expect(parseServerDate("2026-09-30T12:03:04+05:30").toISOString()).toBe("2026-09-30T06:33:04.000Z");
        expect(parseServerDate("2026-09-30T06:33:04Z").toISOString()).toBe("2026-09-30T06:33:04.000Z");
    });

    it("is invalid for missing input", () => {
        expect(Number.isNaN(parseServerDate(null).getTime())).toBe(true);
        expect(Number.isNaN(parseServerDate("").getTime())).toBe(true);
    });
});

describe("formatServerDate", () => {
    it("shows Sri Lanka time (UTC+05:30)", () => {
        expect(formatServerDate("2026-09-30T06:33:04", TIME, "en-GB")).toBe("12:03");
        expect(formatServerDate("2026-09-30T06:33:04+00:00", TIME, "en-GB")).toBe("12:03");
    });

    it("rolls the date over at Sri Lankan midnight, not UTC midnight", () => {
        const day = { day: "numeric", month: "numeric" } as const;
        expect(formatServerDate("2026-09-30T19:00:00", day, "en-GB")).toBe("01/10");
    });

    it("returns a dash for missing or garbage values", () => {
        expect(formatServerDate(undefined)).toBe("—");
        expect(formatServerDate("not a date")).toBe("—");
    });
});
