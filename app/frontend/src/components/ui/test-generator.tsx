import { useState } from "react";
import { BiometricSnapshot, SSoTReport } from "@/types";
import {
    Sparkles, BookOpen, ExternalLink, AlertCircle,
    Loader2, ChevronRight, ChevronLeft, RefreshCw, FlaskConical,
} from "lucide-react";

// ── Internal types ─────────────────────────────────────────────────────────

type RiskLevel = "high" | "moderate" | "low";

type TestScenario = {
    label: string;
    riskLevel: RiskLevel;
    primaryDomains: string[];
    snapshots: BiometricSnapshot[];
    previewQuery: string;
};

// ── Static domain list (mirrors rtmt.py enable_survey) ────────────────────

const DOMAINS: { id: string; domain: string }[] = [
    { id: "q1", domain: "Emotional Exhaustion" },
    { id: "q2", domain: "Depersonalization" },
    { id: "q3", domain: "Personal Accomplishment" },
    { id: "q4", domain: "Physical Exhaustion" },
    { id: "q5", domain: "Job Satisfaction" },
];

// All unique pairs of 2 domains (10 combinations of 5C2)
const DOMAIN_PAIRS: [string, string][] = (() => {
    const pairs: [string, string][] = [];
    for (let i = 0; i < DOMAINS.length; i++) {
        for (let j = i + 1; j < DOMAINS.length; j++) {
            pairs.push([DOMAINS[i].domain, DOMAINS[j].domain]);
        }
    }
    return pairs;
})();

const RISK_CYCLE: RiskLevel[] = ["high", "moderate", "low"];

const RISK_LABELS: Record<RiskLevel, string> = {
    high: "High burnout risk",
    moderate: "Moderate burnout risk",
    low: "Low burnout risk",
};

// ── Score assignment per risk level ───────────────────────────────────────
// Primary domain gets the higher score, others get the lower score.
// Totals: high ≈ 22–23, moderate ≈ 17, low ≈ 7
const SCORES: Record<RiskLevel, { primary: number; other: number }> = {
    high:     { primary: 5, other: 4 },
    moderate: { primary: 4, other: 3 },
    low:      { primary: 2, other: 1 },
};

// ── Query template (mirrors generate_ssot_report in app.py) ───────────────
function buildQuery(snapshots: BiometricSnapshot[], riskLevel: RiskLevel): string {
    const total = snapshots.reduce((s, q) => s + q.score, 0);
    const max = snapshots.length * 5;
    const interpretation = RISK_LABELS[riskLevel];
    const domainTotals: Record<string, number> = {};
    for (const s of snapshots) {
        domainTotals[s.domain] = (domainTotals[s.domain] ?? 0) + s.score;
    }
    const top3 = Object.entries(domainTotals)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([name, score]) => `${name} (${score} pts)`)
        .join(", ");
    return (
        `Write a consultative wellbeing report for an employee who completed a burnout ` +
        `assessment with a total score of ${total} out of ${max}, indicating ${interpretation}. ` +
        `The primary contributing factors are: ${top3}. ` +
        `Provide evidence-based recommendations, support strategies, and actionable next ` +
        `steps to address these specific burnout indicators.`
    );
}

// ── Scenario generator ─────────────────────────────────────────────────────
function generateScenarios(count: number): TestScenario[] {
    const results: TestScenario[] = [];
    for (let i = 0; i < count; i++) {
        const risk = RISK_CYCLE[i % RISK_CYCLE.length];
        const [domA, domB] = DOMAIN_PAIRS[i % DOMAIN_PAIRS.length];
        const { primary, other } = SCORES[risk];
        const primaryDomains = [domA, domB];

        const snapshots: BiometricSnapshot[] = DOMAINS.map(q => ({
            questionId: q.id,
            domain: q.domain,
            score: primaryDomains.includes(q.domain) ? primary : other,
            voiceSentiment: risk === "high" ? "negative" : risk === "moderate" ? "neutral" : "positive",
            blinkRateChange: risk === "high" ? 35 : risk === "moderate" ? 10 : -10,
            faceEmotion: risk === "high" ? "SAD" : risk === "moderate" ? "NEUTRAL" : "HAPPY",
        }));

        results.push({
            label: `${risk.charAt(0).toUpperCase() + risk.slice(1)} burnout — ${domA} & ${domB}`,
            riskLevel: risk,
            primaryDomains,
            snapshots,
            previewQuery: buildQuery(snapshots, risk),
        });
    }
    return results;
}

// ── Risk level badge colours ───────────────────────────────────────────────
const RISK_COLOURS: Record<RiskLevel, string> = {
    high:     "bg-red-900/50 text-red-300 border-red-700",
    moderate: "bg-yellow-900/50 text-yellow-300 border-yellow-700",
    low:      "bg-green-900/50 text-green-300 border-green-700",
};

