import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { CheckCircle2, FileText, Loader2, Pause, Play, Volume2 } from "lucide-react";

import type { ReportSpeechState } from "@/lib/report-speech";

type ReportScreenProps = {
    /** The report itself (DetailedReport + Recovery Window launcher), scrolled inside this panel. */
    report: ReactNode;
    /** False until /analyze-report has saved the report — Start waits for it. */
    reportReady: boolean;
    speechState: ReportSpeechState;
    /** Mic + agent audio live (the conversation is running). */
    isListening: boolean;
    onStart: () => void;
    onPause: () => void;
    onContinue: () => void;
    onFinish: () => void;
};

const STATUS: Record<ReportSpeechState, string> = {
    idle: "Your report is ready. Press Start and the assistant will walk you through it.",
    explaining: "The assistant is explaining your report…",
    paused: "Paused. Press Continue to pick up where it stopped.",
    done: "Explanation complete. Ask any questions about your results, or press Finish."
};

/**
 * PILOT post-survey screen: the report full-width (the camera card is hidden but stays
 * mounted), scrolling inside this panel so the page itself never scrolls, with the
 * controls in a bar floating at the bottom of the screen. Start → the agent explains the
 * report; Pause / Continue resume it from where it stopped; Finish returns the
 * assessment page to its Start state.
 */
export function ReportScreen({ report, reportReady, speechState, isListening, onStart, onPause, onContinue, onFinish }: ReportScreenProps) {
    const showStart = speechState === "idle";
    const showPause = !showStart && isListening;
    const showContinue = !showStart && !isListening;

    return (
        <motion.section
            key="report-screen"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="ciq-glass-card flex flex-col overflow-hidden lg:col-span-12 lg:min-h-0"
            aria-label="Your assessment report"
        >
            <div className="flex items-center gap-2 border-b border-[color:var(--ciq-divider)] px-5 py-3">
                <FileText className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" />
                <h2 className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">Your Report</h2>
            </div>

            {/* Bottom padding keeps the last of the report clear of the floating control bar. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-40">
                <div className="mx-auto w-full max-w-3xl">{report}</div>
            </div>

            {/* Floating control bar — fixed to the bottom of the screen, always reachable.
                Portalled to <body>: inside this animated (transformed, overflow-hidden)
                section a fixed element would be clipped to the section, not the screen. */}
            {createPortal(
                <div className="ciq-glass-card fixed inset-x-4 bottom-4 z-40 mx-auto max-w-xl px-5 py-3 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl">
                    <p className="mb-3 flex items-center justify-center gap-2 text-center text-xs text-[color:var(--ciq-text-60)]" role="status">
                        {speechState === "explaining" && <Volume2 className="h-3.5 w-3.5 shrink-0 text-[color:var(--ciq-accent-blue)]" aria-hidden />}
                        {speechState === "done" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[color:var(--ciq-accent-green)]" aria-hidden />}
                        {STATUS[speechState]}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        {showStart && (
                            <button
                                type="button"
                                onClick={onStart}
                                disabled={!reportReady}
                                className="ciq-btn-primary ciq-touch flex items-center justify-center gap-2 rounded-xl text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {reportReady ? <Play className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
                                {reportReady ? "Start" : "Preparing…"}
                            </button>
                        )}
                        {showPause && (
                            <button
                                type="button"
                                onClick={onPause}
                                className="ciq-btn-secondary ciq-touch flex items-center justify-center gap-2 rounded-xl text-sm font-semibold"
                            >
                                <Pause className="h-4 w-4" /> Pause
                            </button>
                        )}
                        {showContinue && (
                            <button
                                type="button"
                                onClick={onContinue}
                                className="ciq-btn-primary ciq-touch flex items-center justify-center gap-2 rounded-xl text-sm font-semibold"
                            >
                                <Play className="h-4 w-4" /> Continue
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onFinish}
                            className="ciq-btn-secondary ciq-touch flex items-center justify-center gap-2 rounded-xl text-sm font-semibold"
                        >
                            <CheckCircle2 className="h-4 w-4" /> Finish
                        </button>
                    </div>
                </div>,
                document.body
            )}
        </motion.section>
    );
}
