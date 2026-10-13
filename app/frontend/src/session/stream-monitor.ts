// Diagnostics for the headband stream: notices when packets stop arriving and
// records why a recording ended early. Observes only — it never touches the
// recorder, the chart buffers or the Bluetooth link.
export type StreamName = "eeg" | "imu" | "ppg" | "telemetry";

export type DiagEventType = "stall" | "resumed" | "disconnected" | "heartbeat";

export interface DiagEvent {
    /** Wall-clock ISO timestamp, so an event can be lined up with the server's survey timeline. */
    wall: string;
    type: DiagEventType;
    data?: Record<string, unknown>;
}

export interface MonitorOptions {
    /** Monotonic milliseconds. */
    now: () => number;
    wallClock?: () => string;
    /** Silence on a stream that has already sent something, past which it counts as stalled. */
    stallMs?: number;
    log?: (e: DiagEvent) => void;
}

const STREAMS: StreamName[] = ["eeg", "imu", "ppg", "telemetry"];
export const DEFAULT_STALL_MS = 2000;

export class StreamMonitor {
    private lastSeen = new Map<StreamName, number>();
    private counts: Record<StreamName, number> = { eeg: 0, imu: 0, ppg: 0, telemetry: 0 };
    private stalled = new Set<StreamName>();
    private battery: { batteryPercent: number; fuelGaugeMv: number } | null = null;
    private log: ((e: DiagEvent) => void) | undefined;
    private history: DiagEvent[] = [];
    private stallMs: number;
    private now: () => number;
    private wallClock: () => string;

    constructor(opts: MonitorOptions) {
        this.now = opts.now;
        this.wallClock = opts.wallClock ?? (() => new Date().toISOString());
        this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
        this.log = opts.log;
    }

    /** Call for every packet as it arrives, before any pause filtering, so silence means silence on the link. */
    note(stream: StreamName): void {
        const t = this.now();
        if (this.stalled.has(stream)) {
            const lastBefore = this.lastSeen.get(stream) ?? t;
            this.stalled.delete(stream);
            this.emit("resumed", { stream, gapMs: Math.round(t - lastBefore) });
        }
        this.lastSeen.set(stream, t);
        this.counts[stream]++;
    }

    noteTelemetry(batteryPercent: number, fuelGaugeMv: number): void {
        this.battery = { batteryPercent, fuelGaugeMv };
    }

    /** Call on a timer. Flags each stalled stream once per silent stretch. */
    check(): void {
        const t = this.now();
        for (const stream of STREAMS) {
            const last = this.lastSeen.get(stream);
            if (last === undefined || this.stalled.has(stream)) continue;
            const silentMs = t - last;
            if (silentMs > this.stallMs) {
                this.stalled.add(stream);
                this.emit("stall", { stream, silentMs: Math.round(silentMs) });
            }
        }
    }

    disconnected(): void {
        this.emit("disconnected", { silentMs: this.silence(), counts: { ...this.counts }, ...(this.battery ?? {}) });
    }

    heartbeat(extra: Record<string, unknown> = {}): void {
        this.emit("heartbeat", { counts: { ...this.counts }, silentMs: this.silence(), ...(this.battery ?? {}), ...extra });
    }

    /** Everything logged so far, oldest first. */
    events(): DiagEvent[] {
        return [...this.history];
    }

    private silence(): Record<string, number> {
        const t = this.now();
        const out: Record<string, number> = {};
        for (const [stream, last] of this.lastSeen) out[stream] = Math.round(t - last);
        return out;
    }

    private emit(type: DiagEventType, data: Record<string, unknown>): void {
        const e: DiagEvent = { wall: this.wallClock(), type, data };
        this.history.push(e);
        this.log?.(e);
    }
}
