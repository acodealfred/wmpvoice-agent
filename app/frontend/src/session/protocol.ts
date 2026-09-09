// The bench protocol as data, plus a pure state machine over it.
//
// There is no timer in here. The page already ticks while recording and simply
// asks "which step am I on at this session time?", so the guide cannot drift
// away from the packet timestamps it is meant to label.

export interface ProtocolStep {
    /** Short name; this is what lands in the session file. */
    label: string;
    /** What the operator reads on screen. */
    instruction: string;
    seconds: number;
}

export interface Marker {
    label: string;
    t_ms_start: number;
    t_ms_end: number;
}

export type ProtocolState = { done: true } | { done: false; index: number; total: number; step: ProtocolStep; remainingMs: number };

// Order matters: a jaw clench displaces the electrodes by hundreds of microvolts
// and they take tens of seconds to recover, so everything that disturbs contact
// runs after the measurement that needs it stable.
export const BENCH_PROTOCOL: ProtocolStep[] = [
    { label: "baseline", instruction: "Sit still, eyes open, looking straight ahead.", seconds: 20 },
    { label: "eyes closed", instruction: "Close your eyes and stay still.", seconds: 60 },
    { label: "eyes open", instruction: "Open your eyes. Sit still.", seconds: 10 },
    { label: "blinks", instruction: "Blink deliberately, about once a second.", seconds: 10 },
    { label: "jaw clench", instruction: "Clench your jaw and hold it.", seconds: 5 }
];

export function protocolDurationMs(steps: ProtocolStep[]): number {
    return steps.reduce((total, s) => total + s.seconds * 1000, 0);
}

export class ProtocolRun {
    /** Session time at which each step ends, cumulative. */
    private readonly ends: number[];

    constructor(
        private readonly steps: ProtocolStep[],
        private readonly startedAtMs: number
    ) {
        let acc = startedAtMs;
        this.ends = steps.map(s => (acc += s.seconds * 1000));
    }

    /** `tMs` is session time, the same clock every reading carries. */
    at(tMs: number): ProtocolState {
        const index = this.ends.findIndex(end => tMs < end);
        if (index < 0) return { done: true };
        return {
            done: false,
            index,
            total: this.steps.length,
            step: this.steps[index],
            remainingMs: this.ends[index] - tMs
        };
    }

    /**
     * One marker per step that has begun, the step in progress clipped to `tMs`
     * so a run stopped half way still describes what was recorded.
     */
    marks(tMs: number): Marker[] {
        const out: Marker[] = [];
        this.steps.forEach((step, i) => {
            const start = i === 0 ? this.startedAtMs : this.ends[i - 1];
            const end = Math.min(this.ends[i], tMs);
            if (end > start) out.push({ label: step.label, t_ms_start: start, t_ms_end: end });
        });
        return out;
    }
}
