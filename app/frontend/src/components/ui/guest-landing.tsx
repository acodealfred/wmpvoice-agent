import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Mic, Calendar, TrendingUp, TrendingDown, Minus, ShieldCheck, Brain, Waves, Sparkles, ArrowRight, Target, CheckCircle2, LineChart } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { SurveyRecord } from "@/types";
import { TEXT_TONE } from "@/lib/badges";
import { GuestScoreTrend } from "./guest-score-trend";
import { GuestChat } from "./guest-chat";
import "./guest-landing.css";

interface Props {
    userName?: string;
    onStartAssessment: () => void;
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Maps a risk level to the Fit / Monitor / Act band chip. */
function readinessBand(risk: string): { cls: string; label: string } {
    if (risk === "Low") return { cls: "ciq-band-fit", label: "Fit" };
    if (risk === "Moderate") return { cls: "ciq-band-monitor", label: "Monitor" };
    return { cls: "ciq-band-act", label: "Act" };
}

// ── small presentational bits ───────────────────────────────────────────────

function StatCard({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
            className="bg-[color:var(--ciq-card)]/70 relative overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl"
        >
            {children}
        </motion.div>
    );
}

const FEATURES = [
    {
        icon: Mic,
        accent: "var(--ciq-accent-purple)",
        title: "Just talk",
        body: "A voice-guided conversation walks you through the assessment — no forms, no scales to puzzle over."
    },
    {
        icon: Brain,
        accent: "var(--ciq-accent-blue)",
        title: "Biometric-aware",
        body: "Optional camera signals — blink rate, gaze, expression — add context the words alone can miss."
    },
    {
        icon: LineChart,
        accent: "var(--ciq-accent-green)",
        title: "Insight you can act on",
        body: "A clear, research-grounded summary of where you stand and what to watch — delivered the moment you finish."
    },
    {
        icon: ShieldCheck,
        accent: "var(--ciq-accent-amber)",
        title: "Private by design",
        body: "Your results are yours. Managers only ever see anonymised, aggregate trends — never your report."
    }
];

const FIELD_RECOMMENDATIONS = ["Pace Heavy Lifts", "Flag Long Trips", "Hydration Check", "Shift Handover Check"];

const STEPS = [
    { n: 1, title: "Start the conversation", body: "Tap the button and the agent greets you." },
    { n: 2, title: "Answer out loud", body: "Speak naturally through a short set of questions." },
    { n: 3, title: "Get your read-out", body: "Receive a spoken summary and a detailed report." }
];

// ── main ─────────────────────────────────────────────────────────────────

export function GuestLanding({ userName, onStartAssessment }: Props) {
    const [records, setRecords] = useState<SurveyRecord[] | null>(null);

    useEffect(() => {
        let alive = true;
        apiFetch("/api/history")
            .then(r => (r.ok ? r.json() : { records: [] }))
            .then(d => alive && setRecords(d.records ?? []))
            .catch(() => alive && setRecords([]));
        return () => {
            alive = false;
        };
    }, []);

    const stats = useMemo(() => {
        const recs = records ?? [];
        const last = recs[0] ?? null;
        const prev = recs[1] ?? null;
        const lastScore = last?.technical_report?.totalScore ?? null;
        const prevScore = prev?.technical_report?.totalScore ?? null;
        // Burnout scoring: a lower score is an improvement.
        const trend: "up" | "down" | "flat" | null =
            lastScore == null || prevScore == null ? null : lastScore < prevScore ? "up" : lastScore > prevScore ? "down" : "flat";
        // Surveys with independent scoringSections (e.g. PILOT's BAT-4/CBI-WRB3) have no
        // single totalScore/riskLevel to show in this compact card — fall back to the
        // "still processing" state rather than rendering "undefined risk".
        const lastReport = last?.technical_report?.totalScore != null ? last.technical_report : null;
        return {
            total: recs.length,
            last,
            lastReport,
            trend
        };
    }, [records]);

    const loading = records === null;
    const isReturning = !loading && stats.total > 0;
    const greetingName = userName?.trim() ? userName.trim().split(" ")[0] : null;

    return (
        <div className="gl ciq-page">
            {/* motion background */}
            <div className="gl-orbs" aria-hidden>
                <div className="gl-orb gl-orb-1" />
                <div className="gl-orb gl-orb-2" />
                <div className="gl-orb gl-orb-3" />
            </div>
            <div className="gl-grid" aria-hidden />

            <div className="gl-content mx-auto w-full max-w-6xl px-5 pb-16 pt-10 sm:px-8">
                {/* ── Hero ─────────────────────────────────────────────── */}
                <section className="flex flex-col items-center text-center">
                    <motion.span
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5 }}
                        className="mb-5 inline-flex items-center gap-2 rounded-full border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile)] px-4 py-1.5 text-xs font-medium text-[color:var(--ciq-text-68)]"
                    >
                        <Sparkles className="h-3.5 w-3.5 text-[color:var(--ciq-accent-purple)]" />
                        Voice Readiness Assessment
                    </motion.span>

