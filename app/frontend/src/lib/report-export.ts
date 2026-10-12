// Admin "Participant reports" download (GET /admin/reports/export — ciq/reports/export.py).

export type ReportPeriod = "today" | "7" | "30" | "all";

export const REPORT_PERIODS: { value: ReportPeriod; label: string }[] = [
    { value: "today", label: "Today" },
    { value: "7", label: "Last 7 days" },
    { value: "30", label: "Last 30 days" },
    { value: "all", label: "All" }
];

/**
 * The export URL. `getTimezoneOffset()` is minutes WEST of UTC (Sri Lanka: -330); the
 * server wants minutes EAST (+330), so "Today" starts at the admin's local midnight.
 */
export function reportExportUrl(period: ReportPeriod, timezoneOffset: number = new Date().getTimezoneOffset()): string {
    const east = -timezoneOffset || 0; // `|| 0` turns -0 into 0
    return `/admin/reports/export?period=${period}&tz_offset=${east}`;
}
