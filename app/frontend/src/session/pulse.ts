// Beat detection and pulse-rate variability from PPG.
//
// This is PRV — pulse rate variability from an optical sensor — not ECG-derived
// HRV. The pulse takes a varying moment to travel from heart to forehead, so
// these numbers carry a little variation that is not cardiac. Label them as PRV.
//
// Timing must come from the packet sequence number, never from `t_ms`: arrival
// timestamps carry tens of milliseconds of jitter, the same order as the signal
// being measured. See docs/muse-2-findings.md.

/** Shortest and longest credible beat-to-beat interval (200 bpm .. 30 bpm). */
export const MIN_IBI_MS = 300;
export const MAX_IBI_MS = 2000;
/** An interval this far from the local median is an artefact, not a heartbeat. */
export const ECTOPIC_TOLERANCE = 0.3;

export interface PulseMetrics {
    /** Intervals that survived plausibility gating, in order. */
    ibiMs: number[];
    bpm: number | null;
    sdnnMs: number | null;
    rmssdMs: number | null;
    /** Raw intervals thrown out as implausible. */
    rejected: number;
}

/** Centred, so the filtering introduces no phase lag to shift beat times. */
function movingAverageCentred(x: number[], w: number): number[] {
    if (w <= 1) return x.slice();
    const half = w >> 1;
    const pre = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) pre[i + 1] = pre[i] + x[i];
    const out = new Array<number>(x.length);
    for (let i = 0; i < x.length; i++) {
        const a = Math.max(0, i - half);
        const b = Math.min(x.length, i + half + 1);
        out[i] = (pre[b] - pre[a]) / (b - a);
    }
    return out;
}

/** Keeps only the band a heartbeat can live in: baseline wander out, noise out. */
function bandpass(x: number[], fs: number, lowHz: number, highHz: number): number[] {
    const base = movingAverageCentred(x, Math.max(3, Math.round(fs / lowHz)));
    const hp = x.map((v, i) => v - base[i]);
    return movingAverageCentred(hp, Math.max(1, Math.round(fs / (2 * highHz))));
}

/** Strongest frequency in the band, by Goertzel scan. Sets the expected beat spacing. */
function dominantHz(x: number[], fs: number, lo: number, hi: number): number {
    const n = Math.min(x.length, fs * 40); // 40 s is ample, and keeps this cheap
    let best = lo;
    let bestPower = -1;
    for (let f = lo; f <= hi; f += 0.01) {
        const coeff = 2 * Math.cos((2 * Math.PI * f) / fs);
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < n; i++) {
            const s = x[i] + coeff * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        if (power > bestPower) {
            bestPower = power;
            best = f;
        }
    }
    return best;
}

