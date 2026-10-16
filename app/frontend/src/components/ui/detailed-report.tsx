import { useState, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BiometricSnapshot, AnalyzeReportResponse, AnalysisResult, AnalysisInsight, ZoneTrendResponse, ReportComparison } from "@/types";
import { apiFetch } from "@/lib/api";
import { fetchZoneTrend } from "@/lib/zone";
import { blinkBandLevel } from "@/lib/bands";
import { answerLevel, describeDomain, describeGauge } from "@/lib/report-descriptions";
import { printReport } from "@/lib/print-report";
import { reportFileTitle, type SavedReport } from "@/lib/saved-report";
import { formatServerDate, parseServerDate } from "@/lib/datetime";
import { Loader2, AlertCircle, Sparkles, Eye, Timer, Gauge, Download } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { ReadinessReportView } from "@/components/ui/readiness-report-view";
import { ZoneScale } from "@/components/ui/zone-scale";
import { ReportQrDialog } from "@/components/ui/report-qr-dialog";
import { ReportPdfCapture } from "@/components/ui/report-pdf-capture";
import { ReportComparisonCard } from "@/components/ui/report-comparison-card";
import { fetchReportComparison } from "@/lib/report-comparison";
import {
    ResponsiveContainer,
    RadialBarChart,
    RadialBar,
    PolarAngleAxis,
    RadarChart,
    Radar,
    PolarGrid,
    PolarRadiusAxis,
    BarChart,
    Bar,
    Cell,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip
} from "recharts";

interface DetailedReportProps {
    snapshots: BiometricSnapshot[];
    sessionId?: string;
    surveyRunId?: string;
    surveyType?: string;
    onAgentSpeaking?: (text: string) => void;
    onReportDelivered?: () => void;
    /**
     * Narrow-container layout (the PILOT report screen panel): the domain radar first at
     * full width, then each subscale gauge + explanation one under another — instead of
     * the side-by-side layout, which clips the radar's labels in a narrow panel.
     */
    compact?: boolean;
    /**
     * A saved report reopened read-only (History tab / Admin Data Validation): shown
     * from the stored figures — nothing is saved again, no AI call is made, and the
     * AI Insights section is left out. `showZone` only when the viewer is the report's
     * owner, since /api/zone-trend is always the logged-in user's own trend. `zone` /
     * `comparison`, when given, are drawn as-is without fetching (the PDF capture copy).
     */
    saved?: {
        report: SavedReport["report"];
        createdAt: string | null;
        showZone: boolean;
        zone?: ZoneTrendResponse | null;
        comparison?: ReportComparison | null;
    };
}

