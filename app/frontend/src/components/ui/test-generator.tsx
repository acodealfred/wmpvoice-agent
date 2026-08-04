import { useState, useRef, useEffect } from "react";
import { BiometricSnapshot, SSoTReport, Citation } from "@/types";
import { Markdown } from "@/components/ui/markdown";
import { PILL, BANNER, TEXT_TONE, Tone } from "@/lib/badges";
import {
    Sparkles,
    BookOpen,
    ExternalLink,
    AlertCircle,
    Loader2,
    ChevronRight,
    ChevronLeft,
    RefreshCw,
    FlaskConical,
    MessageCircle,
    Send,
    PlusCircle
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
    { id: "q5", domain: "Job Satisfaction" }
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
    low: "Low burnout risk"
};

// ── Score assignment per risk level ───────────────────────────────────────
// Primary domain gets the higher score, others get the lower score.
// Totals: high ≈ 22–23, moderate ≈ 17, low ≈ 7
const SCORES: Record<RiskLevel, { primary: number; other: number }> = {
    high: { primary: 5, other: 4 },
    moderate: { primary: 4, other: 3 },
    low: { primary: 2, other: 1 }
};

// ── Query template (mirrors generate_ssot_report in app.py) ───────────────
function buildQuery(snapshots: BiometricSnapshot[], riskLevel: RiskLevel): string {
    const interpretation = RISK_LABELS[riskLevel];
    const domainTotals: Record<string, number> = {};
    for (const s of snapshots) {
        domainTotals[s.domain] = (domainTotals[s.domain] ?? 0) + s.score;
    }
    const top2 = Object.entries(domainTotals)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([name]) => name)
        .join(" and ");
    return `What are the root cause and recommendation for a person suffering with ${interpretation} caused by ${top2}.`;
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
            leftGazePosition: risk === "high" ? "Down" : risk === "moderate" ? "Center" : "Center",
            rightGazePosition: risk === "high" ? "Down" : risk === "moderate" ? "Center" : "Center"
        }));

        results.push({
            label: `${risk.charAt(0).toUpperCase() + risk.slice(1)} burnout — ${domA} & ${domB}`,
            riskLevel: risk,
            primaryDomains,
            snapshots,
            previewQuery: buildQuery(snapshots, risk)
        });
    }
    return results;
}

// ── Risk level badge tones (theme-aware) ───────────────────────────────────
const RISK_TONE: Record<RiskLevel, Tone> = { high: "red", moderate: "amber", low: "green" };

// ── ConsultativeReport: parses Mithra's ## markdown sections into panels ──────
//
// Mithra returns structured markdown like:
//   ## Root Causes of Burnout-Related Cynicism
//   ...
//   ## Recommendations for Addressing High Burnout Risk
//   ...
//
// We map headings that contain keywords to colour-coded panels.

type ReportPanel = { label: string; tone: Tone; body: string };

const SECTION_RULES: { keywords: string[]; label: string; tone: Tone }[] = [
    { keywords: ["root cause", "causes of"], label: "Root Cause", tone: "red" },
    { keywords: ["recommendation", "treating", "addressing", "prevention", "treatment"], label: "Recommendation", tone: "green" }
];

// Titles we accept as section boundaries when written colon-style ("Root Cause:")
// rather than as markdown "## Root Cause". The report LLM is prompted to emit the
// colon form ("General Case:", "Root Cause:", "Recommendation:"), so we must detect
// it too — but gate on known keywords so ordinary prose like "Note:" isn't split.
const SECTION_HEADING_KEYWORDS = [...SECTION_RULES.flatMap(r => r.keywords), "general case", "general"];

function isSectionHeadingTitle(title: string): boolean {
    const lower = title.toLowerCase();
    return SECTION_HEADING_KEYWORDS.some(k => lower.includes(k));
}