                    <motion.h1
                        initial={{ opacity: 0, y: 18 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, delay: 0.05 }}
                        className="font-display text-4xl font-bold leading-[1.08] tracking-tight text-[color:var(--ciq-text-strong)] sm:text-6xl"
                    >
                        {isReturning && greetingName ? (
                            <>
                                Welcome back,{" "}
                                <span className="bg-gradient-to-r from-[color:var(--ciq-accent-purple)] to-[color:var(--ciq-accent-blue)] bg-clip-text text-transparent">
                                    {greetingName}
                                </span>
                            </>
                        ) : (
                            <>
                                A few minutes for{" "}
                                <span className="bg-gradient-to-r from-[color:var(--ciq-accent-purple)] to-[color:var(--ciq-accent-blue)] bg-clip-text text-transparent">
                                    your wellbeing
                                </span>
                            </>
                        )}
                    </motion.h1>

                    <motion.p
                        initial={{ opacity: 0, y: 18 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, delay: 0.12 }}
                        className="mt-5 max-w-xl text-base text-[color:var(--ciq-text-68)] sm:text-lg"
                    >
                        {isReturning
                            ? "Pre-tour readiness check. Fast, voice-assisted baseline evaluation before stepping on pad."
                            : "Speak with an AI agent that listens, understands, and gives you a clear, private picture of where your burnout risk stands today."}
                    </motion.p>

