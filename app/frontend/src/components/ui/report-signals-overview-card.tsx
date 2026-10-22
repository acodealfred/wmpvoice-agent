import { ListChecks } from "lucide-react";

import { overviewHeadline, overviewRows } from "@/lib/report-signals";
import type { SignalComparison } from "@/types";

/**
 * "Your check-in at a glance": one headline (how many answers changed, on how many
 * questions the person's own signals showed a notable change) and a three-column table —
 * question, answer then → now, signals in brief — one row per question. Sits above the
 * per-question card (report-signals-card.tsx), which explains each row in detail. Words
 * only: no numbers, no colours, no meaning.
 *
 * A plain table at every width (no responsive breakpoints): the stored PDF is captured at
 * a fixed width but with the device's media queries, so a breakpoint layout could differ
 * between the screen and the PDF. Each row is a <tr>, which the PDF page breaks never cut.
 */
export function ReportSignalsOverviewCard({ comparison, className = "" }: { comparison: SignalComparison | null; className?: string }) {
    if (!comparison || comparison.questions.length === 0) return null;
    const rows = overviewRows(comparison);
    const reference = comparison.referenceCount > 1 ? "your recent check-ins" : "your last check-in";
    const cell = "border-b border-[color:var(--ciq-line)] px-2 py-1.5 align-top";

    return (
        <div className={className}>
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                <ListChecks className="h-5 w-5" aria-hidden="true" /> Your check-in at a glance
            </h3>
            <p className="mb-2 text-xs text-[color:var(--ciq-text-faint)]">Compared with {reference}</p>
            <p className="mb-3 text-sm text-[color:var(--ciq-text-strong)]">{overviewHeadline(comparison)}</p>
            <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                    <col className="w-[32%]" />
                    <col className="w-[28%]" />
                    <col className="w-[40%]" />
                </colgroup>
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                        <th className={`${cell} font-semibold`}>Question</th>
                        <th className={`${cell} font-semibold`}>Your answer</th>
                        <th className={`${cell} font-semibold`}>Your signals</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(r => (
                        <tr key={r.questionId}>
                            <td className={`${cell} font-semibold text-[color:var(--ciq-text-strong)]`}>{r.label}</td>
                            <td className={`${cell} text-[color:var(--ciq-text-body)]`}>{r.answer}</td>
                            <td className={`${cell} text-[color:var(--ciq-text-body)]`}>{r.signals}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="mt-2 text-xs text-[color:var(--ciq-text-faint)]">Each question is explained in more detail below.</p>
        </div>
    );
}
