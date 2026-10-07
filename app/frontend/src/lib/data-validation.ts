// Pure helpers for the admin Data Validation tab (docs/data-validation-dashboard.md).
// Status, report state and the file list are computed server-side
// (ciq/validation/rules.py) — nothing here re-derives them.

import type { DataValidationRun, ValidationFile, ValidationStatus } from "@/types";

export type StatusFilter = "all" | ValidationStatus;

export type StatusCounts = Record<StatusFilter, number>;

export function statusCounts(runs: DataValidationRun[]): StatusCounts {
    const counts: StatusCounts = { all: runs.length, completed: 0, partial: 0, failed: 0 };
    for (const r of runs) counts[r.status] += 1;
    return counts;
}

export function filterByStatus(runs: DataValidationRun[], status: StatusFilter): DataValidationRun[] {
    return status === "all" ? runs : runs.filter(r => r.status === status);
}

export const PAGE_SIZE = 10;

export function pageCount(total: number, size: number = PAGE_SIZE): number {
    return Math.max(1, Math.ceil(total / size));
}

/** One page of `items` (1-based `page`, clamped into range) plus its 1-based row span. */
export function paginate<T>(items: T[], page: number, size: number = PAGE_SIZE): { page: number; items: T[]; from: number; to: number } {
    const current = Math.min(Math.max(1, page), pageCount(items.length, size));
    const start = (current - 1) * size;
    const slice = items.slice(start, start + size);
    return { page: current, items: slice, from: slice.length ? start + 1 : 0, to: start + slice.length };
}

export const STATUS_LABEL: Record<ValidationStatus, string> = {
    completed: "COMPLETED",
    partial: "PARTIAL",
    failed: "FAILED"
};

/** Badge text — partial runs carry the lifecycle reason, e.g. "PARTIAL · closed". */
export function statusBadgeLabel(run: DataValidationRun): string {
    return run.status === "partial" ? `${STATUS_LABEL.partial} · ${run.lifecycleStatus}` : STATUS_LABEL[run.status];
}

/** Mirrors ciq.common.export_names (kind "zip"): ciq_export_<user8>_<run>.zip. */
export function zipFilename(surveyRunId: string, userId?: string | null): string {
    return userId ? `ciq_export_${userId.slice(0, 8)}_${surveyRunId}.zip` : `ciq_export_${surveyRunId}.zip`;
}

/**
 * Lines of the ZIP preview tree, root files first then the eeg/ folder — the same
 * order and names the server writes (ciq.validation.rules.file_manifest).
 */
export function zipTree(files: ValidationFile[]): string[] {
    const rootFiles = files.filter(f => !f.path.includes("/")).map(f => f.path);
    const eegFiles = files.filter(f => f.path.startsWith("eeg/")).map(f => f.path.slice("eeg/".length));
    const entries: { name: string; children?: string[] }[] = rootFiles.map(name => ({ name }));
    if (eegFiles.length) entries.push({ name: "eeg/", children: eegFiles });

    const lines: string[] = [];
    entries.forEach((entry, i) => {
        const last = i === entries.length - 1;
        lines.push(`${last ? "└─ " : "├─ "}${entry.name}`);
        entry.children?.forEach((child, j) => {
            const childLast = j === (entry.children?.length ?? 0) - 1;
            lines.push(`${last ? "   " : "│  "}${childLast ? "└─ " : "├─ "}${child}`);
        });
    });
    return lines;
}

/** Download URL for one per-run file, reusing the existing admin export routes. */
export function exportUrl(surveyRunId: string, kind: "timeline" | "combined" | "eeg" | "zip", segment?: number): string {
    const id = encodeURIComponent(surveyRunId);
    switch (kind) {
        case "timeline":
            return `/admin/survey-timeline/export?survey_run_id=${id}`;
        case "combined":
            return `/admin/survey-timeline/export-combined?survey_run_id=${id}`;
        case "eeg":
            return `/admin/eeg-sessions/export?survey_run_id=${id}${segment === undefined ? "" : `&segment=${segment}`}`;
        case "zip":
            return `/admin/data-validation/export-zip?survey_run_id=${id}`;
    }
}
