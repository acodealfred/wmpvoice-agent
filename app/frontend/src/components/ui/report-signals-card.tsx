import { Activity } from "lucide-react";

import { sinceLabel } from "@/lib/report-comparison";
import { answerLine, describeSignal, statusLine } from "@/lib/report-signals";
import { formatServerDate } from "@/lib/datetime";
import type { SignalComparison, SignalQuestion } from "@/types";

/**
 * "Your signals, compared with your past check-ins": every PILOT question in survey
 * order, with the answer then → now. (The overview sits in its own card above this one —
 * report-signals-overview-card.tsx.) A question whose own signals moved notably vs
 * the person's previous check-ins lists one plain sentence per signal; the rest say
 * "No notable change…" or "Not enough readings…". Shown under "Compared with your
 * last assessment" (and so in the stored QR PDF). Words only — no numbers, no
 * colours: it states what was recorded, never what it means.
 *
 * PDF page breaks (lib/report-pdf.ts) never cut a `ciq-print-keep` block: each
 * question is one, and the title travels with the first question and the footer
 * with the last, so neither is left alone at a page edge.
 */
export function ReportSignalsCard({ comparison, className = "" }: { comparison: SignalComparison | null; className?: string }) {
    if (!comparison || comparison.questions.length === 0) return null;
    const since = sinceLabel(comparison.daysSinceLatest);
    const [first, ...rest] = comparison.questions;
    const last = rest.length > 0 ? rest[rest.length - 1] : null;
    const middle = rest.slice(0, -1);

    const block = (q: SignalQuestion) => {
        const answer = answerLine(q);
        const status = statusLine(q, comparison.referenceCount);
        return (
            <section
                key={q.questionId}
                aria-label={q.prompt}
                className={`ciq-print-keep rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] px-3 ${status ? "py-1.5" : "py-2"}`}
            >
                <p className="font-semibold text-[color:var(--ciq-text-strong)]">&ldquo;{q.prompt}&rdquo;</p>
                {answer && <p className="text-sm text-[color:var(--ciq-text-muted)]">{answer}</p>}
                {status ? (
                    <p className="text-sm text-[color:var(--ciq-text-faint)]">{status}</p>
                ) : (
                    <ul className="mt-1 flex flex-col gap-0.5 text-sm text-[color:var(--ciq-text-body)]">
                        {q.signals.map(s => (
                            <li key={s.id}>{describeSignal(s, comparison.referenceCount)}</li>
                        ))}
                    </ul>
                )}
            </section>
        );
    };
    const footer = <p className="mt-2 text-xs text-[color:var(--ciq-text-faint)]">These are things we noticed, not conclusions.</p>;

    return (
        <div className={className}>
            <div className="ciq-print-keep">
                <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                    <Activity className="h-5 w-5" aria-hidden="true" /> Your signals, compared with your past check-ins
                </h3>
                <p className="mb-3 text-xs text-[color:var(--ciq-text-faint)]">
                    {comparison.referenceCount > 1
                        ? `Your last ${comparison.referenceCount} check-ins`
                        : comparison.latestReferenceDate && `Last check-in: ${formatServerDate(comparison.latestReferenceDate)}${since ? ` (${since})` : ""}`}
                </p>
                {block(first)}
                {!last && footer}
            </div>
            {middle.map(q => (
                <div key={q.questionId} className="mt-2">
                    {block(q)}
                </div>
            ))}
            {last && (
                <div className="ciq-print-keep mt-2">
                    {block(last)}
                    {footer}
                </div>
            )}
        </div>
    );
}
