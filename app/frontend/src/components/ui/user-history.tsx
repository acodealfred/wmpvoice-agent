import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronUp, Loader2, AlertCircle, BookOpen, ClipboardList, ExternalLink, RefreshCw } from "lucide-react";
import { UserSession } from "@/types";

function riskColor(risk: string) {
    if (risk === "Low") return "bg-green-100 text-green-800";
    if (risk === "Moderate") return "bg-amber-100 text-amber-800";
    return "bg-red-100 text-red-800";
}

function sentimentColor(s: string) {
    if (s === "positive") return "text-green-600";
    if (s === "negative") return "text-red-600";
    return "text-amber-600";
}

function fmt(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

interface SsotSection {
    ssotReport?: { answer: string; citations: Array<{ paperId: string; paperTitle: string; paperPage: number }> } | { error: string };
    agentResponse?: string;
}

function AIReportSection({ info }: { info: SsotSection }) {
    const ssot = info.ssotReport;

    if (!ssot && !info.agentResponse) {
        return (
            <div className="flex items-start gap-2 rounded-lg border border-dashed border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                AI report was not generated for this session.
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Consultative agent response */}
            {info.agentResponse && (
                <div className="rounded-lg border border-purple-100 bg-purple-50 p-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-purple-600">
                        Consultative Response
                    </p>
                    <p className="whitespace-pre-wrap text-sm text-gray-800">{info.agentResponse}</p>
                </div>
            )}

            {/* SSoT / KB report */}
            {ssot && "error" in ssot && (
                <div className="flex items-start gap-2 rounded-lg border border-dashed border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span><strong>KB Report failed:</strong> {ssot.error}</span>
                </div>
            )}

            {ssot && "answer" in ssot && ssot.answer && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
                    <div className="mb-2 flex items-center gap-1.5">
                        <BookOpen className="h-4 w-4 text-blue-600" />
                        <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
                            AI Consultative Report
                        </p>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-gray-800">{ssot.answer}</p>

                    {ssot.citations.length > 0 && (
                        <div className="mt-3 border-t border-blue-100 pt-3">
                            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-blue-500">
                                References
                            </p>
                            <ul className="space-y-1">
                                {ssot.citations.map((c, i) => (
                                    <li key={i} className="flex items-center gap-1.5 text-xs text-blue-700">
                                        <ExternalLink className="h-3 w-3 shrink-0" />
                                        {c.paperTitle}
                                        {c.paperPage > 0 && (
                                            <span className="text-blue-400">p.{c.paperPage}</span>
                                        )}
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

function SessionCard({ session }: { session: UserSession }) {
    const [expanded, setExpanded] = useState(false);
    const report = session.technical_report;
    const survey = session.survey_results;
    const info = session.prompt_info;

    return (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            {/* Card header — always visible */}
            <button
                className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-gray-50"
                onClick={() => setExpanded(v => !v)}
            >
                <div className="flex items-center gap-4">
                    <div>
                        <p className="text-sm font-semibold text-gray-900">{fmt(session.created_at)}</p>
                        <p className="mt-0.5 text-xs text-gray-400">Session {session.session_id.slice(0, 8)}…</p>
                    </div>
                    {report && (
                        <>
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${riskColor(report.riskLevel)}`}>
                                {report.riskLevel} Risk
                            </span>
                            <span className="text-sm font-medium text-gray-700">
                                Score: <strong>{report.totalScore}</strong>
                            </span>
                        </>
                    )}
                    {info?.ssotReport && !("error" in info.ssotReport) && info.ssotReport.answer && (
                        <span className="flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-600">
                            <BookOpen className="h-3 w-3" /> AI Report
                        </span>
                    )}
                </div>
                {expanded
                    ? <ChevronUp className="h-4 w-4 text-gray-400" />
                    : <ChevronDown className="h-4 w-4 text-gray-400" />
                }
            </button>

            {/* Expanded detail */}
            {expanded && (
                <div className="border-t border-gray-100 px-5 py-5 space-y-6">

                    {/* Technical summary */}
                    {report && (
                        <div className="rounded-lg bg-purple-50 p-4">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-purple-600">
                                Burnout Summary
                            </p>
                            <div className="flex flex-wrap gap-6 text-sm">
                                <div>
                                    <span className="text-gray-500">Total Score </span>
                                    <strong className="text-gray-900">{report.totalScore}</strong>
                                </div>
                                <div>
                                    <span className="text-gray-500">Risk Level </span>
                                    <span className={`font-semibold ${
                                        report.riskLevel === "Low" ? "text-green-700"
                                        : report.riskLevel === "Moderate" ? "text-amber-700"
                                        : "text-red-700"
                                    }`}>{report.riskLevel}</span>
                                </div>
                            </div>
                            {Object.keys(report.domainTotals).length > 0 && (
                                <div className="mt-3 flex flex-wrap gap-3">
                                    {Object.entries(report.domainTotals).map(([domain, score]) => (
                                        <span key={domain} className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs text-purple-800">
                                            {domain}: {score}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Survey results table */}
                    {survey && Object.keys(survey).length > 0 && (
                        <div>
                            <div className="mb-2 flex items-center gap-1.5">
                                <ClipboardList className="h-4 w-4 text-gray-500" />
                                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                                    Survey Results
                                </p>
                            </div>
                            <div className="overflow-x-auto rounded-lg border border-gray-200">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                                            <th className="px-3 py-2 text-left">Domain</th>
                                            <th className="px-3 py-2 text-center">Score</th>
                                            <th className="hidden px-3 py-2 text-left sm:table-cell">Voice</th>
                                            <th className="hidden px-3 py-2 text-left md:table-cell">Blink Δ</th>
                                            <th className="hidden px-3 py-2 text-left md:table-cell">Gaze Position</th>
                                            <th className="hidden px-3 py-2 text-left lg:table-cell">Response Latency</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {Object.entries(survey).map(([qid, r], i) => (
                                            <tr key={qid} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                                <td className="px-3 py-2 font-medium text-gray-800">{r.domain || qid}</td>
                                                <td className="px-3 py-2 text-center font-semibold text-gray-900">{r.score}</td>
                                                <td className={`hidden px-3 py-2 capitalize sm:table-cell ${sentimentColor(r.voiceSentiment)}`}>
                                                    {r.voiceSentiment}
                                                </td>
                                                <td className="hidden px-3 py-2 md:table-cell">
                                                    <span className={r.blinkRateChange >= 0 ? "text-red-600" : "text-green-600"}>
                                                        {r.blinkRateChange >= 0 ? "+" : ""}{r.blinkRateChange.toFixed(1)}%
                                                    </span>
                                                </td>
                                                <td className="hidden px-3 py-2 text-gray-600 md:table-cell">
                                                    {r.gazePosition || "—"}
                                                </td>
                                                <td className="hidden px-3 py-2 text-gray-600 lg:table-cell">
                                                    {r.responseLatencyMs != null ? `${(r.responseLatencyMs / 1000).toFixed(1)}s` : "—"}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* AI report section */}
                    <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                            AI Generated Report
                        </p>
                        <AIReportSection info={info ?? {}} />
                    </div>
                </div>
            )}
        </div>
    );
}

export function UserHistory() {
    const [sessions, setSessions] = useState<UserSession[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchSessions = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/history", { credentials: "same-origin" });
            if (!res.ok) {
                const msg = res.status === 401
                    ? "Your session could not be verified. Try refreshing, or sign out and sign in again."
                    : `Failed to load history (HTTP ${res.status}). Please retry.`;
                setError(msg);
                return;
            }
            const data = await res.json();
            setSessions(data.sessions);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load history.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchSessions(); }, [fetchSessions]);

    return (
        <div className="p-6">
            <div className="mb-5 flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-bold text-gray-900">Session History</h2>
                    <p className="text-sm text-gray-500">Your completed burnout assessments</p>
                </div>
                <button
                    onClick={fetchSessions}
                    disabled={loading}
                    className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-50"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                    Refresh
                </button>
            </div>

            {loading && sessions.length === 0 && (
                <div className="flex items-center justify-center py-16 text-gray-400">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Loading history…
                </div>
            )}

            {error && (
                <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            {!loading && !error && sessions.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 py-20 text-center">
                    <ClipboardList className="mb-3 h-10 w-10 text-gray-300" />
                    <p className="font-medium text-gray-500">No sessions yet</p>
                    <p className="mt-1 text-sm text-gray-400">
                        Complete a survey to see your history here.
                    </p>
                </div>
            )}

            {sessions.length > 0 && (
                <div className="space-y-3">
                    {sessions.map(s => (
                        <SessionCard key={s.session_token} session={s} />
                    ))}
                </div>
            )}
        </div>
    );
}
