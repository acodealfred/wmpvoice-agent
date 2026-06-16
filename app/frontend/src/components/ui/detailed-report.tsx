import { useState, useEffect } from "react";
import { BiometricSnapshot, SSoTReport, AnalyzeReportResponse, AnalysisInsight } from "@/types";
import { Loader2, AlertCircle, BookOpen, ExternalLink, Sparkles } from "lucide-react";

interface DetailedReportProps {
    snapshots: BiometricSnapshot[];
    totalScore: number;
    sessionId?: string;
    onClose?: () => void;
    onAgentSpeaking?: (text: string) => void;
    onReportDelivered?: () => void;
}

export function DetailedReport({ snapshots, totalScore, sessionId, onClose, onReportDelivered }: DetailedReportProps) {
    const [ssotLoading, setSsotLoading] = useState(false);
    const [ssotReport, setSsotReport] = useState<SSoTReport | null>(null);
    const [ssotError, setSsotError] = useState<string | null>(null);
    const [ssotQuery, setSsotQuery] = useState<string | null>(null);

    const [analyzeData, setAnalyzeData] = useState<AnalyzeReportResponse | null>(null);

    const getSentimentColor = (sentiment: string): string => {
        switch (sentiment) {
            case "positive": return "text-green-700";
            case "negative": return "text-red-700";
            default: return "text-yellow-700";
        }
    };

    const handleGenerateAIReport = async () => {
        setSsotLoading(true);
        setSsotError(null);
        setSsotReport(null);
        setSsotQuery(null);

        const payload = { snapshots, session_id: sessionId ?? "" };
        console.group("[SSOT] Generate AI Report");
        console.log("→ POST /ssot-report", payload);

        try {
            const response = await fetch("/ssot-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            console.log(`← HTTP ${response.status}`, data);
            console.groupEnd();

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

    // ── Data-driven technical report (POST /analyze-report) ───────────────
    // Fires once when the report opens; populates risk, behavioral analysis and
    // the consultative summary from the backend (single source of truth).
    useEffect(() => {
        if (snapshots.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/analyze-report", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ snapshots, session_id: sessionId ?? "" })
                });
                if (!res.ok || cancelled) return;
                const data = (await res.json()) as AnalyzeReportResponse;
                if (cancelled) return;
                setAnalyzeData(data);
                onReportDelivered?.();
            } catch {
                // Analysis is optional — on any failure the section is simply omitted.
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshots, sessionId]);

    // Prefer the backend's data-driven values; fall back to props until they load.
    const displayScore = analyzeData?.totalScore ?? totalScore;
    const displayMax = analyzeData?.maxScore ?? snapshots.length * 5;
    const riskLevel = analyzeData?.riskLevel ?? (displayScore <= 12 ? "Low" : displayScore <= 22 ? "Moderate" : "High");
    const riskText = analyzeData?.interpretation ?? `${riskLevel} burnout risk`;
    const riskColor = riskLevel === "Low" ? "text-green-600" : riskLevel === "Moderate" ? "text-yellow-600" : "text-red-600";

    const confidenceColor = (c: string) =>
        c === "high" ? "bg-green-100 text-green-700" : c === "medium" ? "bg-yellow-100 text-yellow-700" : "bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-body)]";

    // Blink-rate change → Low/Medium/High category (CIQ Signal-Thresholds bands).
    // Magnitude sets the level; the arrow keeps direction (↑ above / ↓ below baseline).
    const blinkBand = (changePct: number): { label: string; color: string } => {
        const mag = Math.abs(changePct);
        if (mag <= 15) return { label: "Normal", color: "bg-green-100 text-green-700" };
        const arrow = changePct > 0 ? "↑" : "↓";
        if (mag <= 40) return { label: `Elevated ${arrow}`, color: "bg-yellow-100 text-yellow-700" };
        return { label: `High ${arrow}`, color: "bg-red-100 text-red-700" };
    };

    // Pupil-dilation change (mm vs baseline) → category (CIQ Signal-Thresholds bands).
    const pupilBand = (mmChange?: number): { label: string; color: string } => {
        if (mmChange == null) return { label: "—", color: "bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-muted)]" };
        if (mmChange <= 0.1) return { label: "Low", color: "bg-green-100 text-green-700" };
        if (mmChange <= 0.3) return { label: "Medium", color: "bg-yellow-100 text-yellow-700" };
        return { label: "High", color: "bg-red-100 text-red-700" };
    };

    const renderInsightGroup = (title: string, items?: AnalysisInsight[]) => {
        if (!items || items.length === 0) return null;
        return (
            <div>
                <h4 className="mb-2 text-sm font-semibold text-[color:var(--ciq-text-body)]">{title}</h4>
                <ul className="space-y-2">
                    {items.map((it, i) => (
                        <li key={`${title}-${i}`} className="rounded-lg border border-[color:var(--ciq-line)] p-3">
                            <div className="flex items-start justify-between gap-2">
                                <p className="text-sm text-[color:var(--ciq-text-strong)]">{it.insight}</p>
                                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${confidenceColor(it.confidence)}`}>
                                    {it.confidence}
                                </span>
                            </div>
                            {(it.rule || it.dataPoint) && (
                                <p className="mt-1 text-xs text-[color:var(--ciq-text-muted)]">
                                    {it.rule && (
                                        <span>
                                            <span className="font-medium">Rule:</span> {it.rule}{" "}
                                        </span>
                                    )}
                                    {it.dataPoint && (
                                        <span>
                                            · <span className="font-medium">Data:</span> {it.dataPoint}
                                        </span>
                                    )}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            </div>
        );
    };

    const insightCount = analyzeData
        ? (analyzeData.analysis?.correlations?.length ?? 0) +
          (analyzeData.analysis?.contradictions?.length ?? 0) +
          (analyzeData.analysis?.patterns?.length ?? 0)
        : 0;
    const hasConsultative = !!analyzeData?.agentResponse?.trim();

    return (
        <div className="w-full max-w-4xl rounded-lg bg-[color:var(--ciq-card)] p-6 shadow-lg">

            {/* ── Section 1: Technical Report ─────────────────────────── */}
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-[color:var(--ciq-text-strong)]">
                    Burnout Assessment Results — Technical Report
                </h2>
                {onClose && (
                    <button onClick={onClose} className="rounded-full p-2 hover:bg-[color:var(--ciq-card-2)]" aria-label="Close report">
                        ✕
                    </button>
                )}
            </div>

            {/* Score summary — data-driven from the active survey's thresholds/interpretation */}
            <div className="mb-6 rounded-lg bg-purple-50 p-4">
                <div className="text-center">
                    <span className="text-lg font-medium text-[color:var(--ciq-text-body)]">Total Burnout Score</span>
                    <div className="mt-2 text-4xl font-bold text-purple-600">
                        {displayScore} / {displayMax}
                    </div>
                    <div className={`mt-2 text-sm font-medium ${riskColor}`}>{riskText}</div>
                </div>
            </div>

            {/* Biometric snapshot table */}
            <div className="mb-6 overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr className="bg-[color:var(--ciq-card-2)]">
                            <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-left font-semibold text-[color:var(--ciq-text-strong)]">Question</th>
                            <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-left font-semibold text-[color:var(--ciq-text-strong)]">Domain</th>
                            <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center font-semibold text-[color:var(--ciq-text-strong)]">Score</th>
                            <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center font-semibold text-[color:var(--ciq-text-strong)]">Voice Sentiment</th>
                            <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center font-semibold text-[color:var(--ciq-text-strong)]">Blink Rate</th>
                            <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center font-semibold text-[color:var(--ciq-text-strong)]">Pupil Dilation</th>
                            <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center font-semibold text-[color:var(--ciq-text-strong)]">Gaze Position</th>
                            <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center font-semibold text-[color:var(--ciq-text-strong)]">Response Latency</th>
                        </tr>
                    </thead>
                    <tbody>
                        {snapshots.map((snapshot, index) => (
                            <tr key={snapshot.questionId} className={index % 2 === 0 ? "bg-[color:var(--ciq-card)]" : "bg-[color:var(--ciq-card-2)]"}>
                                <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-[color:var(--ciq-text-strong)]">{snapshot.questionId}</td>
                                <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-[color:var(--ciq-text-strong)]">{snapshot.domain}</td>
                                <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center font-medium text-[color:var(--ciq-text-strong)]">{snapshot.score}/5</td>
                                <td className={`border border-[color:var(--ciq-line)] px-3 py-2 text-center font-medium capitalize ${getSentimentColor(snapshot.voiceSentiment)}`}>
                                    {snapshot.voiceSentiment}
                                </td>
                                <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center">
                                    {(() => {
                                        const b = blinkBand(snapshot.blinkRateChange);
                                        return (
                                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${b.color}`}>
                                                {b.label}
                                            </span>
                                        );
                                    })()}
                                </td>
                                <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center">
                                    {(() => {
                                        const b = pupilBand(snapshot.pupilMmChange);
                                        return (
                                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${b.color}`}>
                                                {b.label}
                                            </span>
                                        );
                                    })()}
                                </td>
                                <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-strong)]">{snapshot.gazePosition}</td>
                                <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-strong)]">
                                    {snapshot.responseLatencyMs != null ? `${(snapshot.responseLatencyMs / 1000).toFixed(1)}s` : "—"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="mb-6 text-xs text-[color:var(--ciq-text-faint)]">
                Note: This is a demonstration only. Results should be validated by a healthcare professional.
            </p>

            {/* ── Behavioral Analysis — rendered ONLY when the model produced real
                 content. If /analyze-report fails or returns nothing usable, the whole
                 section is omitted, as if the feature isn't there. ─── */}
            {analyzeData && (insightCount > 0 || hasConsultative) && (
                <div className="mb-6 border-t border-[color:var(--ciq-line)] pt-6">
                    <h3 className="mb-3 text-lg font-semibold text-[color:var(--ciq-text-strong)]">Behavioral Analysis</h3>
                    <div className="space-y-4">
                        {renderInsightGroup("Correlations", analyzeData.analysis?.correlations)}
                        {renderInsightGroup("Contradictions", analyzeData.analysis?.contradictions)}
                        {renderInsightGroup("Patterns", analyzeData.analysis?.patterns)}

                        {hasConsultative && (
                            <div className="rounded-lg bg-[color:var(--ciq-card-2)] p-4">
                                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                                    Consultative Summary
                                </p>
                                <p className="whitespace-pre-line text-sm leading-relaxed text-[color:var(--ciq-text-body)]">
                                    {analyzeData.agentResponse}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── Generate AI Report button ─────────────────────────── */}
            <div className="mb-6 border-t border-[color:var(--ciq-line)] pt-6">
                <button
                    onClick={handleGenerateAIReport}
                    disabled={ssotLoading || snapshots.length === 0}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white shadow-md hover:from-blue-700 hover:to-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {ssotLoading ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Generating AI Report…
                        </>
                    ) : (
                        <>
                            <Sparkles className="h-4 w-4" />
                            Generate AI Report
                        </>
                    )}
                </button>
                {!ssotReport && !ssotLoading && (
                    <p className="mt-2 text-center text-xs text-[color:var(--ciq-text-faint)]">
                        Generates a consultative report from your organisation's knowledge base with evidence-based citations.
                    </p>
                )}
            </div>

            {/* ── Section 2: AI Consultative Report (SSOT) ─────────── */}
            {/* Query sent to Mithra — shown as soon as it comes back from the server */}
            {ssotQuery && (
                <div className="mb-4 rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                        Query sent to Knowledge Base
                    </p>
                    <p className="text-sm italic leading-relaxed text-[color:var(--ciq-text-body)]">{ssotQuery}</p>
                </div>
            )}

            {ssotError && (
                <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-red-700">
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                    <span className="text-sm">{ssotError}</span>
                </div>
            )}

            {ssotReport && (
                <div className="rounded-xl border border-blue-700 bg-[color:var(--ciq-card)] p-5">
                    <div className="mb-3 flex items-center gap-2">
                        <BookOpen className="h-5 w-5 text-blue-400" />
                        <h3 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">AI Consultative Report</h3>
                        <span className="ml-auto rounded-full bg-blue-900/50 px-2 py-0.5 text-xs font-medium text-blue-300">
                            SSOT · Evidence-based
                        </span>
                    </div>

                    <p className="whitespace-pre-line text-sm leading-relaxed text-[color:var(--ciq-text-strong)]">
                        {ssotReport.answer}
                    </p>

                    {ssotReport.citations.length > 0 && (
                        <div className="mt-4 border-t border-[color:var(--ciq-line)] pt-3">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                                Citations
                            </p>
                            <ul className="space-y-1.5">
                                {ssotReport.citations.map((c, i) => (
                                    <li key={i} className="flex items-start gap-2 text-xs text-[color:var(--ciq-text-body)]">
                                        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-blue-400" />
                                        <span>
                                            <span className="font-medium text-blue-300">{c.paperTitle}</span>
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
            )}
        </div>
    );
}
