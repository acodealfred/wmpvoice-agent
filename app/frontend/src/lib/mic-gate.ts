// Half-duplex mic gate: while the agent is speaking, the user's mic audio is not sent,
// so the agent can neither hear its own voice (echo) nor be interrupted.
//
// The gate closes on the first played agent audio chunk and reopens only once BOTH
//   • the response has finished generating (response.done), and
//   • its audio has finished playing (the playback worklet's "drained" signal),
// plus a short tail so the very end of the agent's voice isn't picked up. Needing both
// matters: a network gap between audio chunks can empty the playback queue mid-sentence.
//
// A safety timeout reopens the gate if neither signal arrives for a while, so the
// mic can never stay off for good; reset() reopens it at once (stop / pause / new survey).

export const MIC_REOPEN_TAIL_MS = 300;
export const MIC_SAFETY_TIMEOUT_MS = 30_000;

type Timers = {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
};

const defaultTimers: Timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class MicGate {
    private open = true;
    private generating = false;
    private playing = false;
    private tailTimer: unknown = null;
    private safetyTimer: unknown = null;

    constructor(
        private readonly onChange: (open: boolean) => void = () => {},
        private readonly timers: Timers = defaultTimers
    ) {}

    isOpen(): boolean {
        return this.open;
    }

    /** A chunk of agent audio was handed to the player. */
    agentAudio(): void {
        this.generating = true;
        this.playing = true;
        this.clearTail();
        this.armSafety();
        this.setOpen(false);
    }

    /**
     * Close the mic ahead of an agent turn the app is about to request (e.g. the report
     * explanation), so no stray user audio can trigger a competing server-VAD reply first.
     * Reopens like any agent turn — once it has been generated and played — or via the
     * safety timeout if the turn never arrives.
     */
    hold(): void {
        this.agentAudio();
    }

    /** The agent's response finished generating (response.done). */
    responseDone(): void {
        if (this.open) return;
        this.generating = false;
        this.maybeReopen();
    }

    /** All queued agent audio has played out (or was stopped). */
    drained(): void {
        if (this.open) return;
        this.playing = false;
        this.maybeReopen();
    }

    /** Reopen immediately and forget any pending state (stop / pause / new survey / reconnect). */
    reset(): void {
        this.generating = false;
        this.playing = false;
        this.clearTail();
        this.clearSafety();
        this.setOpen(true);
    }

    private maybeReopen(): void {
        if (this.generating || this.playing || this.tailTimer !== null) return;
        this.armSafety();
        this.tailTimer = this.timers.setTimeout(() => {
            this.tailTimer = null;
            this.reset();
        }, MIC_REOPEN_TAIL_MS);
    }

    private armSafety(): void {
        this.clearSafety();
        this.safetyTimer = this.timers.setTimeout(() => {
            this.safetyTimer = null;
            this.reset();
        }, MIC_SAFETY_TIMEOUT_MS);
    }

    private clearTail(): void {
        if (this.tailTimer !== null) {
            this.timers.clearTimeout(this.tailTimer);
            this.tailTimer = null;
        }
    }

    private clearSafety(): void {
        if (this.safetyTimer !== null) {
            this.timers.clearTimeout(this.safetyTimer);
            this.safetyTimer = null;
        }
    }

    private setOpen(open: boolean): void {
        if (this.open === open) return;
        this.open = open;
        this.onChange(open);
    }
}
