// Timing for the report progress screen (components/ui/report-progress.tsx), shown
// between the last scored answer and the report. POST /analyze-report has no real
// stages (it scores + saves in about a second), so the four steps tick on a timer —
// but the LAST one waits for the report to actually be ready, so it never shows 100%
// before the report exists.

export type ReportStep = { title: string; detail: string };

export const REPORT_STEPS: readonly ReportStep[] = [
    { title: "Scoring your answers", detail: "Calculating your BAT-4 and CBI scores" },
    { title: "Reading your biometrics", detail: "Matching blink rate, gaze and voice to each answer" },
    { title: "Building your wellbeing profile", detail: "Finding patterns across your responses" },
    { title: "Preparing your report", detail: "Putting your results together" }
];

/** Time each step takes to tick when the report is already ready. */
export const STEP_MS = 2500;

/** Pause on 100% before moving on to the report. */
export const DONE_HOLD_MS = 400;

/** Steps ticked and the matching percent, `elapsedMs` after the screen appeared. */
export function progressAt(elapsedMs: number, ready: boolean): { stepsDone: number; percent: number } {
    const total = REPORT_STEPS.length;
    const byTime = Math.min(total, Math.floor(Math.max(0, elapsedMs) / STEP_MS));
    const stepsDone = ready ? byTime : Math.min(byTime, total - 1);
    return { stepsDone, percent: Math.round((stepsDone / total) * 100) };
}
