// A saved assessment report, reopened read-only (History tab / Admin Data Validation)
// from backend ciq/reports/saved_routes.py. The AI Insights texts are not included.
import type { AnalyzeReportResponse, BiometricSnapshot } from "@/types";
import { DISPLAY_TIME_ZONE } from "@/lib/datetime";

export type SavedReportScope = "me" | "admin";

export type SavedReport = {
    surveyRunId: string;
    surveyType: string;
    createdAt: string | null;
    snapshots: BiometricSnapshot[];
    report: Pick<AnalyzeReportResponse, "totalScore" | "maxScore" | "riskLevel" | "interpretation" | "sections" | "domainTotals">;
};

/** The user's own reports live under /me; admins read any run under /admin. */
export function savedReportUrl(scope: SavedReportScope, surveyRunId: string): string {
    const id = encodeURIComponent(surveyRunId);
    return scope === "admin" ? `/admin/reports/runs/${id}` : `/me/reports/${id}`;
}

/** The PDF's suggested file name: <survey type>-report-<yyyy-mm-dd, Sri Lanka>-<first 8 of run id>. */
export function reportFileTitle(surveyType: string | undefined, surveyRunId: string | undefined, when: Date): string {
    const type = (surveyType || "assessment").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const day = Number.isNaN(when.getTime()) ? "" : when.toLocaleDateString("en-CA", { timeZone: DISPLAY_TIME_ZONE }); // en-CA = yyyy-mm-dd
    return [type, "report", day, surveyRunId?.slice(0, 8)].filter(Boolean).join("-");
}
