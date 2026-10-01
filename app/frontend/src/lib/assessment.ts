// Assessment lifecycle client — Start / Pause / Continue / Close, plus the run's baseline.
//
// The backend (ciq/assessments/) owns the state machine and mints the
// surveyRunId; it identifies the user and live session from the auth cookie,
// so none of these calls carry a session_id.

import { apiFetch } from "@/lib/api";
import type { AssessmentContinued, AssessmentStarted, ResumableAssessment } from "@/types";

async function postJson<T>(path: string, body: object = {}): Promise<T> {
    const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `${path} failed (${res.status})`);
    }
    return res.json();
}

/** The user's open (paused, or left active by a closed tab) assessment, or null. */
export async function fetchResumableAssessment(): Promise<ResumableAssessment | null> {
    const res = await apiFetch("/me/assessment");
    if (!res.ok) throw new Error(`/me/assessment failed (${res.status})`);
    return (await res.json()).resumable ?? null;
}

/** Closes any open run and starts a fresh active one. */
export const startAssessment = (surveyType?: string) => postJson<AssessmentStarted>("/me/assessment/start", { surveyType });

export const pauseAssessment = () => postJson<{ surveyRunId: string; status: "paused" }>("/me/assessment/pause");

export const continueAssessment = (surveyRunId: string) => postJson<AssessmentContinued>("/me/assessment/continue", { surveyRunId });

export const closeAssessment = (surveyRunId: string) => postJson<{ surveyRunId: string; status: "closed" }>("/me/assessment/close", { surveyRunId });

/** Records the active run's completed baseline (set once per run, server-side). */
export const completeAssessmentBaseline = (blinkRate: number | null, pupilSize: number | null) =>
    postJson<{ surveyRunId: string; segmentIndex: number; stored: boolean }>("/me/assessment/baseline", { blinkRate, pupilSize });

export type AssessmentControls = {
    /** Start the first assessment (nothing open, nothing on screen). */
    start: boolean;
    /** Close the open/finished assessment and start a fresh one. */
    startNew: boolean;
    /** Resume: the paused run, or the post-report conversation. */
    continue: boolean;
    pause: boolean;
    /** Discard the paused run. */
    close: boolean;
    /** End the finished assessment's session (the report stays saved in History). */
    finish: boolean;
};

/**
 * Which assessment buttons to show.
 *  • recording               → Pause
 *  • a paused run exists     → Start new, Continue, Close
 *  • report finished on page → Start new, Continue (post-report conversation), Finish
 *  • otherwise               → Start
 */
export function assessmentControls(state: { isRecording: boolean; hasResumable: boolean; assessmentComplete: boolean }): AssessmentControls {
    const none: AssessmentControls = { start: false, startNew: false, continue: false, pause: false, close: false, finish: false };
    if (state.isRecording) return { ...none, pause: true };
    if (state.hasResumable) return { ...none, startNew: true, continue: true, close: true };
    if (state.assessmentComplete) return { ...none, startNew: true, continue: true, finish: true };
    return { ...none, start: true };
}
