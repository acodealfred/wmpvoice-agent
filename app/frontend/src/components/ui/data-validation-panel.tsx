// Admin "Data Validation" tab — confirms each assessment run was persisted and
// exposes every per-run export in one place. Spec: docs/data-validation-dashboard.md;
// visual reference: docs/design/data-validation.dc.html.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, FileText, Loader2, RefreshCw, Search, X } from "lucide-react";

import type { DataValidationResponse, DataValidationRun, ValidationReportState, ValidationStatus } from "@/types";
import { apiFetch } from "@/lib/api";
import { BANNER, PILL, riskTone, type Tone } from "@/lib/badges";
import { formatServerDate } from "@/lib/datetime";
import {
    exportUrl,
    filterByStatus,
    filterByUserId,
    pageCount,
    paginate,
    statusBadgeLabel,
    statusCounts,
    zipFilename,
    zipTree,
    type StatusFilter
} from "@/lib/data-validation";
import { downloadBlob, filenameFromResponse } from "@/ui/download";

const STATUS_TONE: Record<ValidationStatus, Tone> = { completed: "green", partial: "amber", failed: "red" };

const REPORT_CHIP: Record<ValidationReportState, { label: string; tone: Tone; note: string }> = {
    saved: { label: "Saved", tone: "green", note: "Report saved to the database." },
    not_generated: { label: "Not generated", tone: "neutral", note: "The user left before the report — expected for a partial run." },
    missing: { label: "Missing", tone: "red", note: "The run completed but no report was saved." }
};

const PILLS: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "ALL" },
    { key: "completed", label: "COMPLETED" },
    { key: "partial", label: "PARTIAL" },
    { key: "failed", label: "FAILED" }
];

const RANGES = [
    { value: "1", label: "Today" },
    { value: "7", label: "Last 7 days" },
    { value: "30", label: "Last 30 days" },
    { value: "all", label: "All time" }
];

const CARD = "rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] shadow-md";
const CHIP = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold";
const BADGE = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wider";
const PAGE_BTN =
    "inline-flex h-9 min-w-[36px] items-center justify-center rounded-md border border-[color:var(--ciq-line)] px-2 text-[color:var(--ciq-text-muted)] hover:bg-[color:var(--ciq-hover)] disabled:cursor-not-allowed disabled:opacity-40";