const median = (v: number[]): number => {
    if (v.length === 0) return 0;
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * A detection threshold per block of roughly eight beats, linearly interpolated
 * between block centres.
 *
 * This is the part that matters on real recordings: PPG amplitude drifts with
 * contact and perfusion, and a single artefact can dwarf the pulse. A threshold
 * taken from the whole recording at once goes deaf wherever the pulse is weaker
 * than average — on a real Muse 2 session that cost 90% of the beats.
 */
function localThresholds(peaks: { i: number; v: number }[], length: number, blockLen: number): number[] {
    // Built from the MEDIAN height of the candidate peaks in each block. A mean,
    // or any top-percentile, lets a single loud artefact raise the bar for every
    // real beat beside it — which is exactly how the first version went deaf.
    const allHeights = median(peaks.map(p => p.v));
    const blocks: { centre: number; thr: number }[] = [];
    for (let a = 0; a < length; a += blockLen) {
        const b = Math.min(length, a + blockLen);
        const here = peaks.filter(p => p.i >= a && p.i < b).map(p => p.v);
        const strength = here.length >= 3 ? median(here) : allHeights;
        blocks.push({ centre: (a + b) / 2, thr: 0.5 * strength });
    }
    const out = new Array<number>(length);
    for (let i = 0; i < length; i++) {
        let k = 0;
        while (k < blocks.length - 1 && blocks[k + 1].centre < i) k++;
        const lo = blocks[k];
        const hi = blocks[Math.min(k + 1, blocks.length - 1)];
        if (hi.centre === lo.centre) {
            out[i] = lo.thr;
        } else {
            const f = Math.min(1, Math.max(0, (i - lo.centre) / (hi.centre - lo.centre)));
            out[i] = lo.thr + f * (hi.thr - lo.thr);
        }
    }
    return out;
}

/**
 * Beat times in milliseconds, measured on the systolic upstroke.
 *
 * Every beat carries the same small offset from using the upstroke rather than
 * the waveform peak, and that offset cancels out of the intervals PRV is
 * computed from. `t0Ms` is the time of the first sample.
 */
export function detectBeats(samples: number[], sampleRateHz: number, t0Ms = 0): number[] {
    const fs = sampleRateHz;
    if (samples.length < fs * 2) return [];

    const bp = bandpass(samples, fs, 1000 / MAX_IBI_MS, 1000 / MIN_IBI_MS);
    let amplitude = 0;
    let scale = 0;
    for (let i = 0; i < bp.length; i++) {
        amplitude = Math.max(amplitude, Math.abs(bp[i]));
        scale = Math.max(scale, Math.abs(samples[i]));
    }
    // A flat trace carries no pulse, only floating-point dust.
    if (!(amplitude > 0) || amplitude < 1e-6 * scale) return [];

    // Estimate the rate from a clipped copy: one loud artefact would otherwise
    // dominate the spectrum and drag the estimate to the bottom of the band.
    const typical = median(bp.map(Math.abs));
    const ceiling = 6 * (typical > 0 ? typical : amplitude);
    const clipped = bp.map(v => Math.max(-ceiling, Math.min(ceiling, v)));
    const f0 = dominantHz(clipped, fs, 1000 / MAX_IBI_MS, 1000 / MIN_IBI_MS);
    const expectedIbiMs = 1000 / f0;
    // Capped, so a bad rate estimate cannot collapse this back to one global
    // threshold — the failure this whole design exists to avoid.
    const blockLen = Math.min(Math.max(Math.round((8 * fs) / f0), fs * 4), fs * 12);
    // Every positive local maximum is a candidate; the threshold then decides.
    const candidates: { i: number; v: number }[] = [];
    for (let i = 1; i < bp.length - 1; i++) {
        if (bp[i] > 0 && bp[i] > bp[i - 1] && bp[i] >= bp[i + 1]) candidates.push({ i, v: bp[i] });
    }
    if (candidates.length === 0) return [];
    const thr = localThresholds(candidates, bp.length, blockLen);
    // Long enough to swallow a dicrotic notch, short enough to keep a fast beat.
    const refractoryMs = Math.min(700, Math.max(MIN_IBI_MS, 0.5 * expectedIbiMs));
    const refractory = (refractoryMs / 1000) * fs;

    const kept: { i: number; v: number }[] = [];
    for (const c of candidates) {
        if (c.v <= thr[c.i]) continue;
        const last = kept[kept.length - 1];
        if (last && c.i - last.i < refractory) {
            if (c.v > last.v) kept[kept.length - 1] = c;
        } else {
            kept.push(c);
        }
    }

    // Sub-sample refinement: one sample at 64 Hz is 15.6 ms, a large slice of
    // the beat-to-beat variation being measured.
    return kept.map(({ i }) => {
        const y0 = bp[i - 1] ?? bp[i];
        const y1 = bp[i];
        const y2 = bp[i + 1] ?? bp[i];
        const denom = y0 - 2 * y1 + y2;
        const shift = denom === 0 ? 0 : (0.5 * (y0 - y2)) / denom;
        return t0Ms + ((i + shift) / fs) * 1000;
    });
}

/** SDNN and RMSSD over the intervals that survive plausibility gating. */
export function pulseMetrics(beatTimesMs: number[]): PulseMetrics {
    const raw = beatTimesMs.slice(1).map((t, i) => t - beatTimesMs[i]);
    const inRange = raw.map(v => v >= MIN_IBI_MS && v <= MAX_IBI_MS);

    // Ectopic / missed-beat rejection against the median of what is left.
    const med = median(raw.filter((_, i) => inRange[i]));
    const ok = raw.map((v, i) => inRange[i] && (med === 0 || Math.abs(v - med) <= ECTOPIC_TOLERANCE * med));

    const ibiMs = raw.filter((_, i) => ok[i]);
    const rejected = raw.length - ibiMs.length;
    if (ibiMs.length === 0) return { ibiMs, bpm: null, sdnnMs: null, rmssdMs: null, rejected };

    const mean = ibiMs.reduce((a, b) => a + b, 0) / ibiMs.length;
    const bpm = 60_000 / mean;
    const sdnnMs =
        ibiMs.length < 2 ? null : Math.sqrt(ibiMs.reduce((a, b) => a + (b - mean) ** 2, 0) / (ibiMs.length - 1));

    // Successive differences only across intervals that were adjacent in the
    // original series; a rejected interval breaks the chain rather than joining
    // its neighbours together.
    const diffs: number[] = [];
    for (let i = 1; i < raw.length; i++) if (ok[i] && ok[i - 1]) diffs.push(raw[i] - raw[i - 1]);
    const rmssdMs = diffs.length === 0 ? null : Math.sqrt(diffs.reduce((a, b) => a + b * b, 0) / diffs.length);

    return { ibiMs, bpm, sdnnMs, rmssdMs, rejected };
}
