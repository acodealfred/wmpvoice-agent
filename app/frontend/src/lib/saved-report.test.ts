import { describe, expect, it } from "vitest";
import { reportFileTitle, savedReportUrl } from "./saved-report";

describe("savedReportUrl", () => {
    it("uses /me for the user's own reports and /admin for admins", () => {
        expect(savedReportUrl("me", "run-1")).toBe("/me/reports/run-1");
        expect(savedReportUrl("admin", "run-1")).toBe("/admin/reports/runs/run-1");
    });

    it("encodes the run id", () => {
        expect(savedReportUrl("me", "a/b?c")).toBe("/me/reports/a%2Fb%3Fc");
    });
});

describe("reportFileTitle", () => {
    it("names the file by survey type, Sri Lanka date and short run id", () => {
        // 20:00 UTC on 9 Oct is already 10 Oct in Sri Lanka (UTC+05:30).
        const when = new Date("2026-10-09T20:00:00Z");
        expect(reportFileTitle("PILOT", "6f1c2a90-1234-5678", when)).toBe("pilot-report-2026-10-10-6f1c2a90");
    });

    it("falls back when the type, run id or date is missing", () => {
        expect(reportFileTitle(undefined, undefined, new Date("2026-10-10T02:00:00Z"))).toBe("assessment-report-2026-10-10");
        expect(reportFileTitle("BAT Full", "run", new Date(NaN))).toBe("bat-full-report-run");
    });
});