const MENU_ITEM =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-[color:var(--ciq-text-strong)] hover:bg-[color:var(--ciq-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

function FormatTag({ children, strong = false }: { children: string; strong?: boolean }) {
    return (
        <span
            className={`font-data inline-flex h-[22px] min-w-[42px] shrink-0 items-center justify-center rounded border px-1.5 text-[10px] ${
                strong
                    ? "border-[color:var(--ciq-accent-purple)] text-[color:var(--ciq-accent-purple)]"
                    : "border-[color:var(--ciq-line)] text-[color:var(--ciq-text-muted)]"
            }`}
        >
            {children}
        </span>
    );
}

function StatusBadge({ run }: { run: DataValidationRun }) {
    return (
        <span className={`${BADGE} ${PILL[STATUS_TONE[run.status]]}`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {statusBadgeLabel(run)}
        </span>
    );
}

// riskTone covers Low/Moderate/High; READINESS reports "Medium", which is amber too.
function levelTone(level: string): Tone {
    return level === "Medium" ? "amber" : riskTone(level);
}

function segmentSpan(start: string | null, end: string | null): string {
    if (!start) return "";
    const t = (v: string | null) => formatServerDate(v, { timeStyle: "short" });
    return end ? `${t(start)}–${t(end)}` : t(start);
}

export function DataValidationPanel() {
    const [range, setRange] = useState("30");
    const [status, setStatus] = useState<StatusFilter>("all");
    const [userQuery, setUserQuery] = useState("");
    const [data, setData] = useState<DataValidationResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const resp = await apiFetch(`/admin/data-validation/runs?days=${encodeURIComponent(range)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            setData((await resp.json()) as DataValidationResponse);
        } catch (err) {
            setLoadError(err instanceof Error ? `Could not load runs (${err.message})` : "Could not load runs");
        } finally {
            setLoading(false);
        }
    }, [range]);

    useEffect(() => {
        void load();
    }, [load]);

    const runs = useMemo(() => data?.runs ?? [], [data]);
    // User-ID search first, so the status pills and summary tiles count what it leaves.
    const searched = useMemo(() => filterByUserId(runs, userQuery), [runs, userQuery]);
    const counts = useMemo(() => statusCounts(searched), [searched]);
    const rows = useMemo(() => filterByStatus(searched, status), [searched, status]);
    const selected = runs.find(r => r.surveyRunId === selectedId) ?? null;

    // 10 rows per page; back to page 1 whenever the filtered list changes.
    const [page, setPage] = useState(1);
    useEffect(() => setPage(1), [rows]);
    const pageView = useMemo(() => paginate(rows, page), [rows, page]);
    const pages = pageCount(rows.length);

    // Close the export menu on outside click / Escape.
    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setMenuOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [menuOpen]);

    const selectRun = (id: string) => {
        setSelectedId(id);
        setMenuOpen(false);
        setDownloadError(null);
        setDownloadNotice(null);
    };

    const download = async (key: string, url: string, fallbackName: string) => {
        setBusyKey(key);
        setDownloadError(null);
        setDownloadNotice(null);
        try {
            const resp = await apiFetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const warning = resp.headers.get("X-Unified-Warning");
            downloadBlob(await resp.blob(), filenameFromResponse(resp, fallbackName));
            if (warning) setDownloadNotice(warning);
            setMenuOpen(false);
        } catch (err) {
            setDownloadError(err instanceof Error ? `Download failed (${err.message})` : "Download failed");
        } finally {
            setBusyKey(null);
        }
    };

    const okPct = counts.all ? Math.round((counts.completed / counts.all) * 100) : 0;

    return (
        <div className="flex flex-col gap-5">
            {/* ── Title ── */}
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex max-w-2xl flex-col gap-1">
                    <span className="font-data text-xs tracking-widest text-[color:var(--ciq-text-muted)]">ASSESSMENT PERSISTENCE</span>
                    <h1 className="font-display text-3xl font-bold text-[color:var(--ciq-text-strong)]">Data Validation</h1>
                    <p className="text-sm text-[color:var(--ciq-text-muted)]">
                        Confirms each assessment run was saved to the database, with its report and export files.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex flex-col items-end">
                        <span className="text-xs text-[color:var(--ciq-text-muted)]">Last checked</span>
                        <span className="font-data text-sm text-[color:var(--ciq-text-body)]">{data ? formatServerDate(data.checkedAt) : "—"}</span>
                    </div>
                    <button
                        type="button"
                        onClick={() => void load()}
                        disabled={loading}
                        aria-label="Refresh"
                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-strong)] hover:opacity-90 disabled:opacity-40"
                    >
                        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                    </button>
                </div>
            </div>

            {/* ── Filters ── */}
            <section aria-label="Filters" className={`${CARD} flex flex-wrap items-center justify-between gap-3 px-4 py-3`}>
                <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-2">
                    <span className="mr-1 text-xs font-bold text-[color:var(--ciq-text-muted)]">Status</span>
                    {PILLS.map(p => {
                        const on = status === p.key;
                        return (
                            <button
                                key={p.key}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setStatus(p.key)}
                                className={`inline-flex min-h-[40px] items-center gap-2 rounded-full border px-4 text-xs font-bold tracking-wider ${
                                    on
                                        ? "border-[color:var(--ciq-accent-purple)] bg-[color:var(--ciq-hover)] text-[color:var(--ciq-text-strong)]"
                                        : "border-[color:var(--ciq-line)] text-[color:var(--ciq-text-muted)] hover:bg-[color:var(--ciq-hover)]"
                                }`}
                            >
                                {p.label}
                                <span className={`font-data text-xs font-medium ${on ? "text-[color:var(--ciq-accent-purple)]" : ""}`}>{counts[p.key]}</span>
                            </button>
                        );
                    })}
                </div>
                <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ciq-text-muted)]" aria-hidden />
                    <input
                        type="search"
                        value={userQuery}
                        onChange={e => setUserQuery(e.target.value)}
                        placeholder="Search user ID…"
                        aria-label="Search by user ID"
                        className="font-data h-10 w-full rounded-md border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] pl-9 pr-9 text-sm text-[color:var(--ciq-text-strong)] placeholder:font-sans placeholder:text-[color:var(--ciq-text-muted)] focus:border-[color:var(--ciq-accent-purple)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
                    />
                    {userQuery && (
                        <button
                            type="button"
                            onClick={() => setUserQuery("")}
                            aria-label="Clear user ID search"
                            className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-[color:var(--ciq-text-muted)] hover:text-[color:var(--ciq-text-strong)]"
                        >
                            <X className="h-4 w-4" aria-hidden />
                        </button>
                    )}
                </div>
                <label className="flex items-center gap-2 text-xs font-bold text-[color:var(--ciq-text-muted)]">
                    Completed within
                    <select
                        value={range}
                        onChange={e => setRange(e.target.value)}
                        className="h-10 rounded-md border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] px-3 text-sm font-normal text-[color:var(--ciq-text-strong)] focus:border-[color:var(--ciq-accent-purple)] focus:outline-none"
                    >
                        {RANGES.map(r => (
                            <option key={r.value} value={r.value}>
                                {r.label}
                            </option>
                        ))}
                    </select>
                </label>
            </section>

            {loadError && <p className={`rounded-lg px-4 py-3 text-sm ${BANNER.red}`}>{loadError}</p>}

            {/* ── Summary ── */}
            <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                    { label: "Total runs", value: counts.all, sub: "in selected period", tone: "" },
                    { label: "Completed", value: counts.completed, sub: `${okPct}% fully saved and exportable`, tone: "text-[color:var(--ciq-accent-green)]" },
                    { label: "Partial", value: counts.partial, sub: "left before the report", tone: "text-[color:var(--ciq-accent-amber)]" },
                    { label: "Failed", value: counts.failed, sub: "completed, but data missing", tone: "text-[color:var(--ciq-accent-red)]" }
                ].map(t => (
                    <div key={t.label} className={`${CARD} flex flex-col gap-1 p-4`}>
                        <span className="text-xs font-semibold text-[color:var(--ciq-text-muted)]">{t.label}</span>
                        <span className={`font-data text-3xl ${t.tone || "text-[color:var(--ciq-text-strong)]"}`}>{t.value}</span>
                        <span className="text-xs text-[color:var(--ciq-text-muted)]">{t.sub}</span>
                    </div>
                ))}
            </section>

            {/* ── Table + details (same height; details scroll inside) ── */}
            <div className="flex flex-wrap items-stretch gap-5">
                <section aria-labelledby="dv-runs-h" className={`${CARD} flex min-h-[560px] min-w-0 flex-[999_1_600px] flex-col overflow-hidden`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                        <h2 id="dv-runs-h" className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">
                            Assessment runs <span className="font-data text-sm font-normal text-[color:var(--ciq-text-muted)]">{rows.length}</span>
                        </h2>
                        <span className="text-xs text-[color:var(--ciq-text-muted)]">Newest first · select a row for details</span>
                    </div>
                    <div className="flex-1 overflow-x-auto">
                        <table className="w-full min-w-[820px] border-collapse text-sm">
                            <thead>
                                <tr className="text-left text-[11px] uppercase tracking-wider text-[color:var(--ciq-text-muted)]">
                                    <th scope="col" className="px-4 py-2 font-bold">
                                        Run
                                    </th>
                                    <th scope="col" className="px-2 py-2 font-bold">
                                        User ID
                                    </th>
                                    <th scope="col" className="px-2 py-2 font-bold">
                                        Type
                                    </th>
                                    <th scope="col" className="px-2 py-2 font-bold">
                                        Completed
                                    </th>
                                    <th scope="col" className="px-2 py-2 font-bold">
                                        Report
                                    </th>
                                    <th scope="col" className="px-2 py-2 font-bold">
                                        Export files
                                    </th>
                                    <th scope="col" className="px-4 py-2 font-bold">
                                        Status
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {pageView.items.map(r => {
                                    const sel = r.surveyRunId === selectedId;
                                    const report = REPORT_CHIP[r.report];
                                    return (
                                        // The whole row selects the run for mouse users; the run-id
                                        // button inside stays as the keyboard / screen-reader target.
                                        <tr
                                            key={r.surveyRunId}
                                            onClick={() => selectRun(r.surveyRunId)}
                                            className={`cursor-pointer border-t border-[color:var(--ciq-line)] ${sel ? "bg-[color:var(--ciq-hover)]" : "hover:bg-[color:var(--ciq-tile)]"}`}
                                        >
                                            <td className="px-4 py-2">
                                                <button
                                                    type="button"
                                                    onClick={e => {
                                                        e.stopPropagation();
                                                        selectRun(r.surveyRunId);
                                                    }}
                                                    aria-pressed={sel}
                                                    title={r.surveyRunId}
                                                    className="font-data min-h-[32px] text-[color:var(--ciq-text-strong)] underline decoration-[color:var(--ciq-line)] underline-offset-4 hover:text-[color:var(--ciq-accent-purple)] hover:decoration-[color:var(--ciq-accent-purple)]"
                                                >
                                                    {r.surveyRunId.slice(0, 8)}
                                                </button>
                                            </td>
                                            <td className="font-data px-2 py-2 text-xs text-[color:var(--ciq-text-body)]" title={r.userId ?? undefined}>
                                                {r.userId ? r.userId.slice(0, 8) : "—"}
                                            </td>
                                            <td className="font-data px-2 py-2 text-xs text-[color:var(--ciq-text-body)]">{r.surveyType ?? "—"}</td>
                                            <td className="font-data whitespace-nowrap px-2 py-2 text-xs text-[color:var(--ciq-text-body)]">
                                                {formatServerDate(r.completedAt)}
                                            </td>
                                            <td className="px-2 py-2">
                                                <span className={`${CHIP} ${PILL[report.tone]}`}>{report.label}</span>
                                            </td>
                                            <td className="px-2 py-2">
                                                {r.fileCount ? (
                                                    <span className={`${CHIP} ${PILL.green}`}>
                                                        <FileText className="h-3.5 w-3.5" aria-hidden />
                                                        Available · {r.fileCount}
                                                    </span>
                                                ) : (
                                                    <span
                                                        className={`${CHIP} border border-dashed border-[color:var(--ciq-line)] text-[color:var(--ciq-text-muted)]`}
                                                    >
                                                        <FileText className="h-3.5 w-3.5" aria-hidden />
                                                        Not available
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-4 py-2">
                                                <StatusBadge run={r} />
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {loading && !data && (
                            <div className="flex items-center justify-center gap-2 py-10 text-sm text-[color:var(--ciq-text-muted)]">
                                <Loader2 className="h-4 w-4 animate-spin" /> Loading runs…
                            </div>
                        )}
                        {data && rows.length === 0 && (
                            <div className="py-10 text-center text-sm text-[color:var(--ciq-text-muted)]">No runs match this filter.</div>
                        )}
                    </div>
                    {rows.length > 0 && (
                        <nav
                            aria-label="Runs pages"
                            className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--ciq-line)] px-4 py-3"
                        >
                            <span className="font-data text-xs text-[color:var(--ciq-text-muted)]">
                                {pageView.from}–{pageView.to} of {rows.length}
                            </span>
                            <div className="flex flex-wrap items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => setPage(pageView.page - 1)}
                                    disabled={pageView.page <= 1}
                                    aria-label="Previous page"
                                    className={PAGE_BTN}
                                >
                                    <ChevronLeft className="h-4 w-4" aria-hidden />
                                </button>
                                {Array.from({ length: pages }, (_, i) => i + 1).map(n => (
                                    <button
                                        key={n}
                                        type="button"
                                        onClick={() => setPage(n)}
                                        aria-current={n === pageView.page ? "page" : undefined}
                                        aria-label={`Page ${n}`}
                                        className={`${PAGE_BTN} font-data text-xs ${
                                            n === pageView.page
                                                ? "border-[color:var(--ciq-accent-purple)] bg-[color:var(--ciq-hover)] text-[color:var(--ciq-text-strong)]"
                                                : ""
                                        }`}
                                    >
                                        {n}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setPage(pageView.page + 1)}
                                    disabled={pageView.page >= pages}
                                    aria-label="Next page"
                                    className={PAGE_BTN}
                                >
                                    <ChevronRight className="h-4 w-4" aria-hidden />
                                </button>
                            </div>
                        </nav>
                    )}
                </section>

                <aside aria-labelledby="dv-detail-h" className={`${CARD} relative min-h-[560px] min-w-0 flex-[1_1_400px] overflow-hidden`}>
                    {/* Inner scroll area: the card takes the table's height, extra content scrolls. */}
                    <div
                        tabIndex={0}
                        aria-label="Run details"
                        className="absolute inset-0 flex flex-col gap-4 overflow-y-auto p-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--ciq-accent-purple)]"
                    >
                        {!selected ? (
                            <p id="dv-detail-h" className="py-6 text-center text-sm text-[color:var(--ciq-text-muted)]">
                                Select a run to see its details.
                            </p>
                        ) : (
                            <RunDetails
                                run={selected}
                                menuOpen={menuOpen}
                                onToggleMenu={() => setMenuOpen(o => !o)}
                                menuRef={menuRef}
                                busyKey={busyKey}
                                downloadError={downloadError}
                                downloadNotice={downloadNotice}
                                onDownload={download}
                            />
                        )}
                    </div>
                </aside>
            </div>
        </div>
    );
}

type RunDetailsProps = {
    run: DataValidationRun;
    menuOpen: boolean;
    onToggleMenu: () => void;
    menuRef: React.RefObject<HTMLDivElement>;
    busyKey: string | null;
    downloadError: string | null;
    downloadNotice: string | null;
    onDownload: (key: string, url: string, fallbackName: string) => Promise<void>;
};

function RunDetails({ run, menuOpen, onToggleMenu, menuRef, busyKey, downloadError, downloadNotice, onDownload }: RunDetailsProps) {
    const report = REPORT_CHIP[run.report];
    const { primary, cbi, scored, riskDeviation } = run.scores;
    const id = run.surveyRunId;
    const sid = id.slice(0, 8);
    const has = (kind: string) => run.files.some(f => f.kind === kind);
    const segs = run.eegSegments;
    const multi = segs.length > 1;
    const busy = busyKey !== null;
    const icon = (key: string) => (busyKey === key ? <Loader2 className="h-4 w-4 animate-spin" /> : null);

    return (
        <>
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="font-data text-[11px] tracking-wider text-[color:var(--ciq-text-muted)]">SURVEY_RUN_ID</span>
                    <h2 id="dv-detail-h" className="font-data break-all text-base text-[color:var(--ciq-text-strong)]">
                        {id}
                    </h2>
                </div>
                <StatusBadge run={run} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div className="col-span-2">
                    <dt className="mb-1 text-xs text-[color:var(--ciq-text-muted)]">User ID</dt>
                    <dd className="font-data break-all text-[color:var(--ciq-text-strong)]">{run.userId ?? "—"}</dd>
                </div>
                <div>
                    <dt className="mb-1 text-xs text-[color:var(--ciq-text-muted)]">Survey type</dt>
                    <dd className="font-data text-[color:var(--ciq-text-strong)]">{run.surveyType ?? "—"}</dd>
                </div>
                <div>
                    <dt className="mb-1 text-xs text-[color:var(--ciq-text-muted)]">Completed</dt>
                    <dd className="font-data text-[color:var(--ciq-text-strong)]">{formatServerDate(run.completedAt)}</dd>
                </div>
                <div className="col-span-2">
                    <dt className="mb-1.5 text-xs text-[color:var(--ciq-text-muted)]">Report</dt>
                    <dd className="flex flex-col gap-1.5">
                        <span className="flex flex-wrap items-center gap-2">
                            <span className={`${CHIP} ${PILL[report.tone]}`}>{report.label}</span>
                            <span className="text-xs text-[color:var(--ciq-text-muted)]">{report.note}</span>
                        </span>
                        {run.report === "saved" && (
                            <span className="text-xs text-[color:var(--ciq-text-muted)]">
                                {run.aiSummaryGenerated ? "AI summary generated." : "AI summary not generated yet (generated when the user opens the report)."}
                            </span>
                        )}
                    </dd>
                </div>
            </dl>

            {/* ── Scores ── */}
            <section aria-labelledby="dv-scores-h" className="flex flex-col gap-3 border-t border-[color:var(--ciq-line)] pt-4">
                <h3 id="dv-scores-h" className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">
                    Scores
                </h3>
                {!scored ? (
                    <p className="text-sm text-[color:var(--ciq-text-muted)]">Not scored — the run ended before the report.</p>
                ) : (
                    <div className="grid grid-cols-2 gap-2.5">
                        <ScoreTile label={primary.label} level={primary.riskLevel} score={primary.score} max={primary.max} />
                        {cbi ? (
                            <ScoreTile label={cbi.label} level={cbi.riskLevel} score={cbi.score} max={cbi.max} />
                        ) : (
                            <div className="flex flex-col gap-2 rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-3">
                                <span className="text-xs font-bold text-[color:var(--ciq-text-muted)]">CBI-WRB3</span>
                                <span className="text-xs text-[color:var(--ciq-text-muted)]">Not part of this survey type.</span>
                            </div>
                        )}
                    </div>
                )}
                {riskDeviation && cbi && (
                    <div role="alert" className={`flex items-start gap-2.5 rounded-lg p-3 ${BANNER.amber}`}>
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                        <div className="flex flex-col gap-0.5">
                            <span className="text-sm font-bold">Risk levels disagree</span>
                            <span className="text-xs text-[color:var(--ciq-text-body)]">
                                {primary.label} is {primary.riskLevel} but {cbi.label} is {cbi.riskLevel}. Check the item responses before using this run.
                            </span>
                        </div>
                    </div>
                )}
            </section>

            {/* ── Export ── */}
            <section aria-label="Export" className="flex flex-col gap-2.5 border-t border-[color:var(--ciq-line)] pt-4" ref={menuRef}>
                <button
                    type="button"
                    onClick={onToggleMenu}
                    disabled={run.fileCount === 0}
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    className="flex min-h-[46px] items-center justify-between gap-2 rounded-lg bg-[color:var(--ciq-accent-purple)] px-4 text-sm font-bold text-[color:var(--ciq-page-from)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    <span className="inline-flex items-center gap-2">
                        <Download className="h-4 w-4" aria-hidden />
                        Export this run
                    </span>
                    {menuOpen ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                </button>
                {run.fileCount === 0 && <span className="text-xs text-[color:var(--ciq-accent-red)]">No export files exist for this run.</span>}
                {downloadError && <p className="text-xs text-[color:var(--ciq-accent-red)]">{downloadError}</p>}
                {downloadNotice && <p className="text-xs text-[color:var(--ciq-accent-amber)]">{downloadNotice}</p>}

                {menuOpen && run.fileCount > 0 && (
                    <div
                        role="menu"
                        aria-label="Export options"
                        className="flex flex-col gap-0.5 rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-1.5 shadow-lg"
                    >
                        <button
                            type="button"
                            role="menuitem"
                            className={MENU_ITEM}
                            disabled={!has("timeline") || busy}
                            onClick={() => void onDownload("timeline", exportUrl(id, "timeline"), `survey_timeline_${sid}.csv`)}
                        >
                            <FormatTag>CSV</FormatTag>
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="font-bold">Survey timeline</span>
                                <span className="text-xs text-[color:var(--ciq-text-muted)]">Per-second biometrics and turn state</span>
                            </span>
                            {icon("timeline")}
                        </button>

                        {/* EEG group */}
                        <div className="my-1 rounded-lg border border-[color:var(--ciq-line)] p-1.5">
                            <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
                                <span className="inline-flex items-center gap-2 text-sm font-bold text-[color:var(--ciq-text-strong)]">
                                    <Activity className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" aria-hidden />
                                    Muse EEG
                                </span>
                                <span className="font-data text-[11px] text-[color:var(--ciq-text-muted)]">
                                    {segs.length === 0 ? "none" : multi ? `${segs.length} segments` : "1 session"}
                                </span>
                            </div>
                            {segs.length === 0 ? (
                                <p className="px-2 pb-1.5 text-xs text-[color:var(--ciq-text-muted)]">
                                    No EEG session was recorded for this run, so the EEG and combined files are not available.
                                </p>
                            ) : (
                                <>
                                    {multi && (
                                        <p className="px-2 pb-2 text-xs leading-relaxed text-[color:var(--ciq-text-muted)]">
                                            This run was paused and continued, so EEG was recorded in {segs.length} segments. Each segment has its own clock.
                                        </p>
                                    )}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className={MENU_ITEM}
                                        disabled={busy}
                                        onClick={() => void onDownload("eeg-all", exportUrl(id, "eeg"), `eeg_session_${sid}.json`)}
                                    >
                                        <FormatTag>JSON</FormatTag>
                                        <span className="flex-1 font-bold">{multi ? "All segments (raw)" : "EEG session (raw)"}</span>
                                        {icon("eeg-all")}
                                    </button>
                                    {multi && (
                                        <div className="ml-6 flex flex-col border-l border-[color:var(--ciq-line)] pl-1">
                                            {segs.map(s => (
                                                <button
                                                    key={s.index}
                                                    type="button"
                                                    role="menuitem"
                                                    className={MENU_ITEM}
                                                    disabled={busy}
                                                    onClick={() =>
                                                        void onDownload(
                                                            `eeg-${s.index}`,
                                                            exportUrl(id, "eeg", s.index),
                                                            `eeg_session_${sid}_segment${s.index}.json`
                                                        )
                                                    }
                                                >
                                                    <FormatTag>JSON</FormatTag>
                                                    <span className="flex-1">Segment {s.index}</span>
                                                    <span className="font-data text-[11px] text-[color:var(--ciq-text-muted)]">
                                                        {segmentSpan(s.start, s.end)}
                                                    </span>
                                                    {icon(`eeg-${s.index}`)}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className={MENU_ITEM}
                                        disabled={!has("combined") || busy}
                                        onClick={() => void onDownload("combined", exportUrl(id, "combined"), `survey_timeline_combined_${sid}.csv`)}
                                    >
                                        <FormatTag>CSV</FormatTag>
                                        <span className="flex min-w-0 flex-1 flex-col">
                                            <span className="font-bold">Combined timeline + EEG</span>
                                            <span className="text-xs text-[color:var(--ciq-text-muted)]">Per-second EEG joined on timeline timestamps</span>
                                        </span>
                                        {icon("combined")}
                                    </button>
                                </>
                            )}
                        </div>

                        <div className="mx-1.5 my-1 h-px bg-[color:var(--ciq-line)]" />

                        <button
                            type="button"
                            role="menuitem"
                            className={`${MENU_ITEM} bg-[color:var(--ciq-hover)]`}
                            disabled={busy}
                            onClick={() => void onDownload("zip", exportUrl(id, "zip"), zipFilename(id, run.userId))}
                        >
                            <FormatTag strong>ZIP</FormatTag>
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="font-bold">All files</span>
                                <span className="text-xs text-[color:var(--ciq-text-muted)]">
                                    {run.fileCount} {run.fileCount === 1 ? "file" : "files"} in one archive
                                </span>
                            </span>
                            {icon("zip")}
                        </button>
                        <div
                            aria-label="Archive contents"
                            className="font-data mx-2 mb-2 mt-0.5 rounded-md bg-[color:var(--ciq-card)] px-3 py-2.5 text-xs leading-7 text-[color:var(--ciq-text-body)]"
                        >
                            <div className="text-[color:var(--ciq-text-strong)]">{zipFilename(id, run.userId)}</div>
                            {zipTree(run.files).map(line => (
                                <div key={line} className={`whitespace-pre ${line.endsWith("eeg/") ? "text-[color:var(--ciq-accent-purple)]" : ""}`}>
                                    {line}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </section>
        </>
    );
}

// Score first ("3 / 5"; just the number for a raw total), then the risk level chip.
function ScoreTile({ label, level, score, max }: { label: string; level: string | null; score: number | null; max: number | null }) {
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-3">
            <span className="text-xs font-bold text-[color:var(--ciq-text-muted)]">{label}</span>
            {score !== null && (
                <span className="font-data text-lg text-[color:var(--ciq-text-strong)]">
                    {score}
                    {max !== null && <span className="text-sm text-[color:var(--ciq-text-muted)]"> / {max}</span>}
                </span>
            )}
            {level ? (
                <span className={`${CHIP} self-start ${PILL[levelTone(level)]}`}>{level}</span>
            ) : (
                <span className="text-xs text-[color:var(--ciq-text-muted)]">No risk level saved</span>
            )}
        </div>
    );
}
