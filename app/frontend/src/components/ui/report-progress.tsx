import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

import { DONE_HOLD_MS, REPORT_STEPS, progressAt } from "@/lib/report-progress";

type Props = {
    // True once POST /analyze-report has resolved (the report exists).
    ready: boolean;
    // Called once, shortly after 100% — the caller then reveals the report.
    onDone: () => void;
    // Called once, when the last card starts (e.g. to cue the agent's closing line).
    onLastStep?: () => void;
};

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Shown between the last scored answer and the report: an "N% complete" ring plus
 * four cards that turn green with a tick as each step completes. Timing lives in
 * lib/report-progress.ts (the last card waits for `ready`).
 */
export function ReportProgress({ ready, onDone, onLastStep }: Props) {
    const [startedAt] = useState(() => Date.now());
    const [now, setNow] = useState(startedAt);
    const { stepsDone, percent } = progressAt(now - startedAt, ready);

    useEffect(() => {
        if (percent === 100) return;
        const id = window.setInterval(() => setNow(Date.now()), 150);
        return () => window.clearInterval(id);
    }, [percent]);

    // Read through refs so fresh callbacks each render can't restart the timers.
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;
    const onLastStepRef = useRef(onLastStep);
    onLastStepRef.current = onLastStep;
    const lastStepFiredRef = useRef(false);
    useEffect(() => {
        if (stepsDone < REPORT_STEPS.length - 1 || lastStepFiredRef.current) return;
        lastStepFiredRef.current = true;
        onLastStepRef.current?.();
    }, [stepsDone]);
    useEffect(() => {
        if (percent !== 100) return;
        const id = window.setTimeout(() => onDoneRef.current(), DONE_HOLD_MS);
        return () => window.clearTimeout(id);
    }, [percent]);

    return (
        <div className="flex w-full max-w-xl flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-[color:var(--ciq-card-2)] px-5 py-4">
                <span className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">Generating your report</span>
                <span className="flex items-center gap-3 text-sm text-[color:var(--ciq-text-muted)]" role="status" aria-live="polite">
                    <span className="font-data">{percent}% complete</span>
                    <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" aria-hidden>
                        <circle cx="12" cy="12" r={RING_R} fill="none" strokeWidth="2.5" className="stroke-[color:var(--ciq-line)]" />
                        <circle
                            cx="12"
                            cy="12"
                            r={RING_R}
                            fill="none"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeDasharray={RING_C}
                            strokeDashoffset={RING_C * (1 - percent / 100)}
                            className="stroke-[color:var(--ciq-accent-green)] transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                        />
                    </svg>
                </span>
            </div>

            <ol className="flex flex-col gap-3">
                {REPORT_STEPS.map((step, i) => {
                    const done = i < stepsDone;
                    return (
                        <li
                            key={step.title}
                            className={`flex items-center justify-between gap-4 rounded-2xl border px-5 py-4 transition-colors duration-500 motion-reduce:transition-none ${
                                done
                                    ? "border-[color:color-mix(in_srgb,var(--ciq-accent-green)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--ciq-accent-green)_12%,transparent)]"
                                    : "border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)]"
                            }`}
                        >
                            <div className="flex min-w-0 flex-col gap-1">
                                <span className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">{step.title}</span>
                                <span className="text-sm text-[color:var(--ciq-text-muted)]">{step.detail}</span>
                            </div>
                            <span
                                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-300 motion-reduce:transition-none ${
                                    done ? "scale-100 bg-[color:var(--ciq-accent-green)] text-white" : "scale-90 border-2 border-[color:var(--ciq-line)]"
                                }`}
                            >
                                {done && <Check className="h-5 w-5" strokeWidth={3} aria-hidden />}
                                <span className="sr-only">{done ? "done" : "in progress"}</span>
                            </span>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