// Radar axis label wrapped onto several short lines, so long domain names
// ("Work-Related Burnout (Item 11)") are never clipped by the chart edge.
function wrapLabel(text: string, maxChars: number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
        if (line && (line + " " + word).length > maxChars) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function RadarTick(props: { x?: number; y?: number; textAnchor?: string; payload?: { value: string }; fill: string; fontSize: number; maxChars: number }) {
    const { x = 0, y = 0, textAnchor = "middle", payload, fill, fontSize, maxChars } = props;
    const lines = wrapLabel(String(payload?.value ?? ""), maxChars);
    // Labels above the centre grow upwards, labels below grow downwards, so they never
    // run into the chart itself.
    const cy = (props as { cy?: number }).cy;
    const above = cy !== undefined ? y < cy - 1 : false;
    const lineHeight = fontSize * 1.15;
    const startDy = above ? -(lines.length - 1) * lineHeight : 0;
    return (
        <text x={x} y={y} textAnchor={textAnchor as "start" | "middle" | "end"} fill={fill} fontSize={fontSize} dominantBaseline="central">
            {lines.map((l, i) => (
                <tspan key={i} x={x} dy={i === 0 ? startDy : lineHeight}>
                    {l}
                </tspan>
            ))}
        </text>
    );
}

// ── Theme tokens resolved to concrete colors for Recharts (which needs real
// color strings, not CSS var() references). Re-reads when the theme flips.
// Read from the report's own element, so a scoped override — the light colours
// of the PDF capture copy (data-pdf-light, report-pdf-capture.tsx) — reaches the
// charts too; on the normal screen that inherits the same values as the root. ──
type Tokens = ReturnType<typeof readTokens>;
function readTokens(el?: Element | null) {
    const s = getComputedStyle(el ?? document.documentElement);
    const g = (n: string) => s.getPropertyValue(n).trim() || "#888";
    return {
        green: g("--ciq-accent-green"),
        amber: g("--ciq-accent-amber"),
        red: g("--ciq-accent-red"),
        blue: g("--ciq-accent-blue"),
        purple: g("--ciq-accent-purple"),
        line: g("--ciq-line"),
        muted: g("--ciq-text-muted"),
        strong: g("--ciq-text-strong"),
        card: g("--ciq-card"),
        card2: g("--ciq-card-2")
    };
}
function useThemeTokens(ref: RefObject<HTMLElement>): Tokens {
    const [tok, setTok] = useState<Tokens>(() => readTokens());
    // Before paint, so the first frame already uses the element's own colours.
    useLayoutEffect(() => setTok(readTokens(ref.current)), [ref]);
    useEffect(() => {
        const obs = new MutationObserver(() => setTok(readTokens(ref.current)));
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
        return () => obs.disconnect();
    }, []);
    return tok;
}

type ReportTab = "analysis" | "consultative";

export function DetailedReport({ snapshots, sessionId, surveyRunId, surveyType, onReportDelivered, compact = false, saved }: DetailedReportProps) {
    const reportRef = useRef<HTMLDivElement>(null);
    const tok = useThemeTokens(reportRef);

    const [analyzeData, setAnalyzeData] = useState<AnalyzeReportResponse | null>(() =>
        saved ? { ...saved.report, domainTotals: saved.report.domainTotals ?? {}, analysis: {}, agentResponse: "" } : null
    );
    const [saveError, setSaveError] = useState<string | null>(null);
    // Bumped by the "Retry saving" button to re-run the /analyze-report save below.
    const [saveAttempt, setSaveAttempt] = useState(0);
    // Fatigue ↔ Burnout zone, fetched once the run is saved. Any failure just hides the scale.
    const [zoneData, setZoneData] = useState<ZoneTrendResponse | null>(saved?.zone ?? null);
    // "Compared with your last assessment" (same survey type); null = nothing to compare.
    const [comparison, setComparison] = useState<ReportComparison | null>(saved?.comparison ?? null);
    // Live report: zone + comparison loads have finished (either way), so the PDF copy can be captured.
    const [extrasLoaded, setExtrasLoaded] = useState(false);

    // On-demand AI generations (the two slow LLM calls, now triggered by buttons).
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [analysisLoading, setAnalysisLoading] = useState(false);
    const [analysisError, setAnalysisError] = useState<string | null>(null);
    const [consultText, setConsultText] = useState<string | null>(null);
    const [consultLoading, setConsultLoading] = useState(false);
    const [consultError, setConsultError] = useState<string | null>(null);

    // Which AI report is shown in the shared content area below the tab bar.
    const [activeReportTab, setActiveReportTab] = useState<ReportTab | null>(null);

    const handleGenerateAnalysis = async () => {
        setAnalysisLoading(true);
        setAnalysisError(null);
        try {
            const res = await apiFetch("/report/behavioral-analysis", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ snapshots, session_id: sessionId ?? "", survey_run_id: surveyRunId ?? "", survey_type: surveyType ?? "" })
            });
            const data = await res.json();
            if (!res.ok) {
                setAnalysisError(data.error ?? `Request failed (HTTP ${res.status})`);
                return;
            }
            setAnalysisResult(data.analysis ?? null);
        } catch (err) {
            setAnalysisError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setAnalysisLoading(false);
        }
    };

    const handleGenerateConsultative = async () => {
        setConsultLoading(true);
        setConsultError(null);
        try {
            const res = await apiFetch("/report/consultative-summary", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Pass any already-generated analysis so the summary can reference it.
                body: JSON.stringify({
                    snapshots,
                    session_id: sessionId ?? "",
                    survey_run_id: surveyRunId ?? "",
                    survey_type: surveyType ?? "",
                    analysis: analysisResult ?? undefined
                })
            });
            const data = await res.json();
            if (!res.ok) {
                setConsultError(data.error ?? `Request failed (HTTP ${res.status})`);
                return;
            }
            setConsultText(data.agentResponse ?? "");
        } catch (err) {
            setConsultError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setConsultLoading(false);
        }
    };

    // Open a report tab; the first time it's opened, kick off its generation.
    const openReportTab = (tab: ReportTab) => {
        setActiveReportTab(tab);
        if (tab === "analysis" && !analysisResult && !analysisLoading) handleGenerateAnalysis();
        else if (tab === "consultative" && !consultText && !consultLoading) handleGenerateConsultative();
    };

    // ── Data-driven technical report (POST /analyze-report) ───────────────
    // This call is also what persists the survey to history (backend writes the
    // survey_records row up-front). To make sure no survey is silently lost, we
    // retry a few times on transient failure and surface an error if it never
    // succeeds, so the user can press "Retry saving".
    useEffect(() => {
        // A saved report is already persisted — never POST it again.
        if (saved || snapshots.length === 0) return;
        let cancelled = false;
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        (async () => {
            const MAX_ATTEMPTS = 3;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
                try {
                    const res = await apiFetch("/analyze-report", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ snapshots, session_id: sessionId ?? "", survey_run_id: surveyRunId ?? "", survey_type: surveyType ?? "" })
                    });
                    if (cancelled) return;
                    // 401 is handled globally by apiFetch (redirect to login) — don't retry.
                    if (res.status === 401) return;
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = (await res.json()) as AnalyzeReportResponse;
                    if (cancelled) return;
                    setAnalyzeData(data);
                    setSaveError(null);
                    onReportDelivered?.();
                    // The run is now saved and completed, so the zone + comparison endpoints can see it.
                    if (surveyRunId) {
                        void Promise.allSettled([
                            fetchZoneTrend().then(z => !cancelled && setZoneData(z)),
                            fetchReportComparison(surveyRunId).then(c => !cancelled && setComparison(c))
                        ]).then(() => !cancelled && setExtrasLoaded(true));
                    }
                    return;
                } catch (err) {
                    if (cancelled) return;
                    console.warn(`[AnalyzeReport] attempt ${attempt}/${MAX_ATTEMPTS} failed`, err);
                    if (attempt < MAX_ATTEMPTS) {
                        await sleep(attempt * 1000); // 1s, 2s backoff
                    } else {
                        setSaveError('We couldn\'t save this result automatically. Press "Retry saving" to try again and save it to your history.');
                    }
                }
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshots, sessionId, saveAttempt]);

    // Saved report: the zone scale only for its owner (it shows when this run is their latest).
    useEffect(() => {
        if (!saved?.showZone || !surveyRunId) return;
        let cancelled = false;
        fetchZoneTrend()
            .then(z => !cancelled && setZoneData(z))
            .catch(() => {});
        fetchReportComparison(surveyRunId)
            .then(c => !cancelled && setComparison(c))
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [surveyRunId]);

    // Once the report row is persisted, generate the consultative summary in the
    // background so its text (prompt_info.agentResponse) is saved to history. The
    // agent speaks a summary live, but that audio is never stored — without this
    // the summary is lost on relogin (and the guest Home recommendations vanish).
    // Only runs for an authenticated, persistable run; opening the tab reuses the
    // result instead of regenerating it.
    useEffect(() => {
        if (!saved && analyzeData && surveyRunId && !consultText && !consultLoading && !consultError) {
            handleGenerateConsultative();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [analyzeData, surveyRunId]);

    // READINESS uses the SAME deterministic gauge/domain-chart/table as every other
    // survey type (see analyze_report — its questions carry a Low/Medium/High-mapped
    // 1/3/5 scale). The only thing that's different is the "Behavioral Analysis" tab,
    // which gets a richer narrative (assessment_summary/topic_feedback/etc, see
    // build_readiness_analysis_prompt) instead of correlations/contradictions/patterns
    // — kick that off automatically as soon as the deterministic report has persisted,
    // instead of waiting for a tab click, since it's the main qualitative deliverable.
    const isReadiness = surveyType === "READINESS";
    useEffect(() => {
        if (!saved && isReadiness && analyzeData && !analysisResult && !analysisLoading && !analysisError) {
            // Also open the tab itself — otherwise the generated narrative sits in
            // state with nothing rendering it until the user happens to click
            // "Behavioral Analysis" manually (the content area is gated on
            // activeReportTab === "analysis").
            setActiveReportTab(prev => prev ?? "analysis");
            handleGenerateAnalysis();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReadiness, analyzeData]);

    // The headline score/risk MUST come from the backend (reverse-aware, config
    // thresholds). The local `totalScore` prop is a raw sum and would be wrong for
    // surveys with reverse-scored items, so we show "Calculating…" until /analyze-report
    // returns rather than flashing an incorrect number that then changes.
    // Surveys with independent scoringSections (e.g. PILOT's BAT-4/CBI-WRB3) have no
    // single combined score — `sections` is rendered as its own gauge per subscale below.
    const scoreReady = analyzeData !== null;
    const sections = analyzeData?.sections;
    const displayScore = analyzeData?.totalScore ?? 0;
    const displayMax = analyzeData?.maxScore ?? snapshots.length * 5;
    const riskLevel = analyzeData?.riskLevel ?? "Low";
    const riskText = scoreReady ? (analyzeData?.interpretation ?? `${riskLevel} burnout risk`) : "Calculating your score…";

    // Shared gauge renderer — used for the single combined score, and once per
    // independent subscale when the survey declares `scoringSections`.
    const riskHexFor = (level: "Low" | "Moderate" | "High") => (level === "Low" ? tok.green : level === "Moderate" ? tok.amber : tok.red);
    const renderScoreGauge = (opts: {
        label: string;
        score: number;
        lo: number;
        hi: number;
        riskLevel: "Low" | "Moderate" | "High";
        riskText: string;
        height?: number;
    }) => {
        const { label, score, lo, hi, riskLevel: level, riskText: text, height = 240 } = opts;
        const pct = hi > lo ? Math.round(((score - lo) / (hi - lo)) * 100) : 0;
        const hex = riskHexFor(level);
        // Hover: what this score measures, where it sits on its range, and the risk band.
        const gaugeTip = () =>
            renderChartTip(label === "Overall" ? (isReadiness ? "Overall readiness" : "Overall burnout score") : label, [
                describeGauge(label, isReadiness),
                `Your score: ${score} on a ${lo}–${hi} range (${pct}% of the way up).`,
                <span key="risk" style={{ color: hex, fontWeight: 600 }}>
                    {level} risk — {text}
                </span>
            ]);
        return (
            <div key={label}>
                <div className="relative">
                    <ResponsiveContainer width="100%" height={height}>
                        <RadialBarChart innerRadius="68%" outerRadius="100%" data={[{ value: pct, fill: hex }]} startAngle={180} endAngle={0}>
                            <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                            <RadialBar background={{ fill: tok.card }} dataKey="value" cornerRadius={14} angleAxisId={0} />
                            <Tooltip content={gaugeTip} cursor={false} />
                        </RadialBarChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end pb-7">
                        <div className="text-3xl font-extrabold text-[color:var(--ciq-text-strong)]">
                            {score}
                            <span className="text-lg font-semibold text-[color:var(--ciq-text-muted)]">/{hi}</span>
                        </div>
                        <div className="mt-1.5 rounded-full px-3 py-1 text-sm font-bold" style={{ color: hex, background: `${hex}22` }}>
                            {level} risk
                        </div>
                    </div>
                </div>
                <p className="mt-2 text-center text-sm font-semibold text-[color:var(--ciq-text-body)]">{label}</p>
                <p className="text-center text-xs text-[color:var(--ciq-text-muted)]">{text}</p>
            </div>
        );
    };

    // Different question sets use different raw-answer scales (BAT-4 items are 1-5,
    // CBI-WRB3 items are 0-100 — see cbi_/bat_ id prefix convention also used
    // backend-side in reports/routes.py's _BAT4_QUESTION_IDS/_CBI3_QUESTION_IDS), so
    // color bands / chart axes must work off each question's own max, not a fixed 5.
    const maxForQuestion = (questionId: string) => (questionId.startsWith("cbi_") ? 100 : 5);

    // READINESS questions use a Low/Medium/High-mapped 1/3/5 scale (see
    // readiness-survey.json) — the data table shows that label instead of a bare
    // number, per the qualitative, no-exact-score conversation this survey runs.
    const READINESS_SCORE_LABELS: Record<number, string> = { 1: "Low", 3: "Medium", 5: "High" };
    const scoreDisplay = (questionId: string, score?: number) => {
        if (questionId.startsWith("readiness_")) {
            return score != null ? (READINESS_SCORE_LABELS[score] ?? String(score)) : "—";
        }
        return `${score ?? "—"}/${maxForQuestion(questionId)}`;
    };

    // Per-question score → color band (higher % of that question's own max = worse).
    const scoreHex = (pct: number) => (pct <= 20 ? tok.green : pct <= 60 ? tok.amber : tok.red);

    // Average score per domain (normalized to % of each question's own max) for the
    // radar / domain bars, so BAT-4 and CBI-WRB3 domains share one comparable axis.
    const domainMap = new Map<string, { sum: number; n: number }>();
    snapshots.forEach(s => {
        const d = domainMap.get(s.domain) ?? { sum: 0, n: 0 };
        d.sum += ((s.score ?? 0) / maxForQuestion(s.questionId)) * 100;
        d.n += 1;
        domainMap.set(s.domain, d);
    });
    const domainData = Array.from(domainMap.entries()).map(([domain, v]) => ({
        domain,
        score: Number((v.sum / v.n).toFixed(2)),
        n: v.n
    }));
    const useRadar = domainData.length >= 3;

    // KPI tiles.
    // Only real readings count — a missing one is "not enough data", not 0%.
    const blinkReadings = snapshots.map(s => s.blinkRateChange).filter((x): x is number => x != null);
    const peakBlink = blinkReadings.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
    const latencies = snapshots.map(s => s.responseLatencyMs).filter((x): x is number => x != null);
    const avgLatency = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000).toFixed(1) : null;

    const confidenceColor = (c: string) =>
        c === "high"
            ? "bg-petroleum-vapour/15 text-petroleum-vapour"
            : c === "medium"
              ? "bg-petroleum-sodium/15 text-petroleum-sodium"
              : "bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-body)]";

    const blinkBand = (changePct: number | null): { label: string; color: string } => {
        const level = blinkBandLevel(changePct);
        // No reading: say so — previously this fell through to "High".
        if (changePct == null || level === "Unknown")
            return { label: "Not enough data", color: "bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-muted)]" };
        if (level === "Normal") return { label: "Normal", color: "bg-petroleum-vapour/15 text-petroleum-vapour" };
        const arrow = changePct > 0 ? "↑" : "↓";
        return level === "Elevated"
            ? { label: `Elevated ${arrow}`, color: "bg-petroleum-sodium/15 text-petroleum-sodium" }
            : { label: `High ${arrow}`, color: "bg-petroleum-flare/15 text-petroleum-flare" };
    };

    const tooltipStyle = {
        background: tok.card,
        border: `1px solid ${tok.line}`,
        borderRadius: 12,
        color: tok.strong,
        fontSize: 12,
        boxShadow: "0 8px 30px rgba(0,0,0,0.18)"
    } as const;

    // Hover card shared by the report's charts: a title plus a few short lines.
    const renderChartTip = (title: string, lines: ReactNode[]) => (
        <div style={{ ...tooltipStyle, padding: "10px 12px", maxWidth: 300 }}>
            <p style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{title}</p>
            {lines.map((line, i) => (
                <p key={i} style={{ color: i === 0 ? tok.strong : tok.muted, lineHeight: 1.45, marginTop: i === 0 ? 0 : 4 }}>
                    {line}
                </p>
            ))}
        </div>
    );

    // Domain Profile hover (radar and bar variants): what the domain measures + how
    // this person's average answer compares with the scale's maximum.
    const domainTip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload?: (typeof domainData)[number] }> }) => {
        const d = active ? payload?.[0]?.payload : undefined;
        if (!d) return null;
        const level = answerLevel(d.score);
        const questions = `${d.n} ${d.n === 1 ? "question" : "questions"}`;
        return renderChartTip(d.domain, [
            describeDomain(d.domain) ?? "Average of your answers in this area.",
            `Average answer: ${Math.round(d.score)}% of the scale's maximum (${questions}).`,
            <span key="level" style={{ color: scoreHex(d.score), fontWeight: 600 }}>
                {level} level
            </span>
        ]);
    };

    const renderInsightGroup = (title: string, items: AnalysisInsight[] | undefined, accent: string) => {
        if (!items || items.length === 0) return null;
        return (
            <div>
                <div className="mb-2.5 flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent }} />
                    <h4 className="text-sm font-bold tracking-tight text-[color:var(--ciq-text-strong)]">{title}</h4>
                    <span className="rounded-full bg-[color:var(--ciq-card-3)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--ciq-text-muted)]">
                        {items.length}
                    </span>
                </div>
                <ul className="space-y-2.5">
                    {items.map((it, i) => (
                        <li
                            key={`${title}-${i}`}
                            className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-3.5"
                            style={{ borderLeft: `3px solid ${accent}` }}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <p className="text-sm leading-relaxed text-[color:var(--ciq-text-strong)]">{it.insight}</p>
                                {it.confidence && (
                                    <span
                                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${confidenceColor(it.confidence)}`}
                                    >
                                        {it.confidence}
                                    </span>
                                )}
                            </div>
                            {(it.rule || it.dataPoint) && (
                                <div className="mt-2.5 flex flex-wrap gap-1.5">
                                    {it.rule && (
                                        <span className="rounded-md bg-[color:var(--ciq-card-2)] px-2 py-1 text-[11px] leading-snug text-[color:var(--ciq-text-muted)]">
                                            <span className="font-semibold text-[color:var(--ciq-text-body)]">Rule</span> · {it.rule}
                                        </span>
                                    )}
                                    {it.dataPoint && (
                                        <span className="rounded-md bg-[color:var(--ciq-card-2)] px-2 py-1 text-[11px] leading-snug text-[color:var(--ciq-text-muted)]">
                                            <span className="font-semibold text-[color:var(--ciq-text-body)]">Data</span> · {it.dataPoint}
                                        </span>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            </div>
        );
    };

    // Normalise the analysis into structured groups + an optional prose fallback, so a
    // raw JSON blob never reaches the UI. Handles ``` fences and surrounding prose by
    // extracting the first {...} block; prose that just looks like JSON is suppressed.
    const { analysis: normalizedAnalysis, analysisProse } = useMemo<{ analysis: AnalysisResult | null; analysisProse: string }>(() => {
        if (!analysisResult) return { analysis: null, analysisProse: "" };
        const groups = (analysisResult.correlations?.length ?? 0) + (analysisResult.contradictions?.length ?? 0) + (analysisResult.patterns?.length ?? 0);
        if (groups > 0) return { analysis: analysisResult, analysisProse: "" };

        const raw = (analysisResult.raw ?? analysisResult.summary ?? "").trim();
        if (!raw) return { analysis: null, analysisProse: "" };

        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                const parsed = JSON.parse(raw.slice(start, end + 1));
                if (parsed && typeof parsed === "object" && (parsed.correlations || parsed.contradictions || parsed.patterns)) {
                    return { analysis: { ...analysisResult, ...parsed }, analysisProse: "" };
                }
            } catch {
                /* fall through to prose handling */
            }
        }
        // Genuine prose only — never render something that looks like JSON.
        const looksLikeJson = raw.startsWith("{") || raw.startsWith("[") || raw.startsWith("```");
        return { analysis: null, analysisProse: looksLikeJson ? "" : raw };
    }, [analysisResult]);

    const insightCount = normalizedAnalysis
        ? (normalizedAnalysis.correlations?.length ?? 0) + (normalizedAnalysis.contradictions?.length ?? 0) + (normalizedAnalysis.patterns?.length ?? 0)
        : 0;
    const hasAnalysis = insightCount > 0 || !!analysisProse.trim();
    const hasConsultative = !!consultText?.trim();

    const cardClass = "ciq-print-keep rounded-2xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4";

    // "Download PDF" — the participant's own report goes through password → QR code →
    // one download on their phone (report-qr-dialog). An admin viewing someone else's
    // saved report (showZone false) keeps the browser's print → Save as PDF.
    const ownReport = !saved || saved.showZone;
    const [showQr, setShowQr] = useState(false);
    const [printing, setPrinting] = useState(false);
    const handleDownloadPdf = async () => {
        if (ownReport && surveyRunId) {
            setShowQr(true);
            return;
        }
        if (!reportRef.current || printing) return;
        setPrinting(true);
        try {
            const when = saved?.createdAt ? parseServerDate(saved.createdAt) : new Date();
            await printReport(reportRef.current, reportFileTitle(surveyType, surveyRunId, when));
        } finally {
            setPrinting(false);
        }
    };

    return (
        <div ref={reportRef} className="w-full rounded-2xl bg-[color:var(--ciq-card)] p-6 shadow-lg">
            {/* ── Header ── */}
            <div className="mb-5 flex items-center justify-between gap-3">
                <div>
                    <h2 className="font-display text-2xl font-bold text-[color:var(--ciq-text-strong)]">
                        {isReadiness ? "Readiness Assessment" : "Burnout Assessment"}
                    </h2>
                    <p className="text-sm text-[color:var(--ciq-text-muted)]">
                        {isReadiness ? "Readiness & physiological insight dashboard" : "Behavioral & physiological insight dashboard"}
                    </p>
                    {saved?.createdAt && <p className="mt-0.5 text-xs text-[color:var(--ciq-text-faint)]">Completed {formatServerDate(saved.createdAt)}</p>}
                </div>
                <button
                    onClick={() => void handleDownloadPdf()}
                    disabled={!scoreReady || printing}
                    className="ciq-no-print flex shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--ciq-line)] px-3 py-1.5 text-sm font-semibold text-[color:var(--ciq-text-strong)] hover:bg-[color:var(--ciq-card-2)] disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                        !scoreReady
                            ? "Available once the report is ready"
                            : ownReport
                              ? "Get a QR code to download this report on your phone"
                              : "Save this report as a PDF"
                    }
                >
                    {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    Download PDF
                </button>
            </div>
            {/* Portalled so no transformed ancestor (report panel, saved-report overlay) traps the fixed overlay. */}
            {showQr && surveyRunId && createPortal(<ReportQrDialog surveyRunId={surveyRunId} onClose={() => setShowQr(false)} />, document.body)}
            {/* Once the live report is saved: an off-screen light copy (saved mode, so no
                 API calls and no AI Insights tabs) is captured to the PDF the QR download serves. */}
            {!saved && analyzeData && surveyRunId && extrasLoaded && (
                <ReportPdfCapture surveyRunId={surveyRunId}>
                    <DetailedReport
                        snapshots={snapshots}
                        surveyRunId={surveyRunId}
                        surveyType={surveyType}
                        saved={{ report: analyzeData, createdAt: null, showZone: false, zone: zoneData, comparison }}
                    />
                </ReportPdfCapture>
            )}

            {/* Auto-save warning — shown when /analyze-report failed to persist after retries. */}
            {saveError && (
                <div className="ciq-no-print mb-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="flex-1">{saveError}</span>
                    <button
                        onClick={() => {
                            setSaveError(null);
                            setSaveAttempt(n => n + 1);
                        }}
                        className="shrink-0 rounded-md border border-amber-300 px-2 py-0.5 text-xs font-semibold hover:bg-amber-100"
                    >
                        Retry saving
                    </button>
                </div>
            )}

            {/* ── Combined Overall Burnout: risk gauge + enlarged domain radar ──
                 Same structure for every survey type, including READINESS — see
                 analyze_report / compute_survey_summary. ── */}
            <div className={`mb-4 ${cardClass}`}>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                    <Gauge className="h-5 w-5" /> {isReadiness ? "Overall Readiness" : "Overall Burnout"}
                </div>
                <div className={`grid items-center gap-4 ${compact ? "grid-cols-1" : "md:grid-cols-5"}`}>
                    {/* Risk gauge(s) — two independent subscales for a scoringSections
                        survey (e.g. PILOT's BAT-4/CBI-WRB3), or one combined gauge otherwise.
                        Compact: below the radar, one under another. */}
                    <div className={compact ? "order-2" : "md:col-span-2"}>
                        {sections ? (
                            <div className={`grid grid-cols-1 gap-4 ${compact ? "" : "sm:grid-cols-2"}`}>
                                {sections.map(s =>
                                    renderScoreGauge({
                                        label: s.label,
                                        score: s.score,
                                        lo: s.scoreRange[0],
                                        hi: s.scoreRange[1],
                                        riskLevel: s.riskLevel,
                                        riskText: s.interpretation,
                                        height: 200
                                    })
                                )}
                            </div>
                        ) : scoreReady ? (
                            renderScoreGauge({ label: "Overall", score: displayScore, lo: 0, hi: displayMax, riskLevel, riskText })
                        ) : (
                            <div className="flex h-[240px] items-center justify-center gap-2 text-[color:var(--ciq-text-muted)]">
                                <Loader2 className="h-5 w-5 animate-spin" />
                                <span className="text-sm font-medium">Calculating…</span>
                            </div>
                        )}
                    </div>

                    {/* Enlarged domain profile (radar, or bars when <3 domains) */}
                    <div className={compact ? "order-1" : "md:col-span-3"}>
                        <p className="mb-1 text-center text-sm font-medium text-[color:var(--ciq-text-body)]">
                            Domain Profile · avg score
                            <span className="ciq-no-print ml-1 text-xs font-normal text-[color:var(--ciq-text-muted)]">(hover a domain for details)</span>
                        </p>
                        <ResponsiveContainer width="100%" height={compact ? 400 : 360}>
                            {useRadar ? (
                                <RadarChart data={domainData} outerRadius={compact ? "52%" : "70%"}>
                                    <PolarGrid stroke={tok.line} />
                                    <PolarAngleAxis
                                        dataKey="domain"
                                        tick={props => <RadarTick {...props} fill={tok.strong} fontSize={compact ? 12 : 13} maxChars={compact ? 14 : 18} />}
                                    />
                                    <PolarRadiusAxis domain={[0, 100]} tick={{ fill: tok.muted, fontSize: 12 }} axisLine={false} />
                                    <Radar dataKey="score" stroke={tok.purple} fill={tok.purple} fillOpacity={0.35} strokeWidth={2} />
                                    <Tooltip content={domainTip} />
                                </RadarChart>
                            ) : (
                                <BarChart data={domainData} layout="vertical" margin={{ left: 10, right: 16 }}>
                                    <CartesianGrid stroke={tok.line} horizontal={false} />
                                    <XAxis type="number" domain={[0, 100]} tick={{ fill: tok.muted, fontSize: 13 }} />
                                    <YAxis type="category" dataKey="domain" width={150} tick={{ fill: tok.strong, fontSize: 13 }} />
                                    <Tooltip content={domainTip} cursor={{ fill: `${tok.muted}18` }} />
                                    <Bar dataKey="score" radius={[0, 6, 6, 0]}>
                                        {domainData.map((d, i) => (
                                            <Cell key={i} fill={scoreHex(d.score)} />
                                        ))}
                                    </Bar>
                                </BarChart>
                            )}
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>

            {/* ── Fatigue ↔ Burnout zone — only when /api/zone-trend's latest run IS this report's run ── */}
            {zoneData?.latest && zoneData.latest.surveyRunId === surveyRunId && (
                <div className={`mb-4 ${cardClass}`}>
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                        <Gauge className="h-5 w-5" /> Fatigue ↔ Burnout Zone
                    </div>
                    <ZoneScale latest={zoneData.latest} trend={zoneData.trend} />
                </div>
            )}

            {/* ── Compared with the last assessment of the same type (none on a first one) ── */}
            {comparison && comparison.measures.length > 0 && <ReportComparisonCard comparison={comparison} className={`mb-4 ${cardClass}`} />}

            {/* ── KPI tiles ── */}
            <div className="ciq-print-keep mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <KpiTile
                    icon={<Eye className="h-4 w-4" />}
                    label="Peak blink Δ"
                    value={blinkReadings.length ? `${peakBlink > 0 ? "+" : ""}${peakBlink.toFixed(0)}%` : "—"}
                />
                <KpiTile icon={<Timer className="h-4 w-4" />} label="Avg latency" value={avgLatency != null ? `${avgLatency}s` : "—"} />
            </div>

            {/* ── Full data table (everything, sentiment excluded) ── */}
            <div className="mb-6">
                <p className="mb-3 text-sm font-semibold text-[color:var(--ciq-text-body)]">Detailed data table</p>
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr className="bg-[color:var(--ciq-card-2)]">
                                {["Question", "Domain", "Score", "Blink Rate", "Left Gaze", "Right Gaze", "Response Latency"].map(h => (
                                    <th
                                        key={h}
                                        className="border border-[color:var(--ciq-line)] px-3 py-2 text-left font-semibold text-[color:var(--ciq-text-strong)]"
                                    >
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {snapshots.map((s, index) => {
                                const b = blinkBand(s.blinkRateChange);
                                return (
                                    <tr key={s.questionId} className={index % 2 === 0 ? "bg-[color:var(--ciq-card)]" : "bg-[color:var(--ciq-card-2)]"}>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-[color:var(--ciq-text-strong)]">{s.questionId}</td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-[color:var(--ciq-text-strong)]">{s.domain}</td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center font-medium text-[color:var(--ciq-text-strong)]">
                                            {scoreDisplay(s.questionId, s.score)}
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center">
                                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${b.color}`}>{b.label}</span>
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-strong)]">
                                            {s.leftGazePosition}
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-strong)]">
                                            {s.rightGazePosition}
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-strong)]">
                                            {s.responseLatencyMs != null ? `${(s.responseLatencyMs / 1000).toFixed(1)}s` : "—"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            <p className="mb-6 text-xs text-[color:var(--ciq-text-faint)]">
                Note: This is a demonstration only. Results should be validated by a healthcare professional.
            </p>

            {/* ── AI reports — tabbed nav + shared content area. Live report only, and
                 never in the PDF; a saved report (History / Admin) leaves it out. ── */}
            {!saved && (
                <div className="ciq-no-print mb-2 border-t border-[color:var(--ciq-line)] pt-6">
                    <h3 className="mb-1 font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">AI Insights</h3>
                    <p className="mb-3 text-xs text-[color:var(--ciq-text-faint)]">
                        Pick a report to generate — each takes a few seconds. Switching tabs swaps the view below.
                    </p>

                    <div className="flex w-full items-stretch border-b border-[color:var(--ciq-line)]">
                        <ReportTabButton
                            label="Behavioral Analysis"
                            icon={<Gauge className="h-4 w-4" />}
                            active={activeReportTab === "analysis"}
                            loading={analysisLoading}
                            disabled={snapshots.length === 0}
                            onClick={() => openReportTab("analysis")}
                        />
                        <ReportTabButton
                            label="Consultative Summary"
                            icon={<Sparkles className="h-4 w-4" />}
                            active={activeReportTab === "consultative"}
                            loading={consultLoading}
                            disabled={snapshots.length === 0}
                            onClick={() => openReportTab("consultative")}
                        />
                    </div>

                    <div className="mt-4 min-h-[9rem] rounded-2xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4">
                        {activeReportTab === null && (
                            <div className="flex min-h-[7rem] flex-col items-center justify-center gap-1.5 text-center">
                                <Sparkles className="h-6 w-6 text-[color:var(--ciq-text-faint)]" />
                                <p className="text-sm text-[color:var(--ciq-text-muted)]">Choose a report above to generate it.</p>
                            </div>
                        )}

                        {activeReportTab === "analysis" &&
                            (analysisLoading ? (
                                <ReportLoading label={isReadiness ? "Reflecting on the conversation…" : "Analyzing behaviour…"} />
                            ) : analysisError ? (
                                <ReportError text={analysisError} onRetry={handleGenerateAnalysis} />
                            ) : isReadiness && analysisResult?.assessment_summary ? (
                                <ReadinessReportView analysisResult={analysisResult} />
                            ) : isReadiness && analysisResult?.raw ? (
                                // The model's JSON didn't parse into the expected shape server-side
                                // (parse_llm_json fell back to {raw: "..."}) — show it rather than
                                // silently rendering nothing even though generation did succeed.
                                <Markdown>{analysisResult.raw}</Markdown>
                            ) : hasAnalysis ? (
                                <div className="space-y-5">
                                    {insightCount > 0 ? (
                                        <>
                                            {renderInsightGroup("Correlations", normalizedAnalysis?.correlations, tok.blue)}
                                            {renderInsightGroup("Contradictions", normalizedAnalysis?.contradictions, tok.red)}
                                            {renderInsightGroup("Patterns", normalizedAnalysis?.patterns, tok.purple)}
                                        </>
                                    ) : (
                                        <Markdown>{analysisProse}</Markdown>
                                    )}
                                </div>
                            ) : (
                                <ReportEmpty label="Generate Behavioral Analysis" onClick={handleGenerateAnalysis} />
                            ))}

                        {activeReportTab === "consultative" &&
                            (consultLoading ? (
                                <ReportLoading label="Summarizing…" />
                            ) : consultError ? (
                                <ReportError text={consultError} onRetry={handleGenerateConsultative} />
                            ) : hasConsultative ? (
                                <Markdown>{consultText ?? ""}</Markdown>
                            ) : (
                                <ReportEmpty label="Generate Consultative Summary" onClick={handleGenerateConsultative} />
                            ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function ReportTabButton({
    label,
    icon,
    active,
    loading,
    disabled,
    onClick
}: {
    label: string;
    icon: React.ReactNode;
    active: boolean;
    loading: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            aria-current={active ? "page" : undefined}
            className={`relative -mb-px flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-3 text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ciq-accent-purple)] disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                    ? "border-[color:var(--ciq-accent-purple)] font-bold text-[color:var(--ciq-text-strong)]"
                    : "border-transparent font-medium text-[color:var(--ciq-text-muted)] hover:text-[color:var(--ciq-text-strong)]"
            }`}
        >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <span>{icon}</span>}
            <span>{label}</span>
        </button>
    );
}

function ReportLoading({ label }: { label: string }) {
    return (
        <div className="flex min-h-[7rem] items-center justify-center gap-2 text-sm text-[color:var(--ciq-text-muted)]">
            <Loader2 className="h-5 w-5 animate-spin" /> {label}
        </div>
    );
}

function ReportError({ text, onRetry }: { text: string; onRetry: () => void }) {
    return (
        <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg bg-petroleum-flare/10 p-3 text-sm text-petroleum-flare">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{text}</span>
            </div>
            <button onClick={onRetry} className="text-sm font-medium text-[color:var(--ciq-accent-purple)] hover:underline">
                Try again
            </button>
        </div>
    );
}

function ReportEmpty({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <div className="flex min-h-[7rem] items-center justify-center">
            <button
                onClick={onClick}
                className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] px-5 py-2.5 text-sm font-semibold text-[color:var(--ciq-text-strong)] hover:bg-[color:var(--ciq-card-3)]"
            >
                {label}
            </button>
        </div>
    );
}

function KpiTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
    return (
        <div className="rounded-2xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-3">
            <div className="flex items-center gap-1.5 text-[color:var(--ciq-text-muted)]">
                {icon}
                <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span>
            </div>
            <p className="mt-1 text-xl font-bold text-[color:var(--ciq-text-strong)]">{value}</p>
        </div>
    );
}
