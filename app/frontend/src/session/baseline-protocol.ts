import type { BaselineCue } from "@/types";

// Two-phase resting baseline recorded before the assessment: eyes open (camera
// biometrics + EEG), then eyes closed (EEG when a headband is recording — blink rate
// and pupil size can't be measured with the eyes shut). Both phases always run.
// The agent is silent throughout except for one spoken cue at the start of each
// phase; each phase's timer starts only once that cue has finished PLAYING, so the
// recorded window never overlaps the agent's voice.

export type BaselinePhase = "eyes_open" | "eyes_closed";

export interface BaselineProtocolState {
    // idle → cue (agent speaking the phase's instruction) → recording → … → done
    stage: "idle" | "cue" | "recording" | "done";
    phase: BaselinePhase | null;
    // Epoch ms at which the current recording phase ends (null outside "recording").
    phaseEndsAt: number | null;
    phaseSeconds: number;
}

export interface BaselineProtocolOptions {
    eyesOpenSeconds: number;
    eyesClosedSeconds: number;
    sendCue: (cue: BaselineCue) => void;
    onPhaseStart: (phase: BaselinePhase) => void;
    onPhaseEnd: (phase: BaselinePhase) => void;
    onComplete: (result: { eyesClosed: boolean; skipped: boolean }) => void;
    onChange?: (state: BaselineProtocolState) => void;
}

// If the cue's response.done never arrives (dropped socket, Azure error), start the
// phase anyway rather than leaving the participant waiting forever.
export const CUE_FALLBACK_MS = 15_000;
// Small gap after the cue's last audio sample before the recording window opens.
const CUE_TAIL_MS = 500;
const PCM_SAMPLE_RATE = 24_000;

const START_CUE: Record<BaselinePhase, BaselineCue> = {
    eyes_open: "eyes_open_start",
    eyes_closed: "eyes_closed_start"
};

export class BaselineProtocol {
    private state: BaselineProtocolState = { stage: "idle", phase: null, phaseEndsAt: null, phaseSeconds: 0 };
    private timer: ReturnType<typeof setTimeout> | null = null;
    // Playback-time estimate for the cue currently being spoken.
    private cueAudioStartedAt: number | null = null;
    private cueAudioMs = 0;

    constructor(private readonly opts: BaselineProtocolOptions) {}

    getState(): BaselineProtocolState {
        return this.state;
    }

    isActive(): boolean {
        return this.state.stage === "cue" || this.state.stage === "recording";
    }

    start(): void {
        this.cancel();
        this.speakCue("eyes_open");
    }

    /** Feed each agent audio delta (base64 PCM16 @ 24 kHz) so the end of playback can be estimated. */
    notifyAudioDelta(base64: string): void {
        if (this.state.stage !== "cue") return;
        if (this.cueAudioStartedAt === null) this.cueAudioStartedAt = Date.now();
        const bytes = (base64.length * 3) / 4;
        this.cueAudioMs += (bytes / 2 / PCM_SAMPLE_RATE) * 1000;
    }

    /** The cue's response has finished generating — start the phase once its audio has played out. */
    notifyResponseDone(): void {
        // A turn with no audio (e.g. a function call) isn't the spoken cue — keep waiting
        // for the real one; the CUE_FALLBACK_MS timer still guarantees progress.
        if (this.state.stage !== "cue" || this.cueAudioStartedAt === null) return;
        const playbackEnd = this.cueAudioStartedAt + this.cueAudioMs;
        this.schedule(Math.max(0, playbackEnd - Date.now()) + CUE_TAIL_MS, () => this.beginRecording());
    }

    /** Participant chose to skip: end whatever is running and complete immediately. */
    skip(): void {
        if (!this.isActive()) return;
        const { phase, stage } = this.state;
        this.clearTimer();
        if (stage === "recording" && phase) this.opts.onPhaseEnd(phase);
        // eyesClosed = the participant was already asked to close their eyes, so the
        // survey lead-in must tell them to open them again.
        this.finish(phase === "eyes_closed", true);
    }

    /** Abort silently (stop pressed / new survey) — no callbacks, back to idle. */
    cancel(): void {
        this.clearTimer();
        this.setState({ stage: "idle", phase: null, phaseEndsAt: null, phaseSeconds: 0 });
    }

    private speakCue(phase: BaselinePhase): void {
        this.cueAudioStartedAt = null;
        this.cueAudioMs = 0;
        this.setState({ stage: "cue", phase, phaseEndsAt: null, phaseSeconds: this.secondsFor(phase) });
        this.opts.sendCue(START_CUE[phase]);
        this.schedule(CUE_FALLBACK_MS, () => this.beginRecording());
    }

    private beginRecording(): void {
        const phase = this.state.phase;
        if (this.state.stage !== "cue" || !phase) return;
        const seconds = this.secondsFor(phase);
        this.setState({ stage: "recording", phase, phaseEndsAt: Date.now() + seconds * 1000, phaseSeconds: seconds });
        this.opts.onPhaseStart(phase);
        this.schedule(seconds * 1000, () => this.endPhase());
    }

    private endPhase(): void {
        const phase = this.state.phase;
        if (this.state.stage !== "recording" || !phase) return;
        this.opts.onPhaseEnd(phase);
        if (phase === "eyes_open") {
            this.speakCue("eyes_closed");
        } else {
            this.finish(phase === "eyes_closed", false);
        }
    }

    private finish(eyesClosed: boolean, skipped: boolean): void {
        this.clearTimer();
        this.setState({ stage: "done", phase: null, phaseEndsAt: null, phaseSeconds: 0 });
        this.opts.onComplete({ eyesClosed, skipped });
    }

    private secondsFor(phase: BaselinePhase): number {
        return phase === "eyes_open" ? this.opts.eyesOpenSeconds : this.opts.eyesClosedSeconds;
    }

    private schedule(ms: number, fn: () => void): void {
        this.clearTimer();
        this.timer = setTimeout(fn, ms);
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private setState(next: BaselineProtocolState): void {
        this.state = next;
        this.opts.onChange?.(next);
    }
}
