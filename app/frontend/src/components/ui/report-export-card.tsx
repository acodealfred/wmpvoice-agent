import { useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { BANNER } from "@/lib/badges";
import { REPORT_PERIODS, reportExportUrl, type ReportPeriod } from "@/lib/report-export";
import { downloadBlob, filenameFromResponse } from "@/ui/download";

/**
 * Admin panel card: every completed report in a period as ONE ZIP of participant PDFs
 * (`<user_name>_<survey_run_id>.pdf`) — same results as the History tab, without
 * internal fields, so each PDF can be sent to its participant.
 */
export function ReportExportCard() {
    const [period, setPeriod] = useState<ReportPeriod>("today");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "red" | "amber"; text: string } | null>(null);

    const onDownload = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const resp = await apiFetch(reportExportUrl(period), { credentials: "same-origin" });
            if (resp.status === 404) {
                setMessage({ tone: "amber", text: "No completed reports in this period." });
                return;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            downloadBlob(await resp.blob(), filenameFromResponse(resp, "ciq_reports.zip"));
        } catch (err) {
            setMessage({ tone: "red", text: err instanceof Error ? `Download failed (${err.message})` : "Download failed" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5 shadow-md">
            <div className="mb-2 flex items-center gap-2">
                <FileText className="h-5 w-5 text-[color:var(--ciq-accent-purple)]" />
                <h2 className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">Participant Reports</h2>
            </div>
            <p className="mb-2 text-sm text-[color:var(--ciq-text-muted)]">
                Download every completed report in the selected period as one ZIP of PDFs, named by participant and survey run. Each PDF has the
                participant&apos;s scores, risk levels, interpretations and written summary — the same results as their History tab.
            </p>
            <p className="mb-4 text-xs font-semibold text-[color:var(--ciq-accent-amber)]">
                Check the name before sending — each participant must only receive their own report.
            </p>
            <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs font-bold text-[color:var(--ciq-text-muted)]">
                    Completed
                    <select
                        value={period}
                        onChange={e => setPeriod(e.target.value as ReportPeriod)}
                        disabled={busy}
                        className="h-10 rounded-md border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] px-3 text-sm font-normal text-[color:var(--ciq-text-strong)] focus:border-[color:var(--ciq-accent-purple)] focus:outline-none"
                    >
                        {REPORT_PERIODS.map(p => (
                            <option key={p.value} value={p.value}>
                                {p.label}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    onClick={() => void onDownload()}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[color:var(--ciq-accent-purple)] to-[color:var(--ciq-accent-blue)] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {busy ? "Preparing reports…" : "Download reports (PDF)"}
                </button>
            </div>
            {message && (
                <p role="status" className={`mt-3 rounded-lg px-3 py-2 text-sm ${BANNER[message.tone]}`}>
                    {message.text}
                </p>
            )}
        </div>
    );
}
