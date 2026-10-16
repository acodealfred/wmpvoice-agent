// "Compared with your last assessment" (GET /me/reports/{runId}/comparison —
// ciq/reports/comparison.py): the report's run vs the user's previous run of the same
// survey type. Survey scores only, never biometrics.

import { apiFetch } from "@/lib/api";
import type { ComparisonMeasure, ReportComparison } from "@/types";

/** The comparison, or null (first assessment / nothing comparable). Throws on a failed request. */
export async function fetchReportComparison(surveyRunId: string): Promise<ReportComparison | null> {
    const res = await apiFetch(`/me/reports/${encodeURIComponent(surveyRunId)}/comparison`);
    if (!res.ok) throw new Error(`comparison failed (${res.status})`);
    return ((await res.json()) as { comparison: ReportComparison | null }).comparison;
}

export type ChangeView = { arrow: "▼" | "▲" | "="; label: string; tone: "good" | "neutral" | "bad"; detail: string };

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** How one measure's change is shown: lower is better for every burnout measure. */
export function describeChange(m: ComparisonMeasure): ChangeView {
    const detail = `${fmt(m.previousScore)} → ${fmt(m.currentScore)}`;
    if (m.direction === "improved") return { arrow: "▼", label: "Improved", tone: "good", detail };
    if (m.direction === "worse") return { arrow: "▲", label: "Gone up", tone: "bad", detail };
    return { arrow: "=", label: "About the same", tone: "neutral", detail };
}

/** "Moderate → Low", or null when the risk level didn't change. */
export function riskChange(m: ComparisonMeasure): string | null {
    if (!m.previousRisk || !m.currentRisk || m.previousRisk === m.currentRisk) return null;
    return `${m.previousRisk} → ${m.currentRisk}`;
}

/** "14 days ago" / "yesterday" / "earlier today" — for the card's header. */
export function sinceLabel(days: number | null): string {
    if (days === null) return "";
    if (days <= 0) return "earlier today";
    if (days === 1) return "yesterday";
    return `${days} days ago`;
}
