// Signal stability per EEG channel, derived from the spread of the last second
// of samples. This is NOT InterAxon's HSI / horseshoe fit score — that is
// computed inside LibMuse and never transmitted. Thresholds are starting
// points for the science team to tune.

export type Stability = "unstable" | "settling" | "stable";

// Calibrated 2026-09-04 against LibMuse's own HSI: 532 channel-seconds of
// LibMuse EEG, rescaled to our units, scored against the HSI it reported for the
// same second. Caveat recorded there and worth repeating: std is a WEAK proxy
// for HSI. The best single threshold separates HSI-good from HSI-bad with only
// 83.5% accuracy, and lets 92% of bad seconds through. This tracks signal
// spread, not electrode fit, and the two are not the same measurement.
export const FLAT_STD_UV = 1.5; // below: electrode floating / no contact
export const NOISY_STD_UV = 150; // above: motion, EMG, or poor contact
export const RAIL_UV = 990; // any |sample| at or beyond: amplifier railed
export const STABLE_STD_UV = 60; // keeps 91% of HSI-good seconds (40 kept only 78%)
export const MIN_SAMPLES = 32;

export function stabilityOf(samples: ArrayLike<number>): Stability {
    const n = samples.length;
    if (n < MIN_SAMPLES) return "settling";
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const v = samples[i];
        if (Math.abs(v) >= RAIL_UV) return "unstable";
        sum += v;
    }
    const mean = sum / n;
    let sq = 0;
    for (let i = 0; i < n; i++) sq += (samples[i] - mean) ** 2;
    const std = Math.sqrt(sq / n);
    if (std < FLAT_STD_UV || std > NOISY_STD_UV) return "unstable";
    if (std <= STABLE_STD_UV) return "stable";
    return "settling";
}

/** Fixed-size ring buffer of the most recent samples. */
export class RollingWindow {
    private buf: Float32Array;
    private head = 0;
    private filled = 0;

    constructor(size = 256) {
        this.buf = new Float32Array(size);
    }

    push(values: number[]): void {
        for (const v of values) {
            this.buf[this.head] = v;
            this.head = (this.head + 1) % this.buf.length;
            if (this.filled < this.buf.length) this.filled++;
        }
    }

    count(): number {
        return this.filled;
    }

    /** Oldest → newest. */
    values(): Float32Array {
        const out = new Float32Array(this.filled);
        const start = (this.head - this.filled + this.buf.length) % this.buf.length;
        for (let i = 0; i < this.filled; i++) out[i] = this.buf[(start + i) % this.buf.length];
        return out;
    }
}
