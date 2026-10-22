// Reverse-aware per-question and per-domain scores for the report's domain chart and
// question table. The browser doesn't know which questions are reverse-scored (e.g. PILOT
// cbi_q3 "enough energy for family and friends", where a HIGH answer means LESS burnout);
// the backend does, and sends `domainTotals` — the reverse-aware score sum per domain
// (survey_loader._domain_totals). Everything here is derived from that, never from a
// hard-coded list of reversed questions.

type ScoredSnapshot = { questionId: string; domain: string; score?: number };

/**
 * Each question's burnout-direction (reverse-aware) score, or null where it can't be told
 * apart from the others in its domain. A domain with ONE question (every PILOT domain)
 * gives that question's score directly. A domain whose total equals the raw sum has no
 * reversed question, so its raw scores stand. Anything else stays null (raw is shown).
 */
export function effectiveScores(snapshots: ScoredSnapshot[], domainTotals: Record<string, number> | undefined): Record<string, number | null> {
    const byDomain = new Map<string, ScoredSnapshot[]>();
    for (const s of snapshots) byDomain.set(s.domain, [...(byDomain.get(s.domain) ?? []), s]);

    const out: Record<string, number | null> = {};
    for (const [domain, items] of byDomain) {
        const total = domainTotals?.[domain];
        const rawSum = items.reduce((sum, s) => sum + (s.score ?? 0), 0);
        for (const s of items) {
            if (typeof total !== "number" || s.score == null) out[s.questionId] = null;
            else if (items.length === 1) out[s.questionId] = total;
            else out[s.questionId] = total === rawSum ? s.score : null;
        }
    }
    return out;
}

/**
 * The domain chart's points: each domain's score as a % of its questions' maximum, using
 * the reverse-aware `domainTotals` when the backend sent them (raw answers otherwise, e.g.
 * while the live report is still being calculated).
 */
export function domainChartData(
    snapshots: ScoredSnapshot[],
    domainTotals: Record<string, number> | undefined,
    maxForQuestion: (questionId: string) => number
): { domain: string; score: number; n: number }[] {
    const byDomain = new Map<string, { raw: number; max: number; n: number }>();
    for (const s of snapshots) {
        const d = byDomain.get(s.domain) ?? { raw: 0, max: 0, n: 0 };
        d.raw += s.score ?? 0;
        d.max += maxForQuestion(s.questionId);
        d.n += 1;
        byDomain.set(s.domain, d);
    }
    return Array.from(byDomain, ([domain, d]) => {
        const total = typeof domainTotals?.[domain] === "number" ? domainTotals[domain] : d.raw;
        return { domain, score: d.max > 0 ? Number(((total / d.max) * 100).toFixed(2)) : 0, n: d.n };
    });
}
