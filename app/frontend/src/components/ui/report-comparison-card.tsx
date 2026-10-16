import { History } from "lucide-react";

import { describeChange, riskChange, sinceLabel, type ChangeView } from "@/lib/report-comparison";
import { formatServerDate } from "@/lib/datetime";
import type { ReportComparison } from "@/types";

const TONE: Record<ChangeView["tone"], string> = {
    good: "var(--ciq-accent-green)",
    neutral: "var(--ciq-text-muted)",
    bad: "var(--ciq-accent-amber)"
};

/**
 * "Compared with your last assessment": each measure's score vs the user's previous
 * assessment of the same type. Shown under the Fatigue ↔ Burnout zone (and so in the
 * stored QR PDF). Survey scores only — never biometrics.
 */
export function ReportComparisonCard({ comparison, className = "" }: { comparison: ReportComparison; className?: string }) {
    const since = sinceLabel(comparison.daysBetween);
    return (
        <div className={className}>
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                <History className="h-5 w-5" /> Compared with your last assessment
            </div>
            {comparison.previousDate && (
                <p className="mb-3 text-xs text-[color:var(--ciq-text-faint)]">
                    Last assessment: {formatServerDate(comparison.previousDate)}
                    {since && ` (${since})`}
                </p>
            )}
            <ul className="flex flex-col gap-2">
                {comparison.measures.map(m => {
                    const change = describeChange(m);
                    const risk = riskChange(m);
                    return (
                        <li
                            key={m.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] px-3 py-2"
                        >
                            <span className="font-semibold text-[color:var(--ciq-text-strong)]">{m.label}</span>
                            <span className="flex flex-wrap items-center gap-3 text-sm">
                                <span className="font-data text-[color:var(--ciq-text-body)]">{change.detail}</span>
                                <span className="font-semibold" style={{ color: TONE[change.tone] }}>
                                    {change.arrow} {change.label}
                                </span>
                                {risk && <span className="text-[color:var(--ciq-text-muted)]">Risk {risk}</span>}
                            </span>
                        </li>
                    );
                })}
            </ul>
            <p className="mt-2 text-xs text-[color:var(--ciq-text-faint)]">Lower scores mean fewer burnout complaints.</p>
        </div>
    );
}
