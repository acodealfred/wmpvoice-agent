import { describe, expect, it } from "vitest";

import { REPORT_PERIODS, reportExportUrl } from "./report-export";

describe("reportExportUrl", () => {
    it("sends the offset as minutes east of UTC (Sri Lanka = +330)", () => {
        expect(reportExportUrl("today", -330)).toBe("/admin/reports/export?period=today&tz_offset=330");
        expect(reportExportUrl("7", 300)).toBe("/admin/reports/export?period=7&tz_offset=-300");
        expect(reportExportUrl("all", 0)).toBe("/admin/reports/export?period=all&tz_offset=0");
    });

    it("offers today, 7 days, 30 days and all", () => {
        expect(REPORT_PERIODS.map(p => p.value)).toEqual(["today", "7", "30", "all"]);
    });
});
