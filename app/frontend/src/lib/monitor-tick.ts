// Live data monitoring — the once-a-second health summary the assessment page sends
// to the backend (WS message "monitor.tick"; backend ciq/monitoring/). It carries
// counts and summary statistics only, never raw EEG samples, so it stays ~300 bytes.

import type { ContactQuality } from "@/muse/contact";
import type { EegChannel } from "@/muse/protocol";

/** One channel's samples since the previous tick. */
export type ChannelHealth = {
    /** Samples received (256 expected per second). */
    n: number;
    /** Non-finite samples (NaN / ±Infinity). */
    nan: number;
    /** Over the finite samples; null when there were none. */
    min: number | null;
    max: number | null;
    std: number | null;
};

/**
 * Accumulates per-channel EEG statistics as packets arrive (O(1) per sample, no
 * buffering), and hands them over — resetting — once per tick.
 */
export class EegHealthAccumulator {
    private stats = new Map<EegChannel, { n: number; nan: number; finite: number; sum: number; sumSq: number; min: number; max: number }>();

    add(ch: EegChannel, samples: ArrayLike<number>): void {
        let s = this.stats.get(ch);
        if (!s) {
            s = { n: 0, nan: 0, finite: 0, sum: 0, sumSq: 0, min: Infinity, max: -Infinity };
            this.stats.set(ch, s);
        }
        for (let i = 0; i < samples.length; i++) {
            const v = samples[i];
            s.n++;
            if (!Number.isFinite(v)) {
                s.nan++;
                continue;
            }
            s.finite++;
            s.sum += v;
            s.sumSq += v * v;
            if (v < s.min) s.min = v;
            if (v > s.max) s.max = v;
        }
    }

    /** Statistics for every channel given (zeros for one that sent nothing), then reset. */
    take(channels: readonly EegChannel[]): Partial<Record<EegChannel, ChannelHealth>> {
        const out: Partial<Record<EegChannel, ChannelHealth>> = {};
        for (const ch of channels) {
            const s = this.stats.get(ch);
            if (!s || s.n === 0) {
                out[ch] = { n: 0, nan: 0, min: null, max: null, std: null };
                continue;
            }
            const mean = s.finite ? s.sum / s.finite : 0;
            const variance = s.finite ? Math.max(0, s.sumSq / s.finite - mean * mean) : 0;
            out[ch] = {
                n: s.n,
                nan: s.nan,
                min: s.finite ? round1(s.min) : null,
                max: s.finite ? round1(s.max) : null,
                std: s.finite ? round1(Math.sqrt(variance)) : null
            };
        }
        this.stats.clear();
        return out;
    }

    reset(): void {
        this.stats.clear();
    }
}

export type MonitorTick = {
    type: "monitor.tick";
    /** Browser wall clock (ms). */
    client_t: number;
    eeg: {
        /** useMuse status: streaming | paused | disconnected | idle | connecting | error. */
        status: string;
        /** The participant started this stretch with the headband connected (EEG expected). */
        expected: boolean;
        battery: number | null;
        rate_hz: number | null;
        /** Real length of the window the channel stats cover (ms); null on the first tick. */
        window_ms: number | null;
        channels: Partial<Record<EegChannel, ChannelHealth>>;
        contact: Partial<Record<EegChannel, ContactQuality>>;
        /** Packets the headband's seq counter says were lost since the previous tick. */
        dropped: number;
        /** Packets in the current recording, and whether it hit its safety cap. */
        recorder_packets: number;
        truncated: boolean;
    };
    camera: { enabled: boolean; face: boolean | null };
};

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Sum of a per-channel dropped-packet record. */
export const totalDropped = (dropped: Record<string, number>): number => Object.values(dropped).reduce((a, b) => a + b, 0);
