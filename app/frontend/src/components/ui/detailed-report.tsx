import { useState } from "react";
import { BiometricSnapshot, SSoTReport } from "@/types";
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

    const getStressLevel = (blinkRateChange: number): string => {
        if (blinkRateChange > 30) return "High";
        if (blinkRateChange < -30) return "Low";
        return "Normal";
    };

    const getSentimentColor = (sentiment: string): string => {
        switch (sentiment) {
            case "positive": return "text-green-700";
            case "negative": return "text-red-700";
            default: return "text-yellow-700";
        }
    };

    const getStressColor = (blinkRateChange: number): string => {
        if (blinkRateChange > 30) return "text-red-700";
        if (blinkRateChange < -30) return "text-green-700";
        return "text-gray-700";
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

    return (
        <div className="w-full max-w-4xl rounded-lg bg-white p-6 shadow-lg">

            {/* ── Section 1: Technical Report ─────────────────────────── */}
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-800">
                    Burnout Assessment Results — Technical Report
                </h2>
                {onClose && (
                    <button onClick={onClose} className="rounded-full p-2 hover:bg-gray-100" aria-label="Close report">
                        ✕
                    </button>
                )}
            </div>

            {/* Score summary */}
            <div className="mb-6 rounded-lg bg-purple-50 p-4">
                <div className="text-center">
                    <span className="text-lg font-medium text-gray-700">Total Burnout Score</span>
                    <div className="mt-2 text-4xl font-bold text-purple-600">{totalScore} / 25</div>
                    <div className="mt-2 text-sm">
                        {totalScore <= 12 && <span className="text-green-600">Low burnout risk</span>}
                        {totalScore > 12 && totalScore <= 22 && <span className="text-yellow-600">Moderate burnout risk</span>}
                        {totalScore > 22 && <span className="text-red-600">High burnout risk</span>}
                    </div>
                </div>
            </div>

            {/* Biometric snapshot table */}
            <div className="mb-6 overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr className="bg-gray-800">
                            <th className="border border-gray-300 px-3 py-2 text-left font-semibold text-white">Question</th>
                            <th className="border border-gray-300 px-3 py-2 text-left font-semibold text-white">Domain</th>
                            <th className="border border-gray-300 px-3 py-2 text-center font-semibold text-white">Score</th>
                            <th className="border border-gray-300 px-3 py-2 text-center font-semibold text-white">Voice Sentiment</th>
                            <th className="border border-gray-300 px-3 py-2 text-center font-semibold text-white">Blink Rate Δ</th>
                            <th className="border border-gray-300 px-3 py-2 text-center font-semibold text-white">BR Stress</th>
                            <th className="border border-gray-300 px-3 py-2 text-center font-semibold text-white">Face Emotion</th>
                        </tr>
                    </thead>
                    <tbody>
                        {snapshots.map((snapshot, index) => (
                            <tr key={snapshot.questionId} className={index % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                <td className="border border-gray-200 px-3 py-2 text-gray-900">{snapshot.questionId}</td>
                                <td className="border border-gray-200 px-3 py-2 text-gray-900">{snapshot.domain}</td>
                                <td className="border border-gray-200 px-3 py-2 text-center font-medium text-gray-900">{snapshot.score}/5</td>
                                <td className={`border border-gray-200 px-3 py-2 text-center font-medium capitalize ${getSentimentColor(snapshot.voiceSentiment)}`}>
                                    {snapshot.voiceSentiment}
                                </td>
                                <td className="border border-gray-200 px-3 py-2 text-center">
                                    <span className={snapshot.blinkRateChange >= 0 ? "font-medium text-green-700" : "font-medium text-red-700"}>
                                        {snapshot.blinkRateChange >= 0 ? "+" : ""}{snapshot.blinkRateChange.toFixed(1)}%
                                    </span>
                                </td>
                                <td className={`border border-gray-200 px-3 py-2 text-center font-medium ${getStressColor(snapshot.blinkRateChange)}`}>
                                    {getStressLevel(snapshot.blinkRateChange)}
                                </td>
                                <td className="border border-gray-200 px-3 py-2 text-center text-gray-900">{snapshot.faceEmotion}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <p className="mb-6 text-xs text-gray-400">
                Note: This is a demonstration only. Results should be validated by a healthcare professional.
            </p>

            {/* ── Generate AI Report button ─────────────────────────── */}
            <div className="mb-6 border-t border-gray-200 pt-6">
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
                    <p className="mt-2 text-center text-xs text-gray-400">
                        Generates a consultative report from your organisation's knowledge base with evidence-based citations.
                    </p>
                )}
            </div>

            {/* ── Section 2: AI Consultative Report (SSOT) ─────────── */}
            {/* Query sent to Mithra — shown as soon as it comes back from the server */}
            {ssotQuery && (
                <div className="mb-4 rounded-lg border border-slate-600 bg-slate-800 p-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Query sent to Knowledge Base
                    </p>
                    <p className="text-sm italic leading-relaxed text-slate-300">{ssotQuery}</p>
                </div>
            )}

            {ssotError && (
                <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-red-700">
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                    <span className="text-sm">{ssotError}</span>
                </div>
            )}

            {ssotReport && (
                <div className="rounded-xl border border-blue-700 bg-slate-900 p-5">
                    <div className="mb-3 flex items-center gap-2">
                        <BookOpen className="h-5 w-5 text-blue-400" />
                        <h3 className="text-base font-semibold text-white">AI Consultative Report</h3>
                        <span className="ml-auto rounded-full bg-blue-900/50 px-2 py-0.5 text-xs font-medium text-blue-300">
                            SSOT · Evidence-based
                        </span>
                    </div>

                    <p className="whitespace-pre-line text-sm leading-relaxed text-slate-200">
                        {ssotReport.answer}
                    </p>

                    {ssotReport.citations.length > 0 && (
                        <div className="mt-4 border-t border-slate-700 pt-3">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                                Citations
                            </p>
                            <ul className="space-y-1.5">
                                {ssotReport.citations.map((c, i) => (
                                    <li key={i} className="flex items-start gap-2 text-xs text-slate-300">
                                        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-blue-400" />
                                        <span>
                                            <span className="font-medium text-blue-300">{c.paperTitle}</span>
                                            {c.paperPage > 0 && (
                                                <span className="ml-1 text-slate-500">— p.&nbsp;{c.paperPage}</span>
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
