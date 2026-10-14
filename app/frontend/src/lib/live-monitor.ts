// Admin Live Monitor — response shapes of GET /admin/monitor/* (backend
// ciq/monitoring/live.py summarize) and the small pure helpers the panel renders with.

import type { Tone } from "@/lib/badges";

export type MonitorLevel = "ok" | "warn" | "bad" | "off";
export type MonitorStream = "eeg" | "camera" | "mic" | "timeline";
export type MonitorPhase = "baseline_setup" | "baseline_eyes_open" | "baseline_eyes_closed" | "survey" | "report";

export type MonitorSession = {
    sessionId: string;
    surveyRunId: string | null;
    userId: string | null;
    userName: string | null;
    surveyType: string | null;
    connection: "live" | "stale" | "offline";
    phase: MonitorPhase | null;
    phaseSeconds: number | null;
    /** Epoch seconds. */
    startedAt: number | null;
    answered: number;
    total: number;
    segmentIndex: number;
    lastTickAgoS: number | null;
    levels: Partial<Record<MonitorStream, MonitorLevel>>;
    overall: MonitorLevel;
    issues: string[];
    eeg: {
        status: string | null;
        battery: number | null;
        rate_hz: number | null;
        samples: Record<string, number | undefined>;
        contact: Record<string, string>;
        recorder_packets: number | null;
    } | null;
    history?: MonitorSecond[];
};

export type MonitorSecond = {
    /** Epoch seconds. */
    t: number;
    phase: MonitorPhase;
    levels: Partial<Record<MonitorStream, MonitorLevel>>;
    channels: Record<string, MonitorLevel>;
    issues: string[];
};

export type MonitorSessionsResponse = { enabled: boolean; serverTime?: number; sessions: MonitorSession[] };

export const EEG_CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;

export const STREAM_LABEL: Record<MonitorStream, string> = { eeg: "EEG", camera: "Camera", mic: "Microphone", timeline: "Timeline" };

export const LEVEL_TONE: Record<MonitorLevel, Tone> = { ok: "green", warn: "amber", bad: "red", off: "neutral" };

export const LEVEL_LABEL: Record<MonitorLevel, string> = { ok: "OK", warn: "Warning", bad: "Problem", off: "Not in use" };

// Solid swatches for the per-second strip (full-strength accents, not tinted pills).
export const LEVEL_SWATCH: Record<MonitorLevel, string> = {
    ok: "bg-[color:var(--ciq-accent-green)]",
    warn: "bg-[color:var(--ciq-accent-amber)]",
    bad: "bg-[color:var(--ciq-accent-red)]",
    off: "bg-[color:var(--ciq-tile-strong)]"
};

/** The phase stepper's steps, in order. */
export const PHASE_STEPS: { phase: MonitorPhase; label: string }[] = [
    { phase: "baseline_eyes_open", label: "Eyes open" },
    { phase: "baseline_eyes_closed", label: "Eyes closed" },
    { phase: "survey", label: "Survey" },
    { phase: "report", label: "Report" }
];

/** Index of the current step (baseline_setup counts as before step 0 → -1). */
export function phaseStepIndex(phase: MonitorPhase | null): number {
    return phase ? PHASE_STEPS.findIndex(s => s.phase === phase) : -1;
}

export const CONNECTION_LABEL: Record<MonitorSession["connection"], string> = { live: "Live", stale: "Not reporting", offline: "Disconnected" };

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(totalSeconds: number | null): string {
    if (totalSeconds === null || totalSeconds < 0) return "—";
    const s = Math.floor(totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The newest-first issue log of a session's history: one entry per change in issue text. */
export function issueLog(history: MonitorSecond[], limit = 20): { t: number; issue: string }[] {
    const out: { t: number; issue: string }[] = [];
    let previous = new Set<string>();
    for (const second of history) {
        const current = new Set(second.issues);
        for (const issue of current) if (!previous.has(issue)) out.push({ t: second.t, issue });
        previous = current;
    }
    return out.reverse().slice(0, limit);
}
