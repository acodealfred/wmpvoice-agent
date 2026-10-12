// A saved assessment report reopened read-only, full screen, with its "Download PDF"
// button — from the History tab (scope "me") or Admin Data Validation (scope "admin").
import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { savedReportUrl, type SavedReport, type SavedReportScope } from "@/lib/saved-report";
import { ErrorBoundary } from "@/components/ui/error-boundary";

const DetailedReport = lazy(() => import("@/components/ui/detailed-report").then(m => ({ default: m.DetailedReport })));

export function SavedReportDialog({ scope, surveyRunId, onClose }: { scope: SavedReportScope; surveyRunId: string; onClose: () => void }) {
    const [data, setData] = useState<SavedReport | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setData(null);
        setError(null);
        (async () => {
            try {
                const resp = await apiFetch(savedReportUrl(scope, surveyRunId));
                if (cancelled) return;
                if (!resp.ok) {
                    setError(resp.status === 404 ? "This report isn't available." : `Couldn't load the report (HTTP ${resp.status}).`);
                    return;
                }
                const body = (await resp.json()) as SavedReport;
                if (!cancelled) setData(body);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load the report.");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [scope, surveyRunId]);

    // Escape closes, like the app's other overlays.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const loading = (
        <div className="flex items-center justify-center gap-2 rounded-2xl bg-[color:var(--ciq-card)] py-16 text-sm text-[color:var(--ciq-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
        </div>
    );

    // Portalled to <body> so no transformed/clipped ancestor (admin panel, history list) can trap it.
    return createPortal(
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Saved report" onClick={onClose}>
            <div className="mx-auto w-full max-w-5xl" onClick={e => e.stopPropagation()}>
                {error ? (
                    <div className="flex items-start gap-2 rounded-2xl bg-[color:var(--ciq-card)] p-6 text-sm text-[color:var(--ciq-text-body)]">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ciq-accent-red)]" />
                        <span className="flex-1">{error}</span>
                        <button onClick={onClose} className="rounded-full px-2 text-[color:var(--ciq-text-muted)]" aria-label="Close report">
                            ✕
                        </button>
                    </div>
                ) : !data ? (
                    loading
                ) : (
                    <ErrorBoundary label="saved-report">
                        <Suspense fallback={loading}>
                            <DetailedReport
                                snapshots={data.snapshots}
                                surveyRunId={data.surveyRunId}
                                surveyType={data.surveyType}
                                saved={{ report: data.report, createdAt: data.createdAt, showZone: scope === "me" }}
                            />
                        </Suspense>
                    </ErrorBoundary>
                )}
            </div>
        </div>,
        document.body
    );
}
