import { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronUp, Loader2, AlertCircle, BookOpen, ClipboardList, ExternalLink, RefreshCw } from "lucide-react";
import { SurveyRecord } from "@/types";
import { apiFetch } from "@/lib/api";
import { Markdown } from "@/components/ui/markdown";
import { PILL, BANNER, TEXT_TONE, riskTone, sentimentTone } from "@/lib/badges";

function fmt(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
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
            <div className="flex items-start gap-2 rounded-lg border border-dashed border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4 text-sm text-[color:var(--ciq-text-muted)]">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ciq-text-faint)]" />
                AI report was not generated for this session.
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Consultative agent response */}
            {info.agentResponse && (
                <div className="rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-accent-purple)]">Consultative Response</p>
                    <Markdown>{info.agentResponse}</Markdown>
                </div>
            )}

            {/* SSoT / KB report */}
            {ssot && "error" in ssot && (
                <div className={`flex items-start gap-2 rounded-lg p-4 text-sm ${BANNER.amber}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        <strong>KB Report failed:</strong> {ssot.error}
                    </span>
                </div>
            )}

            {ssot && "answer" in ssot && ssot.answer && (
                <div className="rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4">
                    <div className="mb-2 flex items-center gap-1.5">
                        <BookOpen className="h-4 w-4 text-[color:var(--ciq-accent-blue)]" />
                        <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-accent-blue)]">AI Consultative Report</p>
                    </div>
                    <Markdown>{ssot.answer}</Markdown>

                    {ssot.citations.length > 0 && (
                        <div className="mt-3 border-t border-[color:var(--ciq-line)] pt-3">
                            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">References</p>
                            <ul className="space-y-1">
                                {ssot.citations.map((c, i) => (
                                    <li key={i} className="flex items-center gap-1.5 text-xs text-[color:var(--ciq-accent-blue)]">
                                        <ExternalLink className="h-3 w-3 shrink-0" />
                                        {c.paperTitle}
                                        {c.paperPage > 0 && <span className="text-[color:var(--ciq-text-muted)]">p.{c.paperPage}</span>}
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

function SessionCard({ session }: { session: SurveyRecord }) {
    const [expanded, setExpanded] = useState(false);
    const report = session.technical_report;
    const survey = session.survey_results;
    const info = session.prompt_info;

    return (
        <div className="overflow-hidden rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] shadow-sm">
            {/* Card header — always visible */}
            <button
                className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[color:var(--ciq-card-2)]"
                onClick={() => setExpanded(v => !v)}
            >
                <div className="flex items-center gap-4">
                    <div>
                        <p className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">{fmt(session.created_at)}</p>
                        <p className="mt-0.5 text-xs text-[color:var(--ciq-text-faint)]">
                            {session.survey_type ? `${session.survey_type} · ` : ""}Run {session.survey_run_id.slice(0, 8)}…
                        </p>
                    </div>
                    {report?.sections ? (
                        <>
                            {report.sections.map(s => (
                                <span key={s.id} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${PILL[riskTone(s.riskLevel)]}`}>
                                    {s.label}: {s.score} ({s.riskLevel})
                                </span>
                            ))}
                        </>
                    ) : (
                        report && (
                            <>
                                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${PILL[riskTone(report.riskLevel ?? "Low")]}`}>
                                    {report.riskLevel} Risk
                                </span>
                                <span className="text-sm font-medium text-[color:var(--ciq-text-body)]">
                                    Score: <strong className="font-data">{report.totalScore}</strong>
                                </span>
                            </>
                        )
                    )}
                    {info?.ssotReport && !("error" in info.ssotReport) && info.ssotReport.answer && (
                        <span className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${PILL.blue}`}>
                            <BookOpen className="h-3 w-3" /> AI Report
                        </span>
                    )}
                </div>
                {expanded ? (
                    <ChevronUp className="h-4 w-4 text-[color:var(--ciq-text-faint)]" />
                ) : (
                    <ChevronDown className="h-4 w-4 text-[color:var(--ciq-text-faint)]" />
                )}
            </button>

            {/* Expanded detail */}
            {expanded && (
                <div className="space-y-6 border-t border-[color:var(--ciq-line)] px-5 py-5">
                    {/* Technical summary */}
                    {report && (
                        <div className="rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-accent-purple)]">Burnout Summary</p>
                            {report.sections ? (
                                // Independent subscales (e.g. PILOT's BAT-4 / CBI-WRB3) — never blended
                                // into one score, each gets its own score/risk/interpretation.
                                <div className="space-y-2">
                                    {report.sections.map(s => (
                                        <div key={s.id} className="flex flex-wrap items-center gap-3 text-sm">
                                            <span className="font-semibold text-[color:var(--ciq-text-strong)]">{s.label}</span>
                                            <strong className="font-data text-[color:var(--ciq-text-strong)]">
                                                {s.score} / {s.scoreRange[1]}
                                            </strong>
                                            <span className={`font-semibold ${TEXT_TONE[riskTone(s.riskLevel)]}`}>{s.riskLevel}</span>
                                            <span className="text-[color:var(--ciq-text-muted)]">{s.interpretation}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex flex-wrap gap-6 text-sm">
                                    <div>
                                        <span className="text-[color:var(--ciq-text-muted)]">Total Score </span>
                                        <strong className="font-data text-[color:var(--ciq-text-strong)]">{report.totalScore}</strong>
                                    </div>
                                    <div>
                                        <span className="text-[color:var(--ciq-text-muted)]">Risk Level </span>
                                        <span className={`font-semibold ${TEXT_TONE[riskTone(report.riskLevel ?? "Low")]}`}>{report.riskLevel}</span>
                                    </div>
                                </div>
                            )}
                            {Object.keys(report.domainTotals).length > 0 && (
                                <div className="mt-3 flex flex-wrap gap-3">
                                    {Object.entries(report.domainTotals).map(([domain, score]) => (
                                        <span key={domain} className={`rounded-full px-2.5 py-0.5 text-xs ${PILL.purple}`}>
                                            {domain}: <span className="font-data">{score}</span>
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
                                <ClipboardList className="h-4 w-4 text-[color:var(--ciq-text-muted)]" />
                                <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">Survey Results</p>
                            </div>
                            <div className="overflow-x-auto rounded-lg border border-[color:var(--ciq-line)]">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="bg-[color:var(--ciq-card-2)] text-xs font-medium uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                                            <th className="px-3 py-2 text-left">Domain</th>
                                            <th className="px-3 py-2 text-center">Score</th>
                                            <th className="hidden px-3 py-2 text-left sm:table-cell">Voice</th>
                                            <th className="hidden px-3 py-2 text-left md:table-cell">Blink Δ</th>
                                            <th className="hidden px-3 py-2 text-left md:table-cell">Left Gaze</th>
                                            <th className="hidden px-3 py-2 text-left md:table-cell">Right Gaze</th>
                                            <th className="hidden px-3 py-2 text-left lg:table-cell">Response Latency</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {Object.entries(survey).map(([qid, r], i) => (
                                            <tr key={qid} className={i % 2 === 0 ? "bg-[color:var(--ciq-card)]" : "bg-[color:var(--ciq-card-2)]"}>
                                                <td className="px-3 py-2 font-medium text-[color:var(--ciq-text-strong)]">{r.domain || qid}</td>
                                                <td className="font-data px-3 py-2 text-center font-semibold text-[color:var(--ciq-text-strong)]">{r.score}</td>
                                                <td className={`hidden px-3 py-2 capitalize sm:table-cell ${TEXT_TONE[sentimentTone(r.voiceSentiment)]}`}>
                                                    {r.voiceSentiment}
                                                </td>
                                                <td className="hidden px-3 py-2 md:table-cell">
                                                    <span
                                                        className={`font-data ${r.blinkRateChange >= 0 ? "text-[color:var(--ciq-accent-red)]" : "text-[color:var(--ciq-accent-green)]"}`}
                                                    >
                                                        {r.blinkRateChange >= 0 ? "+" : ""}
                                                        {r.blinkRateChange.toFixed(1)}%
                                                    </span>
                                                </td>
                                                <td className="hidden px-3 py-2 text-[color:var(--ciq-text-body)] md:table-cell">{r.leftGazePosition || "—"}</td>
                                                <td className="hidden px-3 py-2 text-[color:var(--ciq-text-body)] md:table-cell">{r.rightGazePosition || "—"}</td>
                                                <td className="hidden px-3 py-2 text-[color:var(--ciq-text-body)] lg:table-cell">
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
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">AI Generated Report</p>
                        <AIReportSection info={info ?? {}} />
                    </div>
                </div>
            )}
        </div>
    );
}

export function UserHistory() {
    const [sessions, setSessions] = useState<SurveyRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchSessions = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await apiFetch("/api/history");
            if (!res.ok) {
                const msg =
                    res.status === 401
                        ? "Your session could not be verified. Try refreshing, or sign out and sign in again."
                        : `Failed to load history (HTTP ${res.status}). Please retry.`;
                setError(msg);
                return;
            }
            const data = await res.json();
            setSessions(data.records);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load history.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSessions();
    }, [fetchSessions]);

    return (
        <div>
            <div className="mb-5 flex items-center justify-between">
                <div>
                    <h2 className="font-display text-xl font-bold text-[color:var(--ciq-text-strong)]">Session History</h2>
                    <p className="text-sm text-[color:var(--ciq-text-muted)]">Your completed burnout assessments</p>
                </div>
                <button
                    onClick={fetchSessions}
                    disabled={loading}
                    className="flex items-center gap-1.5 rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] px-3 py-2 text-sm font-medium text-[color:var(--ciq-text-body)] shadow-sm transition-colors hover:bg-[color:var(--ciq-card-2)] disabled:opacity-50"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                    Refresh
                </button>
            </div>

            {loading && sessions.length === 0 && (
                <div className="flex items-center justify-center py-16 text-[color:var(--ciq-text-faint)]">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Loading history…
                </div>
            )}

            {error && (
                <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${BANNER.red}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            {!loading && !error && sessions.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[color:var(--ciq-line)] py-20 text-center">
                    <ClipboardList className="mb-3 h-10 w-10 text-[color:var(--ciq-text-faint)]" />
                    <p className="font-medium text-[color:var(--ciq-text-muted)]">No sessions yet</p>
                    <p className="mt-1 text-sm text-[color:var(--ciq-text-faint)]">Complete a survey to see your history here.</p>
                </div>
            )}

            {sessions.length > 0 && (
                <div className="space-y-3">
                    {sessions.map(s => (
                        <SessionCard key={s.survey_run_id} session={s} />
                    ))}
                </div>
            )}
        </div>
    );
}