// Split a report into { title, body } sections, handling BOTH markdown "## Heading"
// and colon-style "Heading:" lines. Text before the first heading becomes a leading
// section with an empty title.
function splitReportSections(text: string): { title: string; body: string }[] {
    const sections: { title: string; body: string }[] = [];
    let current = { title: "", body: "" };
    const mdHeading = /^#{1,6}\s+(.+?)\s*$/;
    // Optional bold markers, a short title, then a colon, then optional inline body.
    const colonHeading = /^\s*\*{0,2}\s*([A-Za-z][A-Za-z /&'-]{1,38}?)\s*\*{0,2}\s*:\s*(.*?)\s*\**\s*$/;

    for (const line of text.split(/\r?\n/)) {
        const md = line.match(mdHeading);
        if (md) {
            sections.push(current);
            current = { title: md[1].trim(), body: "" };
            continue;
        }
        const colon = line.match(colonHeading);
        if (colon && isSectionHeadingTitle(colon[1])) {
            sections.push(current);
            current = { title: colon[1].trim(), body: colon[2].trim() };
            continue;
        }
        current.body += (current.body ? "\n" : "") + line;
    }
    sections.push(current);
    return sections.filter(s => s.title || s.body.trim());
}

function parseMithraSections(text: string): ReportPanel[] {
    const panels: ReportPanel[] = [];
    let generalBody = "";

    for (const { title, body } of splitReportSections(text)) {
        if (!title) {
            generalBody += body;
            continue;
        }
        const headingLower = title.toLowerCase();
        const rule = SECTION_RULES.find(r => r.keywords.some(k => headingLower.includes(k)));
        if (rule) {
            panels.push({ label: rule.label, tone: rule.tone, body: body.trim() });
        } else {
            // "General Case" (or any unmatched heading) — fold into the General Case panel.
            const chunk = headingLower.includes("general") ? body.trim() : `**${title}**\n${body.trim()}`;
            generalBody += (generalBody ? "\n\n" : "") + chunk;
        }
    }

    // Prepend General Case panel if there's introductory content
    if (generalBody.trim()) {
        panels.unshift({ label: "General Case", tone: "blue", body: generalBody.trim() });
    }

    return panels;
}

function ConsultativeReport({ answer, citations }: { answer: string; citations: Citation[] }) {
    const panels = parseMithraSections(answer);

    return (
        <div className="space-y-3">
            {panels.length > 0 ? (
                panels.map((p, i) => (
                    <div
                        key={i}
                        className="rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] px-4 py-3"
                        style={{ borderLeft: `3px solid var(--ciq-accent-${p.tone === "neutral" ? "purple" : p.tone})` }}
                    >
                        <p className={`mb-1.5 text-xs font-bold uppercase tracking-wide ${TEXT_TONE[p.tone]}`}>{p.label}</p>
                        <Markdown>{p.body}</Markdown>
                    </div>
                ))
            ) : (
                <Markdown>{answer}</Markdown>
            )}

            {citations.length > 0 && (
                <div className="border-t border-[color:var(--ciq-line)] pt-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">Citations</p>
                    <ul className="space-y-1.5">
                        {citations.map((c, i) => (
                            <li key={i} className="flex items-start gap-2 text-xs text-[color:var(--ciq-text-body)]">
                                <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--ciq-accent-blue)]" />
                                <span>
                                    <span className="font-medium text-[color:var(--ciq-accent-blue)]">{c.paperTitle}</span>
                                    {c.paperPage > 0 && <span className="ml-1 text-[color:var(--ciq-text-muted)]">— p.&nbsp;{c.paperPage}</span>}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

// ── Component ──────────────────────────────────────────────────────────────

export function TestGenerator() {
    const [testCount, setTestCount] = useState(3);
    const [scenarios, setScenarios] = useState<TestScenario[]>([]);
    const [currentIdx, setCurrentIdx] = useState(0);
    const [editableQuery, setEditableQuery] = useState("");

    const [ssotLoading, setSsotLoading] = useState(false);
    const [ssotReport, setSsotReport] = useState<SSoTReport | null>(null);
    const [ssotError, setSsotError] = useState<string | null>(null);
    const [mithraRaw, setMithraRaw] = useState<SSoTReport | null>(null);
    const [llmUsed, setLlmUsed] = useState<boolean | null>(null);

    // ── Chat state ───────────────────────────────────────────────────────────
    type ChatMsg = { role: "user" | "assistant"; content: string; citations: Citation[] };
    const [chatId, setChatId] = useState<string | null>(null);
    const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
    const [chatInput, setChatInput] = useState("");
    const [chatLoading, setChatLoading] = useState(false);
    const [chatError, setChatError] = useState<string | null>(null);
    const chatBottomRef = useRef<HTMLDivElement>(null);

    // ── Handlers ────────────────────────────────────────────────────────────

    const handleGenerate = () => {
        const generated = generateScenarios(testCount);
        setScenarios(generated);
        setCurrentIdx(0);
        setEditableQuery(generated[0].previewQuery);
        setSsotReport(null);
        setSsotError(null);
        setMithraRaw(null);
        setLlmUsed(null);
    };

    const handleNext = () => {
        const next = currentIdx + 1;
        setCurrentIdx(next);
        setEditableQuery(scenarios[next].previewQuery);
        setSsotReport(null);
        setSsotError(null);
        setMithraRaw(null);
        setLlmUsed(null);
    };

    const handleRegenerate = () => {
        setScenarios([]);
        setCurrentIdx(0);
        setSsotReport(null);
        setSsotError(null);
        setMithraRaw(null);
        setLlmUsed(null);
    };

    const handleSendToSSoT = async () => {
        setSsotLoading(true);
        setSsotReport(null);
        setSsotError(null);
        setMithraRaw(null);
        setLlmUsed(null);

        const payload = {
            snapshots: scenarios[currentIdx].snapshots,
            session_id: "",
            query_override: editableQuery.trim() || scenarios[currentIdx].previewQuery
        };

        console.group("[TestGen] Send to SSOT");
        console.log("→ POST /ssot-report", payload);

        try {
            const resp = await fetch("/ssot-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await resp.json();
            console.log(`← HTTP ${resp.status}`, data);
            console.groupEnd();

            if (!resp.ok) {
                setSsotError(data.error ?? `HTTP ${resp.status}`);
                return;
            }
            if (data.mithraRaw != null) setMithraRaw(data.mithraRaw);
            setLlmUsed(data.llmUsed === true);
            if (data.ssotReport != null) setSsotReport(data.ssotReport);
            else setSsotError("No report returned from server.");
        } catch (err) {
            console.error("[TestGen] Error", err);
            console.groupEnd();
            setSsotError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setSsotLoading(false);
        }
    };

    const handleChatSend = async () => {
        const question = chatInput.trim();
        if (!question) return;

        setChatInput("");
        setChatError(null);
        setChatLoading(true);
        setChatMessages(prev => [...prev, { role: "user", content: question, citations: [] }]);

        try {
            let resp: Response;
            if (!chatId) {
                console.group("[Chat] Create chat");
                console.log("→ POST /kb/chats", { initialQuestion: question });
                resp = await fetch("/kb/chats", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ initialQuestion: question, title: "KB Chat Session" })
                });
                const data = await resp.json();
                console.log(`← HTTP ${resp.status}`, data);
                console.groupEnd();
                if (!resp.ok) {
                    setChatError(data.message ?? data.error ?? `HTTP ${resp.status}`);
                    return;
                }
                const newChatId = data.chat?.id ?? null;
                setChatId(newChatId);
                // CreateChatResponse only returns `chat`. Fetch messages to get the first answer.
                if (newChatId) {
                    const msgResp = await fetch(`/kb/chats/${newChatId}`);
                    if (msgResp.ok) {
                        const msgData = await msgResp.json();
                        const assistantMsg = (msgData.messages ?? []).find((m: { role: string }) => m.role === "assistant");
                        if (assistantMsg) {
                            setChatMessages(prev => [
                                ...prev,
                                {
                                    role: "assistant",
                                    content: assistantMsg.content ?? "",
                                    citations: assistantMsg.citations ?? []
                                }
                            ]);
                        }
                    }
                }
            } else {
                console.group("[Chat] Send message");
                console.log(`→ POST /kb/chats/${chatId}/messages`, { questionText: question });
                resp = await fetch(`/kb/chats/${chatId}/messages`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ questionText: question })
                });
                const data = await resp.json();
                console.log(`← HTTP ${resp.status}`, data);
                console.groupEnd();
                if (!resp.ok) {
                    setChatError(data.message ?? data.error ?? `HTTP ${resp.status}`);
                    return;
                }
                setChatMessages(prev => [
                    ...prev,
                    {
                        role: "assistant",
                        content: data.message?.content ?? data.answer ?? "",
                        citations: data.message?.citations ?? data.citations ?? []
                    }
                ]);
            }
        } catch (err) {
            console.error("[Chat] Error", err);
            setChatError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setChatLoading(false);
        }
    };

    const handleNewChat = () => {
        setChatId(null);
        setChatMessages([]);
        setChatInput("");
        setChatError(null);
    };

    useEffect(() => {
        chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [chatMessages]);

    const scenario = scenarios[currentIdx] ?? null;

    // ── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="space-y-6">
            {/* ── Header ── */}
            <div className="flex items-center gap-3">
                <FlaskConical className="h-6 w-6 text-[color:var(--ciq-accent-purple)]" />
                <div>
                    <h2 className="font-display text-xl font-semibold text-[color:var(--ciq-text-strong)]">SSOT Test Generator</h2>
                    <p className="text-xs text-[color:var(--ciq-text-muted)]">
                        Generate synthetic burnout scenarios and test the Knowledge Base integration without running the survey.
                    </p>
                </div>
            </div>

            {/* ── Config panel (shown before generating) ── */}
            {scenarios.length === 0 && (
                <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5">
                    <label className="mb-3 block text-sm font-medium text-[color:var(--ciq-text-body)]">
                        Number of test cases:&nbsp;
                        <span className="font-bold text-[color:var(--ciq-accent-purple)]">{testCount}</span>
                    </label>
                    <input
                        type="range"
                        min={1}
                        max={10}
                        value={testCount}
                        onChange={e => setTestCount(Number(e.target.value))}
                        className="ciq-range mb-4 w-full"
                    />
                    <div className="mb-4 flex items-center justify-between text-xs text-[color:var(--ciq-text-muted)]">
                        <span>1</span>
                        <span>10</span>
                    </div>
                    <button
                        onClick={handleGenerate}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--ciq-accent-blue)] px-6 py-3 text-sm font-semibold text-[#0a0c0e] hover:opacity-90"
                    >
                        <Sparkles className="h-4 w-4" />
                        Generate Test Cases
                    </button>
                </div>
            )}

            {/* ── Scenario navigator ── */}
            {scenario && (
                <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5">
                    {/* Counter + label */}
                    <div className="mb-3 flex items-center gap-3">
                        <span className={`rounded-full px-3 py-0.5 text-xs font-medium ${PILL.purple}`}>
                            Scenario {currentIdx + 1} of {scenarios.length}
                        </span>
                        <span className={`rounded-full px-3 py-0.5 text-xs font-semibold ${PILL[RISK_TONE[scenario.riskLevel]]}`}>
                            {scenario.riskLevel.toUpperCase()}
                        </span>
                    </div>

                    <p className="mb-4 text-sm font-semibold text-[color:var(--ciq-text-strong)]">{scenario.label}</p>

                    {/* Snapshot table */}
                    <div className="mb-4 overflow-x-auto rounded-lg">
                        <table className="w-full border-collapse text-xs">
                            <thead>
                                <tr className="bg-[color:var(--ciq-card-2)]">
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-left text-[color:var(--ciq-text-body)]">Domain</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-body)]">Score</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-body)]">Sentiment</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-body)]">Left Gaze</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center text-[color:var(--ciq-text-body)]">Right Gaze</th>
                                </tr>
                            </thead>
                            <tbody>
                                {scenario.snapshots.map((s, i) => (
                                    <tr key={s.questionId} className={i % 2 === 0 ? "bg-[color:var(--ciq-card)]" : "bg-[color:var(--ciq-card-2)]"}>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-1.5 text-[color:var(--ciq-text-strong)]">
                                            {s.domain}
                                            {scenario.primaryDomains.includes(s.domain) && (
                                                <span className={`ml-2 rounded px-1 py-0.5 text-[10px] ${PILL.purple}`}>primary</span>
                                            )}
                                        </td>
                                        <td className="font-data border border-[color:var(--ciq-line)] px-3 py-1.5 text-center font-semibold text-[color:var(--ciq-text-strong)]">
                                            {s.score}/5
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-1.5 text-center capitalize text-[color:var(--ciq-text-body)]">
                                            {s.voiceSentiment}
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-1.5 text-center text-[color:var(--ciq-text-body)]">
                                            {s.leftGazePosition}
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-1.5 text-center text-[color:var(--ciq-text-body)]">
                                            {s.rightGazePosition}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Nav buttons */}
                    <div className="flex gap-2">
                        <button
                            onClick={handleRegenerate}
                            className="flex items-center gap-1 rounded-lg border border-[color:var(--ciq-line)] px-3 py-1.5 text-xs text-[color:var(--ciq-text-body)] hover:bg-[color:var(--ciq-card-2)]"
                        >
                            <RefreshCw className="h-3 w-3" />
                            Regenerate
                        </button>
                        <button
                            onClick={handleNext}
                            disabled={currentIdx >= scenarios.length - 1}
                            className="ml-auto flex items-center gap-1 rounded-lg bg-[color:var(--ciq-card-3)] px-4 py-1.5 text-xs font-medium text-[color:var(--ciq-text-strong)] hover:bg-[color:var(--ciq-card-3)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            Next
                            <ChevronRight className="h-3 w-3" />
                        </button>
                    </div>
                </div>
            )}

            {/* ── Query editor + AI Report (side by side) ── */}
            {scenario && (
                <div className="flex items-start gap-4">
                    {/* Left: query editor */}
                    <div className="min-w-0 flex-1 rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5">
                        <div className="mb-2 flex items-center justify-between">
                            <p className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">Mithra Query — Edit before sending</p>
                            <button
                                onClick={() => setEditableQuery(scenario.previewQuery)}
                                className="flex items-center gap-1 text-xs text-[color:var(--ciq-text-muted)] hover:text-[color:var(--ciq-text-strong)]"
                            >
                                <ChevronLeft className="h-3 w-3" />
                                Reset to default
                            </button>
                        </div>
                        <textarea
                            value={editableQuery}
                            onChange={e => setEditableQuery(e.target.value)}
                            rows={5}
                            className="w-full resize-y rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] px-3 py-2 text-sm leading-relaxed text-[color:var(--ciq-text-strong)] focus:border-[color:var(--ciq-accent-purple)] focus:outline-none"
                        />
                        <p className="mt-1 text-xs text-[color:var(--ciq-text-muted)]">
                            You may freely edit this query before sending it to the Knowledge Base.
                        </p>

                        <button
                            onClick={handleSendToSSoT}
                            disabled={ssotLoading || !editableQuery.trim()}
                            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--ciq-accent-blue)] px-6 py-3 text-sm font-semibold text-[#0a0c0e] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {ssotLoading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" /> Generating Report…
                                </>
                            ) : (
                                <>
                                    <Sparkles className="h-4 w-4" /> Send to SSOT API
                                </>
                            )}
                        </button>
                    </div>

                    {/* Right: AI Consultative Report (or placeholder) */}
                    <div className="flex min-w-0 flex-1 flex-col self-stretch rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5">
                        <div className="mb-3 flex items-center gap-2">
                            <BookOpen className="h-5 w-5 text-[color:var(--ciq-accent-blue)]" />
                            <h3 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">AI Consultative Report</h3>
                            <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${PILL.blue}`}>SSOT · Evidence-based</span>
                        </div>

                        {ssotError && (
                            <div className={`mb-3 flex items-start gap-2 rounded-lg p-3 ${BANNER.red}`}>
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                <span className="text-sm">{ssotError}</span>
                            </div>
                        )}

                        {ssotLoading && (
                            <div className="flex flex-1 items-center justify-center gap-2 text-[color:var(--ciq-text-muted)]">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                <span className="text-sm">Generating report…</span>
                            </div>
                        )}

                        {!ssotReport && !ssotLoading && !ssotError && (
                            <p className="flex-1 text-sm italic text-[color:var(--ciq-text-body)]">Send the query to generate a consultative report here.</p>
                        )}

                        {ssotReport && !ssotLoading && (
                            <div className="flex-1 space-y-3 overflow-y-auto">
                                {/* When the reporting LLM is not configured the backend returns the raw
                                    Knowledge Base answer (llmUsed=false). Render it anyway — same graceful
                                    fallback as the assessment tab — with a small note rather than dead-ending. */}
                                {llmUsed === false && (
                                    <div className="flex items-start gap-2 rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] px-3 py-2 text-xs text-[color:var(--ciq-text-muted)]">
                                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--ciq-accent-amber)]" />
                                        <span>
                                            Showing raw Knowledge Base facts — set{" "}
                                            <code className="rounded bg-[color:var(--ciq-card)] px-1 py-0.5 text-[color:var(--ciq-accent-amber)]">REPORT_OPENAI_ENDPOINT</code>,{" "}
                                            <code className="rounded bg-[color:var(--ciq-card)] px-1 py-0.5 text-[color:var(--ciq-accent-amber)]">REPORT_OPENAI_API_KEY</code> and{" "}
                                            <code className="rounded bg-[color:var(--ciq-card)] px-1 py-0.5 text-[color:var(--ciq-accent-amber)]">REPORT_OPENAI_DEPLOYMENT</code>{" "}
                                            to enable the formatted physiometric report.
                                        </span>
                                    </div>
                                )}
                                <ConsultativeReport answer={ssotReport.answer} citations={ssotReport.citations} />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── Knowledge Base Facts (raw Mithra response) ── */}
            {mithraRaw && (
                <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5">
                    <div className="mb-3 flex items-center gap-2">
                        <BookOpen className="h-5 w-5 text-[color:var(--ciq-accent-amber)]" />
                        <h3 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">Knowledge Base Facts</h3>
                        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${PILL.amber}`}>RAW · Source Material</span>
                    </div>
                    {mithraRaw.answer ? (
                        <Markdown>{mithraRaw.answer}</Markdown>
                    ) : (
                        <p className="text-sm italic text-[color:var(--ciq-text-muted)]">Mithra returned no facts for this query.</p>
                    )}
                    {mithraRaw.citations.length > 0 && (
                        <div className="mt-4 border-t border-[color:var(--ciq-line)] pt-3">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">Source Citations</p>
                            <ul className="space-y-1.5">
                                {mithraRaw.citations.map((c, i) => (
                                    <li key={i} className="flex items-start gap-2 text-xs text-[color:var(--ciq-text-body)]">
                                        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--ciq-accent-amber)]" />
                                        <span>
                                            <span className="font-medium text-[color:var(--ciq-accent-amber)]">{c.paperTitle}</span>
                                            {c.paperPage > 0 && <span className="ml-1 text-[color:var(--ciq-text-muted)]">— p.&nbsp;{c.paperPage}</span>}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {/* ── KB Chat (always visible) ── */}
            <div className="flex flex-col rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)]" style={{ minHeight: "420px" }}>
                {/* Header */}
                <div className="flex items-center gap-2 border-b border-[color:var(--ciq-line)] px-4 py-3">
                    <MessageCircle className="h-4 w-4 text-[color:var(--ciq-accent-green)]" />
                    <h3 className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">Chat with Knowledge Base</h3>
                    {chatId && <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] ${PILL.green}`}>session active</span>}
                    <button
                        onClick={handleNewChat}
                        className="ml-auto flex items-center gap-1 rounded-lg border border-[color:var(--ciq-line)] px-2 py-1 text-xs text-[color:var(--ciq-text-muted)] hover:bg-[color:var(--ciq-card-2)] hover:text-[color:var(--ciq-text-strong)]"
                    >
                        <PlusCircle className="h-3 w-3" />
                        New Chat
                    </button>
                </div>

                {/* Message list */}
                <div className="flex-1 space-y-4 overflow-y-auto p-4" style={{ maxHeight: "420px" }}>
                    {chatMessages.length === 0 && (
                        <div className="flex h-full items-center justify-center">
                            <p className="text-xs text-[color:var(--ciq-text-body)]">Ask anything about your company's Knowledge Base…</p>
                        </div>
                    )}
                    {chatMessages.map((msg, idx) => (
                        <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                            <div
                                className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
                                    msg.role === "user"
                                        ? "bg-[color:var(--ciq-accent-blue)] text-[#0a0c0e]"
                                        : "bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-strong)]"
                                }`}
                            >
                                {msg.content ? (
                                    msg.role === "assistant" ? (
                                        <Markdown>{msg.content}</Markdown>
                                    ) : (
                                        <p className="whitespace-pre-line leading-relaxed">{msg.content}</p>
                                    )
                                ) : (
                                    <p className="text-xs italic text-[color:var(--ciq-text-muted)]">
                                        No content returned — check KB documents are uploaded and indexed.
                                    </p>
                                )}
                                {msg.citations.length > 0 && (
                                    <div className="mt-2 border-t border-[color:var(--ciq-line)] pt-2">
                                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">Citations</p>
                                        <ul className="space-y-1">
                                            {msg.citations.map((c, ci) => (
                                                <li key={ci} className="flex items-start gap-1.5 text-[11px] text-[color:var(--ciq-text-body)]">
                                                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--ciq-accent-green)]" />
                                                    <span>
                                                        <span className="font-medium text-[color:var(--ciq-accent-green)]">{c.paperTitle}</span>
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
                        </div>
                    ))}
                    {chatLoading && (
                        <div className="flex justify-start">
                            <div className="rounded-xl bg-[color:var(--ciq-card-2)] px-4 py-2.5">
                                <Loader2 className="h-4 w-4 animate-spin text-[color:var(--ciq-accent-green)]" />
                            </div>
                        </div>
                    )}
                    {chatError && (
                        <div className={`flex items-start gap-2 rounded-lg p-3 ${BANNER.red}`}>
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span className="text-xs">{chatError}</span>
                        </div>
                    )}
                    <div ref={chatBottomRef} />
                </div>

                {/* Input bar */}
                <div className="flex gap-2 border-t border-[color:var(--ciq-line)] p-3">
                    <input
                        type="text"
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                handleChatSend();
                            }
                        }}
                        placeholder="Ask the Knowledge Base…"
                        disabled={chatLoading}
                        className="flex-1 rounded-lg border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] px-3 py-2 text-sm text-[color:var(--ciq-text-strong)] placeholder:text-[color:var(--ciq-text-faint)] focus:border-[color:var(--ciq-accent-purple)] focus:outline-none disabled:opacity-50"
                    />
                    <button
                        onClick={handleChatSend}
                        disabled={chatLoading || !chatInput.trim()}
                        className="flex items-center gap-1.5 rounded-lg bg-[color:var(--ciq-accent-blue)] px-4 py-2 text-sm font-semibold text-[#0a0c0e] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {chatLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
