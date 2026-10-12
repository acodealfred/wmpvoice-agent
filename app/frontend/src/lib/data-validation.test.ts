import { describe, expect, it } from "vitest";

import type { DataValidationRun } from "@/types";

import { exportUrl, filterByStatus, filterByUserId, pageCount, paginate, statusBadgeLabel, statusCounts, zipFilename, zipTree } from "./data-validation";

function run(over: Partial<DataValidationRun>): DataValidationRun {
    return {
        surveyRunId: "run-1",
        userId: "user-1",
        userName: "P001",
        surveyType: "PILOT",
        lifecycleStatus: "completed",
        createdAt: "2026-10-06T08:00:00",
        completedAt: "2026-10-06T08:20:00",
        status: "completed",
        report: "saved",
        aiSummaryGenerated: false,
        scores: { scored: true, primary: { label: "BAT-4", riskLevel: "Low", score: 1.5, max: 5 }, cbi: null, riskDeviation: false },
        eegSegments: [],
        files: [],
        fileCount: 0,
        ...over
    };
}

describe("filterByUserId", () => {
    const runs = [
        run({ surveyRunId: "a", userId: "6f1c2a90-aaaa" }),
        run({ surveyRunId: "b", userId: "6F1C77B0-bbbb" }),
        run({ surveyRunId: "c", userId: "d4e5f6a7-cccc" }),
        run({ surveyRunId: "d", userId: null })
    ];
    const ids = (q: string) => filterByUserId(runs, q).map(r => r.surveyRunId);

    it("matches any part of the user ID, ignoring case and surrounding spaces", () => {
        expect(ids("6f1c")).toEqual(["a", "b"]);
        expect(ids("  CCCC ")).toEqual(["c"]);
    });

    it("keeps every run for a blank query", () => {
        expect(ids("")).toEqual(["a", "b", "c", "d"]);
        expect(ids("   ")).toEqual(["a", "b", "c", "d"]);
    });

    it("never matches a run without a user ID, and returns none for no match", () => {
        expect(ids("null")).toEqual([]);
        expect(ids("zzz")).toEqual([]);
    });
});

describe("statusCounts / filterByStatus", () => {
    const runs = [
        run({ surveyRunId: "a" }),
        run({ surveyRunId: "b", status: "partial", lifecycleStatus: "closed" }),
        run({ surveyRunId: "c", status: "failed" }),
        run({ surveyRunId: "d", status: "partial", lifecycleStatus: "paused" })
    ];

    it("counts every status plus all", () => {
        expect(statusCounts(runs)).toEqual({ all: 4, completed: 1, partial: 2, failed: 1 });
    });

    it("filters to one status, or none for all", () => {
        expect(filterByStatus(runs, "partial").map(r => r.surveyRunId)).toEqual(["b", "d"]);
        expect(filterByStatus(runs, "all")).toHaveLength(4);
    });
});

describe("statusBadgeLabel", () => {
    it("shows the lifecycle reason only for partial runs", () => {
        expect(statusBadgeLabel(run({ status: "partial", lifecycleStatus: "closed" }))).toBe("PARTIAL · closed");
        expect(statusBadgeLabel(run({ status: "failed" }))).toBe("FAILED");
        expect(statusBadgeLabel(run({}))).toBe("COMPLETED");
    });
});

describe("zipFilename", () => {
    it("carries the owner's short user id like the server's archive name", () => {
        expect(zipFilename("run-abc", "99887766-5544")).toBe("ciq_export_99887766_run-abc.zip");
        expect(zipFilename("run-abc", null)).toBe("ciq_export_run-abc.zip");
    });
});

describe("zipTree", () => {
    it("lists root files then one eeg/ line per segment", () => {
        expect(
            zipTree([
                { kind: "timeline", path: "survey_timeline_abc.csv" },
                { kind: "combined", path: "survey_timeline_combined_abc.csv" },
                { kind: "eeg", segment: 0, path: "eeg/eeg_segment0_abc.json" },
                { kind: "eeg", segment: 1, path: "eeg/eeg_segment1_abc.json" }
            ])
        ).toEqual([
            "├─ survey_timeline_abc.csv",
            "├─ survey_timeline_combined_abc.csv",
            "└─ eeg/",
            "   ├─ eeg_segment0_abc.json",
            "   └─ eeg_segment1_abc.json"
        ]);
    });

    it("ends on the last root file when there is no EEG", () => {
        expect(zipTree([{ kind: "timeline", path: "survey_timeline_abc.csv" }])).toEqual(["└─ survey_timeline_abc.csv"]);
    });
});

describe("exportUrl", () => {
    it("reuses the existing admin export routes", () => {
        expect(exportUrl("a b", "eeg", 2)).toBe("/admin/eeg-sessions/export?survey_run_id=a%20b&segment=2");
        expect(exportUrl("r", "eeg")).toBe("/admin/eeg-sessions/export?survey_run_id=r");
        expect(exportUrl("r", "zip")).toBe("/admin/data-validation/export-zip?survey_run_id=r");
    });
});

describe("paginate", () => {
    const items = Array.from({ length: 23 }, (_, i) => i + 1);

    it("serves 10 rows per page with a 1-based span", () => {
        expect(pageCount(items.length)).toBe(3);
        expect(paginate(items, 1)).toEqual({ page: 1, items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], from: 1, to: 10 });
        expect(paginate(items, 3)).toEqual({ page: 3, items: [21, 22, 23], from: 21, to: 23 });
    });

    it("clamps out-of-range pages (e.g. after the filter shrinks the list)", () => {
        expect(paginate(items, 9).page).toBe(3);
        expect(paginate(items, 0).page).toBe(1);
    });

    it("handles an empty list", () => {
        expect(pageCount(0)).toBe(1);
        expect(paginate([], 1)).toEqual({ page: 1, items: [], from: 0, to: 0 });
    });
});