                    <motion.div
                        initial={{ opacity: 0, scale: 0.94 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.5, delay: 0.2 }}
                        className="relative mt-9"
                    >
                        <span className="gl-cta-glow" aria-hidden />
                        <button
                            onClick={onStartAssessment}
                            className="ciq-btn-primary ciq-touch-lg group relative inline-flex items-center gap-2.5 rounded-full px-8 text-base transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-blue)]"
                        >
                            <Mic className="h-5 w-5" />
                            {isReturning ? "Start Pre-Tour Check" : "Start your assessment"}
                            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                        </button>
                    </motion.div>
                    {isReturning && (
                        <motion.p
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: 0.3 }}
                            className="mt-3 text-xs text-[color:var(--ciq-text-40)]"
                        >
                            Takes about 3–5 minutes · your last check-in was{" "}
                            {new Date(stats.last!.created_at).toLocaleDateString(undefined, { month: "long", day: "numeric" })}
                        </motion.p>
                    )}
                </section>

                {/* ── Returning user: progress, streak, last result ───────── */}
                {isReturning && (
                    <>
                        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-3">
                            {/* Assessments completed */}
                            <StatCard delay={0.05}>
                                <div className="flex items-center gap-2 text-[color:var(--ciq-text-60)]">
                                    <Target className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" />
                                    <span className="text-xs font-semibold uppercase tracking-wider">Progress</span>
                                </div>
                                <p className="font-data mt-3 text-4xl font-bold text-[color:var(--ciq-text-strong)]">{stats.total}</p>
                                <p className="mt-1 text-sm text-[color:var(--ciq-text-68)]">
                                    {stats.total === 1 ? "Tour Checked" : "Tours Checked"}
                                </p>
                            </StatCard>

                            {/* Hitch rotation */}
                            <StatCard delay={0.12}>
                                <div className="flex items-center gap-2 text-[color:var(--ciq-text-60)]">
                                    <Calendar className="h-4 w-4 text-[color:var(--ciq-accent-amber)]" />
                                    <span className="text-xs font-semibold uppercase tracking-wider">Hitch Rotation</span>
                                </div>
                                <p className="font-data mt-3 flex items-baseline gap-1.5 text-4xl font-bold text-[color:var(--ciq-text-strong)]">
                                    Day 9
                                    <span className="text-base font-medium text-[color:var(--ciq-text-60)]">of 14</span>
                                </p>
                                <p className="mt-3 text-sm text-[color:var(--ciq-text-68)]">Crew change in 5 days</p>
                            </StatCard>

                            {/* Latest result */}
                            <StatCard delay={0.19}>
                                <div className="flex items-center gap-2 text-[color:var(--ciq-text-60)]">
                                    <LineChart className="h-4 w-4 text-[color:var(--ciq-accent-blue)]" />
                                    <span className="text-xs font-semibold uppercase tracking-wider">Latest result</span>
                                </div>
                                {stats.lastReport ? (
                                    <>
                                        <div className="mt-3 flex items-center gap-2">
                                            {(() => {
                                                const band = readinessBand(stats.lastReport!.riskLevel ?? "Low");
                                                return (
                                                    <span className={`ciq-band ${band.cls}`}>
                                                        <span className="dot" />
                                                        {band.label}
                                                    </span>
                                                );
                                            })()}
                                            {stats.trend && (
                                                <span
                                                    className={`flex items-center gap-1 text-xs font-medium ${
                                                        stats.trend === "up" ? TEXT_TONE.green : stats.trend === "down" ? TEXT_TONE.red : TEXT_TONE.neutral
                                                    }`}
                                                >
                                                    {stats.trend === "up" ? (
                                                        <TrendingDown className="h-3.5 w-3.5" />
                                                    ) : stats.trend === "down" ? (
                                                        <TrendingUp className="h-3.5 w-3.5" />
                                                    ) : (
                                                        <Minus className="h-3.5 w-3.5" />
                                                    )}
                                                    {stats.trend === "up" ? "improving" : stats.trend === "down" ? "watch" : "steady"}
                                                </span>
                                            )}
                                        </div>
                                        <p className="mt-2 text-sm text-[color:var(--ciq-text-68)]">
                                            Readiness Index: <strong className="font-data text-[color:var(--ciq-text-strong)]">53/ 100</strong>
                                            {" · "}
                                            {new Date(stats.last!.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                                        </p>
                                    </>
                                ) : (
                                    <p className="mt-3 text-sm text-[color:var(--ciq-text-60)]">Your last run is still processing.</p>
                                )}
                            </StatCard>
                        </div>

                        {/* Pre-tour operational recommendations */}
                        <motion.div
                            initial={{ opacity: 0, y: 24 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.55, delay: 0.28, ease: [0.22, 1, 0.36, 1] }}
                            className="bg-[color:var(--ciq-card)]/70 mt-4 overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl"
                        >
                            <div className="mb-4 flex items-center gap-2">
                                <Sparkles className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" />
                                <h2 className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">Pre-Tour Operational Recommendations</h2>
                            </div>
                            <ul className="grid gap-3 sm:grid-cols-2">
                                {FIELD_RECOMMENDATIONS.map((rec, i) => (
                                    <motion.li
                                        key={rec}
                                        initial={{ opacity: 0, x: -12 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ delay: 0.38 + i * 0.1 }}
                                        className="flex items-start gap-3 rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3.5"
                                    >
                                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ciq-accent-green)]" />
                                        <span className="text-sm leading-relaxed text-[color:var(--ciq-text-86)]">{rec}</span>
                                    </motion.li>
                                ))}
                            </ul>
                            <p className="mt-4 text-xs text-[color:var(--ciq-text-40)]">
                                Field operational guidance compliant with API RP 755. Data remains private.
                            </p>
                        </motion.div>

                        {/* Your journey — personal trend + wellbeing assistant (own data only) */}
                        <motion.section
                            initial={{ opacity: 0, y: 24 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.55, delay: 0.32, ease: [0.22, 1, 0.36, 1] }}
                            className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5"
                        >
                            <div className="lg:col-span-3"><GuestScoreTrend records={records ?? []} /></div>
                            <div className="lg:col-span-2"><GuestChat /></div>
                        </motion.section>
                    </>
                )}

                {/* ── New user: marketing ─────────────────────────────────── */}
                {!loading && !isReturning && (
                    <>
                        <div className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                            {FEATURES.map((f, i) => {
                                const Icon = f.icon;
                                return (
                                    <motion.div
                                        key={f.title}
                                        initial={{ opacity: 0, y: 26 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ duration: 0.55, delay: 0.15 + i * 0.1, ease: [0.22, 1, 0.36, 1] }}
                                        whileHover={{ y: -6 }}
                                        className="bg-[color:var(--ciq-card)]/70 relative overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl"
                                    >
                                        <div
                                            className="flex h-11 w-11 items-center justify-center rounded-xl"
                                            style={{ background: `color-mix(in srgb, ${f.accent} 16%, transparent)` }}
                                        >
                                            <Icon className="h-5 w-5" style={{ color: f.accent }} />
                                        </div>
                                        <h3 className="mt-4 font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">{f.title}</h3>
                                        <p className="mt-1.5 text-sm leading-relaxed text-[color:var(--ciq-text-68)]">{f.body}</p>
                                    </motion.div>
                                );
                            })}
                        </div>

                        {/* How it works */}
                        <div className="mt-16 text-center">
                            <motion.h2
                                initial={{ opacity: 0, y: 16 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: 0.5 }}
                                className="font-display text-2xl font-bold text-[color:var(--ciq-text-strong)] sm:text-3xl"
                            >
                                How it works
                            </motion.h2>
                            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
                                {STEPS.map((s, i) => (
                                    <motion.div
                                        key={s.n}
                                        initial={{ opacity: 0, y: 22 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ duration: 0.5, delay: 0.6 + i * 0.12 }}
                                        className="bg-[color:var(--ciq-card)]/60 rounded-2xl border border-[color:var(--ciq-border)] p-6 text-left backdrop-blur-xl"
                                    >
                                        <div className="font-data flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--ciq-accent-blue)] text-sm font-bold text-[#0a0c0e]">
                                            {s.n}
                                        </div>
                                        <h3 className="mt-4 font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">{s.title}</h3>
                                        <p className="mt-1.5 text-sm text-[color:var(--ciq-text-68)]">{s.body}</p>
                                    </motion.div>
                                ))}
                            </div>
                        </div>

                        {/* Secondary CTA strip */}
                        <motion.div
                            initial={{ opacity: 0, y: 24 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.55, delay: 1 }}
                            className="bg-[color:var(--ciq-card)]/60 mt-14 flex flex-col items-center gap-5 rounded-3xl border border-[color:var(--ciq-border)] p-8 text-center backdrop-blur-xl sm:flex-row sm:justify-between sm:text-left"
                        >
                            <div className="flex items-center gap-4">
                                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[color:var(--ciq-tile-strong)]">
                                    <Waves className="h-6 w-6 text-[color:var(--ciq-accent-blue)]" />
                                </div>
                                <div>
                                    <h3 className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">Ready when you are</h3>
                                    <p className="text-sm text-[color:var(--ciq-text-68)]">Your first check-in takes just a few minutes.</p>
                                </div>
                            </div>
                            <button
                                onClick={onStartAssessment}
                                className="ciq-btn-primary ciq-touch inline-flex shrink-0 items-center gap-2 rounded-full px-6 text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-blue)]"
                            >
                                <Mic className="h-4 w-4" />
                                Begin assessment
                            </button>
                        </motion.div>
                    </>
                )}
            </div>
        </div>
    );
}
