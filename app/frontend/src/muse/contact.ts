// Muse headband fit indicator — is each sensor (TP9, AF7, AF8, TP10) touching the skin?
//
// Port of CIQEyeProbe's MuseContact.swift (iOS). It does NOT use Muse's own horseshoe /
// isGood packets: it judges each sensor from its raw EEG. A sensor that has lost skin
// contact gets NOISIER, not quieter, so we take the median absolute step between
// consecutive samples over the last ~2 s (512 samples at 256 Hz). The median keeps a
// single head movement or blink from turning a sensor red.
//
// Thresholds come from very little data: 8 recorded sensors (5 working at 8.8–17.6 µV,
// 3 floating at 104–230 µV) across 2 people, with nothing seen between 18 and 100. One
// threshold covers forehead and behind-ear sensors, and it hasn't been compared with
// Muse's built-in fit signal — so this is an approximate check and a warning only.

import type { EegChannel } from "./protocol";

export const CONTACT = {
    /** ~2 s at 256 Hz — long enough that one movement doesn't condemn a sensor, short
     * enough that an adjustment shows quickly. */
    windowSamples: 512,
    /** ~0.5 s — below this the state is "unknown", so a band that was just switched on
     * doesn't flash red before it has been fitted. */
    minSamples: 128,
    marginalAboveUv: 25,
    floatingAboveUv: 50,
    expectedRateHz: 256,
    /** Observed EEG rate this far from 256 Hz means the 512-sample window isn't ~2 s. */
    rateToleranceFraction: 0.1
} as const;

/** Same names as the iOS app — a fixed data format for the saved snapshots. */
export type ContactQuality = "good" | "marginal" | "floating" | "unknown";

export interface ContactSnapshot {
    label: "baseline_start" | "baseline_end";
    t_ms: number;
    // Only the sensors judged (TP9, AF7, AF8, TP10 — never AUX).
    muse_contact: Partial<Record<EegChannel, ContactQuality>>;
    muse_contact_noise_uv: Partial<Record<EegChannel, number | null>>;
    eeg_rate_hz_observed: number | null;
}

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function newestWindow(samples: ArrayLike<number>): number[] {
    const start = Math.max(0, samples.length - CONTACT.windowSamples);
    return Array.from({ length: samples.length - start }, (_, i) => samples[start + i]);
}

/** Median |Δ| between consecutive samples in µV over the newest window, or null with < 2 samples. */
export function contactNoise(samples: ArrayLike<number>): number | null {
    const w = newestWindow(samples);
    if (w.length < 2) return null;
    const steps: number[] = [];
    for (let i = 1; i < w.length; i++) steps.push(Math.abs(w[i] - w[i - 1]));
    return median(steps);
}

export function contactQuality(samples: ArrayLike<number>): ContactQuality {
    if (newestWindow(samples).length < CONTACT.minSamples) return "unknown";
    const noise = contactNoise(samples)!;
    if (noise > CONTACT.floatingAboveUv) return "floating";
    if (noise > CONTACT.marginalAboveUv) return "marginal";
    return "good";
}

/** True when the observed EEG rate is known and too far from 256 Hz to trust the 2 s window. */
export function rateLooksWrong(rateHz: number | null): boolean {
    return rateHz !== null && Math.abs(rateHz - CONTACT.expectedRateHz) > CONTACT.expectedRateHz * CONTACT.rateToleranceFraction;
}

export function contactSnapshot(
    label: ContactSnapshot["label"],
    tMs: number,
    channels: readonly EegChannel[],
    getSamples: (ch: EegChannel) => ArrayLike<number>,
    rateHz: number | null
): ContactSnapshot {
    const muse_contact: ContactSnapshot["muse_contact"] = {};
    const muse_contact_noise_uv: ContactSnapshot["muse_contact_noise_uv"] = {};
    for (const ch of channels) {
        const samples = getSamples(ch);
        muse_contact[ch] = contactQuality(samples);
        const noise = contactNoise(samples);
        muse_contact_noise_uv[ch] = noise === null ? null : Math.round(noise * 10) / 10;
    }
    return {
        label,
        t_ms: Math.round(tMs * 10) / 10,
        muse_contact,
        muse_contact_noise_uv,
        eeg_rate_hz_observed: rateHz === null ? null : Math.round(rateHz * 10) / 10
    };
}
