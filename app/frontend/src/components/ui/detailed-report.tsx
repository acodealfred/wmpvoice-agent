import { useState, useEffect, useMemo } from "react";
import { BiometricSnapshot, SSoTReport, AnalyzeReportResponse, AnalysisResult, AnalysisInsight } from "@/types";
import { apiFetch } from "@/lib/api";
import { blinkBandLevel, pupilBandLevel } from "@/lib/bands";
import { Loader2, AlertCircle, BookOpen, ExternalLink, Sparkles, Eye, Timer, Gauge } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { ReadinessReportView } from "@/components/ui/readiness-report-view";
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
    onClose?: () => void;
    onAgentSpeaking?: (text: string) => void;
    onReportDelivered?: () => void;
}

// ── Theme tokens resolved to concrete colors for Recharts (which needs real
// color strings, not CSS var() references). Re-reads when the theme flips. ──
type Tokens = ReturnType<typeof readTokens>;
function readTokens() {
    const s = getComputedStyle(document.documentElement);
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
function useThemeTokens(): Tokens {
    const [tok, setTok] = useState<Tokens>(readTokens);
    useEffect(() => {
        const obs = new MutationObserver(() => setTok(readTokens()));
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
        return () => obs.disconnect();
    }, []);
    return tok;
}

type ReportTab = "analysis" | "kb" | "consultative";

export function DetailedReport({ snapshots, sessionId, surveyRunId, surveyType, onClose, onReportDelivered }: DetailedReportProps) {
    const tok = useThemeTokens();

    const [ssotLoading, setSsotLoading] = useState(false);
    const [ssotReport, setSsotReport] = useState<SSoTReport | null>(null);
    const [ssotError, setSsotError] = useState<string | null>(null);
    const [ssotQuery, setSsotQuery] = useState<string | null>(null);

    const [analyzeData, setAnalyzeData] = useState<AnalyzeReportResponse | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);

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

    const handleGenerateAIReport = async () => {
        setSsotLoading(true);
        setSsotError(null);
        setSsotReport(null);
        setSsotQuery(null);

        const payload = { snapshots, session_id: sessionId ?? "", survey_run_id: surveyRunId ?? "", survey_type: surveyType ?? "" };
        console.group("[SSOT] Generate AI Report");
        console.log("→ POST /ssot-report", payload);

        try {
            const response = await apiFetch("/ssot-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            console.log(`← HTTP ${response.status}`, data);
            console.groupEnd();

            // Reaching the backend means the survey row was persisted (the record is
            // saved up-front, before the KB call), so clear any auto-save warning.
            setSaveError(null);

            if (!response.ok) {
                setSsotError(data.error ?? `Request failed (HTTP ${response.status})`);
                return;
            }

            if (data.query) setSsotQuery(data.query);

            if (data.ssotReport?.answer) {
                setSsotReport(data.ssotReport);
                onReportDelivered?.();
            } else {
                setSsotError("No report returned from Knowledge Base. Ensure documents are uploaded and the company is registered.");
            }
        } catch (err) {
            console.error("[SSOT] Network error", err);
            console.groupEnd();
            setSsotError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setSsotLoading(false);
        }
    };

    // Open a report tab; the first time it's opened, kick off its generation.
    const openReportTab = (tab: ReportTab) => {
        setActiveReportTab(tab);
        if (tab === "analysis" && !analysisResult && !analysisLoading) handleGenerateAnalysis();
        else if (tab === "consultative" && !consultText && !consultLoading) handleGenerateConsultative();
        else if (tab === "kb" && !ssotReport && !ssotLoading) handleGenerateAIReport();
    };

    // ── Data-driven technical report (POST /analyze-report) ───────────────
    // This call is also what persists the survey to history (backend writes the
    // survey_records row up-front). To make sure no survey is silently lost, we
    // retry a few times on transient failure and surface an error if it never
    // succeeds, so the user can fall back to the "Generate AI Report" button.
    useEffect(() => {
        if (snapshots.length === 0) return;
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
                    return;
                } catch (err) {
                    if (cancelled) return;
                    console.warn(`[AnalyzeReport] attempt ${attempt}/${MAX_ATTEMPTS} failed`, err);
                    if (attempt < MAX_ATTEMPTS) {
                        await sleep(attempt * 1000); // 1s, 2s backoff
                    } else {
                        setSaveError('We couldn\'t save this result automatically. Press "Generate AI Report" below to retry and save it to your history.');
                    }
                }
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshots, sessionId]);

    // Once the report row is persisted, generate the consultative summary in the
    // background so its text (prompt_info.agentResponse) is saved to history. The
    // agent speaks a summary live, but that audio is never stored — without this
    // the summary is lost on relogin (and the guest Home recommendations vanish).
    // Only runs for an authenticated, persistable run; opening the tab reuses the
    // result instead of regenerating it.
    useEffect(() => {
        if (analyzeData && surveyRunId && !consultText && !consultLoading && !consultError) {
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
        if (isReadiness && analyzeData && !analysisResult && !analysisLoading && !analysisError) {
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
        return (
            <div key={label}>
                <div className="relative">
                    <ResponsiveContainer width="100%" height={height}>
                        <RadialBarChart innerRadius="68%" outerRadius="100%" data={[{ value: pct, fill: hex }]} startAngle={180} endAngle={0}>
                            <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                            <RadialBar background={{ fill: tok.card }} dataKey="value" cornerRadius={14} angleAxisId={0} />
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
        score: Number((v.sum / v.n).toFixed(2))
    }));
    const useRadar = domainData.length >= 3;

    // KPI tiles.
    const peakBlink = snapshots.reduce((m, s) => (Math.abs(s.blinkRateChange) > Math.abs(m) ? s.blinkRateChange : m), 0);
    const peakPupil = snapshots.reduce((m, s) => Math.max(m, s.pupilMmChange ?? 0), 0);
    const latencies = snapshots.map(s => s.responseLatencyMs).filter((x): x is number => x != null);
    const avgLatency = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000).toFixed(1) : null;

    const confidenceColor = (c: string) =>
        c === "high"
            ? "bg-petroleum-vapour/15 text-petroleum-vapour"
            : c === "medium"
              ? "bg-petroleum-sodium/15 text-petroleum-sodium"
              : "bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-body)]";

    const blinkBand = (changePct: number): { label: string; color: string } => {
        const level = blinkBandLevel(changePct);
        if (level === "Normal") return { label: "Normal", color: "bg-petroleum-vapour/15 text-petroleum-vapour" };
        const arrow = changePct > 0 ? "↑" : "↓";
        return level === "Elevated"
            ? { label: `Elevated ${arrow}`, color: "bg-petroleum-sodium/15 text-petroleum-sodium" }
            : { label: `High ${arrow}`, color: "bg-petroleum-flare/15 text-petroleum-flare" };
    };

    const pupilBand = (mmChange?: number | null): { label: string; color: string } => {
        const level = pupilBandLevel(mmChange);
        if (level === "Unknown")
            return { label: "—", color: "bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-muted)]" };
        if (level === "Low") return { label: "Low", color: "bg-petroleum-vapour/15 text-petroleum-vapour" };
        if (level === "Medium") return { label: "Medium", color: "bg-petroleum-sodium/15 text-petroleum-sodium" };
        return { label: "High", color: "bg-petroleum-flare/15 text-petroleum-flare" };
    };

    const tooltipStyle = {
        background: tok.card,
        border: `1px solid ${tok.line}`,
        borderRadius: 12,
        color: tok.strong,
        fontSize: 12,
        boxShadow: "0 8px 30px rgba(0,0,0,0.18)"
    } as const;

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

    const cardClass = "rounded-2xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4";

    return (
        <div className="w-full rounded-2xl bg-[color:var(--ciq-card)] p-6 shadow-lg">
            {/* ── Header ── */}
            <div className="mb-5 flex items-center justify-between">
                <div>
                    <h2 className="font-display text-2xl font-bold text-[color:var(--ciq-text-strong)]">
                        {isReadiness ? "Readiness Assessment" : "Burnout Assessment"}
                    </h2>
                    <p className="text-sm text-[color:var(--ciq-text-muted)]">
                        {isReadiness ? "Readiness & physiological insight dashboard" : "Behavioral & physiological insight dashboard"}
                    </p>
                </div>
                {onClose && (
                    <button
                        onClick={onClose}
                        className="rounded-full p-2 text-[color:var(--ciq-text-muted)] hover:bg-[color:var(--ciq-card-2)]"
                        aria-label="Close report"
                    >
                        ✕
                    </button>
                )}
            </div>

            {/* Auto-save warning — shown when /analyze-report failed to persist after retries. */}
            {saveError && (
                <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{saveError}</span>
                </div>
            )}

            {/* ── Combined Overall Burnout: risk gauge + enlarged domain radar ──
                 Same structure for every survey type, including READINESS — see
                 analyze_report / compute_survey_summary. ── */}
            <div className={`mb-4 ${cardClass}`}>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                    <Gauge className="h-5 w-5" /> {isReadiness ? "Overall Readiness" : "Overall Burnout"}
                </div>
                <div className="grid items-center gap-4 md:grid-cols-5">
                    {/* Risk gauge(s) — two independent subscales for a scoringSections
                        survey (e.g. PILOT's BAT-4/CBI-WRB3), or one combined gauge otherwise. */}
                    <div className="md:col-span-2">
                        {sections ? (
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                    <div className="md:col-span-3">
                        <p className="mb-1 text-center text-sm font-medium text-[color:var(--ciq-text-body)]">Domain Profile · avg score</p>
                        <ResponsiveContainer width="100%" height={360}>
                            {useRadar ? (
                                <RadarChart data={domainData} outerRadius="78%">
                                    <PolarGrid stroke={tok.line} />
                                    <PolarAngleAxis dataKey="domain" tick={{ fill: tok.strong, fontSize: 14 }} />
                                    <PolarRadiusAxis domain={[0, 100]} tick={{ fill: tok.muted, fontSize: 12 }} axisLine={false} />
                                    <Radar dataKey="score" stroke={tok.purple} fill={tok.purple} fillOpacity={0.35} strokeWidth={2} />
                                    <Tooltip contentStyle={tooltipStyle} />
                                </RadarChart>
                            ) : (
                                <BarChart data={domainData} layout="vertical" margin={{ left: 10, right: 16 }}>
                                    <CartesianGrid stroke={tok.line} horizontal={false} />
                                    <XAxis type="number" domain={[0, 100]} tick={{ fill: tok.muted, fontSize: 13 }} />
                                    <YAxis type="category" dataKey="domain" width={150} tick={{ fill: tok.strong, fontSize: 13 }} />
                                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: `${tok.muted}18` }} />
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

            {/* ── KPI tiles ── */}
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <KpiTile icon={<Eye className="h-4 w-4" />} label="Peak blink Δ" value={`${peakBlink > 0 ? "+" : ""}${peakBlink.toFixed(0)}%`} />
                <KpiTile icon={<Eye className="h-4 w-4" />} label="Peak pupil Δ" value={`${peakPupil.toFixed(2)} mm`} />
                <KpiTile icon={<Timer className="h-4 w-4" />} label="Avg latency" value={avgLatency != null ? `${avgLatency}s` : "—"} />
            </div>

            {/* ── Full data table (everything, sentiment excluded) ── */}
            <div className="mb-6">
                <p className="mb-3 text-sm font-semibold text-[color:var(--ciq-text-body)]">Detailed data table</p>
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr className="bg-[color:var(--ciq-card-2)]">
                                {["Question", "Domain", "Score", "Blink Rate", "Pupil Dilation", "Left Gaze", "Right Gaze", "Response Latency"].map(h => (
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
                                const p = pupilBand(s.pupilMmChange);
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
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center">
                                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${p.color}`}>{p.label}</span>
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

            {/* ── AI reports — tabbed nav + shared content area ── */}
            <div className="mb-2 border-t border-[color:var(--ciq-line)] pt-6">
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
                        label="AI Report (KB)"
                        icon={<BookOpen className="h-4 w-4" />}
                        active={activeReportTab === "kb"}
                        loading={ssotLoading}
                        disabled={snapshots.length === 0}
                        special
                        onClick={() => openReportTab("kb")}
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

                    {activeReportTab === "kb" &&
                        (ssotLoading ? (
                            <ReportLoading label="Generating AI report…" />
                        ) : ssotReport ? (
                            <div className="space-y-3">
                                {ssotQuery && (
                                    <div className="rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-3">
                                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                                            Query sent to Knowledge Base
                                        </p>
                                        <p className="text-sm italic leading-relaxed text-[color:var(--ciq-text-body)]">{ssotQuery}</p>
                                    </div>
                                )}
                                <div className="flex items-center gap-2">
                                    <BookOpen className="h-5 w-5 text-[color:var(--ciq-accent-blue)]" />
                                    <h4 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">AI Consultative Report</h4>
                                    <span className="ml-auto rounded-full bg-[color:var(--ciq-card-3)] px-2 py-0.5 text-xs font-medium text-[color:var(--ciq-accent-blue)]">
                                        SSOT · Evidence-based
                                    </span>
                                </div>
                                <Markdown>{ssotReport.answer}</Markdown>
                                {ssotReport.citations.length > 0 && (
                                    <div className="border-t border-[color:var(--ciq-line)] pt-3">
                                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">Citations</p>
                                        <ul className="space-y-1.5">
                                            {ssotReport.citations.map((c, i) => (
                                                <li key={i} className="flex items-start gap-2 text-xs text-[color:var(--ciq-text-body)]">
                                                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--ciq-accent-blue)]" />
                                                    <span>
                                                        <span className="font-medium text-[color:var(--ciq-accent-blue)]">{c.paperTitle}</span>
                                                        {c.paperPage > 0 && (
                                                            <span className="ml-1 text-[color:var(--ciq-text-muted)]">— p.&nbsp;{c.paperPage}</span>
                                                        )}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        ) : ssotError ? (
                            <ReportError text={ssotError} onRetry={handleGenerateAIReport} />
                        ) : (
                            <ReportEmpty label="Generate AI Report" onClick={handleGenerateAIReport} />
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
        </div>
    );
}

function ReportTabButton({
    label,
    icon,
    active,
    loading,
    disabled,
    special,
    onClick
}: {
    label: string;
    icon: React.ReactNode;
    active: boolean;
    loading: boolean;
    disabled?: boolean;
    special?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            aria-current={active ? "page" : undefined}
            className={`relative -mb-px flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-3 text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--ciq-accent-purple)] disabled:cursor-not-allowed disabled:opacity-50 ${
                special ? "rounded-t-lg bg-[color:var(--ciq-accent-blue)]/10" : ""
            } ${
                active
                    ? `font-bold text-[color:var(--ciq-text-strong)] ${special ? "border-[color:var(--ciq-accent-blue)]" : "border-[color:var(--ciq-accent-purple)]"}`
                    : "border-transparent font-medium text-[color:var(--ciq-text-muted)] hover:text-[color:var(--ciq-text-strong)]"
            }`}
        >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className={special ? "text-[color:var(--ciq-accent-blue)]" : ""}>{icon}</span>}
            <span className={special && !active ? "font-semibold text-[color:var(--ciq-accent-blue)]" : ""}>
                {label}
            </span>
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