// ── Component ──────────────────────────────────────────────────────────────

export function TestGenerator() {
    const [testCount, setTestCount] = useState(3);
    const [scenarios, setScenarios] = useState<TestScenario[]>([]);
    const [currentIdx, setCurrentIdx] = useState(0);
    const [editableQuery, setEditableQuery] = useState("");

    const [ssotLoading, setSsotLoading] = useState(false);
    const [ssotReport, setSsotReport] = useState<SSoTReport | null>(null);
    const [ssotError, setSsotError] = useState<string | null>(null);
    const [sentQuery, setSentQuery] = useState<string | null>(null);

    // ── Handlers ────────────────────────────────────────────────────────────

    const handleGenerate = () => {
        const generated = generateScenarios(testCount);
        setScenarios(generated);
        setCurrentIdx(0);
        setEditableQuery(generated[0].previewQuery);
        setSsotReport(null);
        setSsotError(null);
        setSentQuery(null);
    };

    const handleNext = () => {
        const next = currentIdx + 1;
        setCurrentIdx(next);
        setEditableQuery(scenarios[next].previewQuery);
        setSsotReport(null);
        setSsotError(null);
        setSentQuery(null);
    };

    const handleRegenerate = () => {
        setScenarios([]);
        setCurrentIdx(0);
        setSsotReport(null);
        setSsotError(null);
        setSentQuery(null);
    };

    const handleSendToSSoT = async () => {
        setSsotLoading(true);
        setSsotReport(null);
        setSsotError(null);
        setSentQuery(null);

        const payload = {
            snapshots: scenarios[currentIdx].snapshots,
            session_id: "",
            query_override: editableQuery.trim() || scenarios[currentIdx].previewQuery,
        };

        console.group("[TestGen] Send to SSOT");
        console.log("→ POST /ssot-report", payload);

        try {
            const resp = await fetch("/ssot-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await resp.json();
            console.log(`← HTTP ${resp.status}`, data);
            console.groupEnd();

            if (!resp.ok) {
                setSsotError(data.error ?? `HTTP ${resp.status}`);
                return;
            }
            if (data.query) setSentQuery(data.query);
            if (data.ssotReport?.answer) setSsotReport(data.ssotReport);
            else setSsotError("No report returned. Check KB documents and token.");
        } catch (err) {
            console.error("[TestGen] Error", err);
            console.groupEnd();
            setSsotError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setSsotLoading(false);
        }
    };

    const scenario = scenarios[currentIdx] ?? null;

    // ── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="space-y-6 p-6">

            {/* ── Header ── */}
            <div className="flex items-center gap-3">
                <FlaskConical className="h-6 w-6 text-purple-400" />
                <div>
                    <h2 className="text-lg font-semibold text-white">SSOT Test Generator</h2>
                    <p className="text-xs text-slate-400">
                        Generate synthetic burnout scenarios and test the Knowledge Base integration without running the survey.
                    </p>
                </div>
            </div>

            {/* ── Config panel (shown before generating) ── */}
            {scenarios.length === 0 && (
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                    <label className="mb-3 block text-sm font-medium text-slate-300">
                        Number of test cases:&nbsp;
                        <span className="font-bold text-purple-400">{testCount}</span>
                    </label>
                    <input
                        type="range"
                        min={1}
                        max={10}
                        value={testCount}
                        onChange={e => setTestCount(Number(e.target.value))}
                        className="mb-4 w-full accent-purple-500"
                    />
                    <div className="flex items-center justify-between text-xs text-slate-500 mb-4">
                        <span>1</span><span>10</span>
                    </div>
                    <button
                        onClick={handleGenerate}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-3 text-sm font-semibold text-white hover:from-purple-700 hover:to-blue-700"
                    >
                        <Sparkles className="h-4 w-4" />
                        Generate Test Cases
                    </button>
                </div>
            )}

            {/* ── Scenario navigator ── */}
            {scenario && (
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">

                    {/* Counter + label */}
                    <div className="mb-3 flex items-center gap-3">
                        <span className="rounded-full bg-purple-900/50 px-3 py-0.5 text-xs font-medium text-purple-300">
                            Scenario {currentIdx + 1} of {scenarios.length}
                        </span>
                        <span className={`rounded-full border px-3 py-0.5 text-xs font-medium ${RISK_COLOURS[scenario.riskLevel]}`}>
                            {scenario.riskLevel.toUpperCase()}
                        </span>
                    </div>

                    <p className="mb-4 text-sm font-semibold text-white">{scenario.label}</p>

                    {/* Snapshot table */}
                    <div className="mb-4 overflow-x-auto rounded-lg">
                        <table className="w-full border-collapse text-xs">
                            <thead>
                                <tr className="bg-slate-800">
                                    <th className="border border-slate-700 px-3 py-2 text-left text-slate-300">Domain</th>
                                    <th className="border border-slate-700 px-3 py-2 text-center text-slate-300">Score</th>
                                    <th className="border border-slate-700 px-3 py-2 text-center text-slate-300">Sentiment</th>
                                    <th className="border border-slate-700 px-3 py-2 text-center text-slate-300">Emotion</th>
                                </tr>
                            </thead>
                            <tbody>
                                {scenario.snapshots.map((s, i) => (
                                    <tr key={s.questionId} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-800/50"}>
                                        <td className="border border-slate-700 px-3 py-1.5 text-slate-200">
                                            {s.domain}
                                            {scenario.primaryDomains.includes(s.domain) && (
                                                <span className="ml-2 rounded bg-purple-900/50 px-1 py-0.5 text-[10px] text-purple-300">primary</span>
                                            )}
                                        </td>
                                        <td className="border border-slate-700 px-3 py-1.5 text-center font-semibold text-white">{s.score}/5</td>
                                        <td className="border border-slate-700 px-3 py-1.5 text-center capitalize text-slate-300">{s.voiceSentiment}</td>
                                        <td className="border border-slate-700 px-3 py-1.5 text-center text-slate-300">{s.faceEmotion}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Nav buttons */}
                    <div className="flex gap-2">
                        <button
                            onClick={handleRegenerate}
                            className="flex items-center gap-1 rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                        >
                            <RefreshCw className="h-3 w-3" />
                            Regenerate
                        </button>
                        <button
                            onClick={handleNext}
                            disabled={currentIdx >= scenarios.length - 1}
                            className="ml-auto flex items-center gap-1 rounded-lg bg-slate-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            Next
                            <ChevronRight className="h-3 w-3" />
                        </button>
                    </div>
                </div>
            )}

            {/* ── Query editor ── */}
            {scenario && (
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                    <div className="mb-2 flex items-center justify-between">
                        <p className="text-sm font-semibold text-slate-200">Mithra Query — Edit before sending</p>
                        <button
                            onClick={() => setEditableQuery(scenario.previewQuery)}
                            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
                        >
                            <ChevronLeft className="h-3 w-3" />
                            Reset to default
                        </button>
                    </div>
                    <textarea
                        value={editableQuery}
                        onChange={e => setEditableQuery(e.target.value)}
                        rows={5}
                        className="w-full resize-y rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm leading-relaxed text-slate-200 focus:border-purple-500 focus:outline-none"
                    />
                    <p className="mt-1 text-xs text-slate-500">You may freely edit this query before sending it to the Knowledge Base.</p>

                    <button
                        onClick={handleSendToSSoT}
                        disabled={ssotLoading || !editableQuery.trim()}
                        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white shadow-md hover:from-blue-700 hover:to-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {ssotLoading ? (
                            <><Loader2 className="h-4 w-4 animate-spin" /> Generating Report…</>
                        ) : (
                            <><Sparkles className="h-4 w-4" /> Send to SSOT API</>
                        )}
                    </button>
                </div>
            )}

            {/* ── Error ── */}
            {ssotError && (
                <div className="flex items-start gap-2 rounded-lg bg-red-900/30 p-3 text-red-300">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="text-sm">{ssotError}</span>
                </div>
            )}

            {/* ── SSOT report ── */}
            {ssotReport && (
                <div className="rounded-xl border border-blue-700 bg-slate-900 p-5">
                    <div className="mb-3 flex items-center gap-2">
                        <BookOpen className="h-5 w-5 text-blue-400" />
                        <h3 className="text-base font-semibold text-white">AI Consultative Report</h3>
                        <span className="ml-auto rounded-full bg-blue-900/50 px-2 py-0.5 text-xs font-medium text-blue-300">
                            SSOT · Evidence-based
                        </span>
                    </div>

                    {/* Show the actual query sent (may differ from the edited one if backend templated) */}
                    {sentQuery && sentQuery !== editableQuery && (
                        <div className="mb-3 rounded-lg border border-slate-600 bg-slate-800 p-3">
                            <p className="mb-1 text-xs font-semibold text-slate-400">Query sent to KB</p>
                            <p className="text-xs italic text-slate-300">{sentQuery}</p>
                        </div>
                    )}

                    <p className="whitespace-pre-line text-sm leading-relaxed text-slate-200">{ssotReport.answer}</p>

                    {ssotReport.citations.length > 0 && (
                        <div className="mt-4 border-t border-slate-700 pt-3">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Citations</p>
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
