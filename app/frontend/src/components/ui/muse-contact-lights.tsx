import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import type { EegChannel } from "@/muse";
import { contactNoise, contactQuality, rateLooksWrong, type ContactQuality } from "@/muse/contact";

// Refresh rate of the lights — the same 0.5 s the iOS probe publishes at.
const REFRESH_MS = 500;

const DOT: Record<ContactQuality, string> = {
    good: "var(--ciq-accent-green)",
    marginal: "var(--ciq-accent-amber)",
    floating: "var(--ciq-accent-red)",
    unknown: "var(--ciq-text-40)"
};

const STATE_LABEL: Record<ContactQuality, string> = {
    good: "good contact",
    marginal: "marginal contact",
    floating: "not touching the skin",
    unknown: "waiting for signal"
};

type Reading = { ch: EegChannel; quality: ContactQuality; noise: number | null };

/**
 * Four headband fit lights (TP9 · AF7 · AF8 · TP10), judged from each sensor's raw EEG
 * noise (muse/contact.ts). Shown while fitting the band and during the baseline. A red
 * light is a warning only — nothing is blocked; the thresholds are an approximate check.
 */
export function MuseContactLights({
    channels,
    getChannelSamples,
    getEegRateHz
}: {
    channels: readonly EegChannel[];
    getChannelSamples: (ch: EegChannel) => Float32Array;
    getEegRateHz: () => number | null;
}) {
    const [readings, setReadings] = useState<Reading[]>([]);
    const [rateHz, setRateHz] = useState<number | null>(null);

    useEffect(() => {
        const tick = () => {
            setReadings(
                channels.map(ch => {
                    const samples = getChannelSamples(ch);
                    return { ch, quality: contactQuality(samples), noise: contactNoise(samples) };
                })
            );
            setRateHz(getEegRateHz());
        };
        tick();
        const id = setInterval(tick, REFRESH_MS);
        return () => clearInterval(id);
    }, [channels, getChannelSamples, getEegRateHz]);

    const anyFloating = readings.some(r => r.quality === "floating");

    return (
        <div className="rounded-lg bg-black/20 px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[color:var(--ciq-text-60)]">Headband fit</p>
                <p className="text-[10px] text-[color:var(--ciq-text-40)]">approximate · µV noise</p>
            </div>
            <ul className="grid grid-cols-4 gap-1" aria-label="Headband sensor contact">
                {readings.map(r => (
                    <li key={r.ch} className="flex flex-col items-center gap-0.5" title={`${r.ch}: ${STATE_LABEL[r.quality]}`}>
                        <span className="text-[10px] font-semibold text-[color:var(--ciq-text-68)]">{r.ch}</span>
                        <span
                            className="h-[11px] w-[11px] rounded-full"
                            style={{ background: DOT[r.quality] }}
                            role="img"
                            aria-label={`${r.ch} ${STATE_LABEL[r.quality]}`}
                        />
                        <span className="font-data text-[10px] text-[color:var(--ciq-text-40)]">{r.noise === null ? "--" : r.noise.toFixed(0)}</span>
                    </li>
                ))}
            </ul>
            {anyFloating && (
                <p className="mt-1.5 flex items-center gap-1 text-[11px] text-[color:var(--ciq-accent-amber)]" role="status">
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                    Damp the forehead and the pads, then refit.
                </p>
            )}
            {rateLooksWrong(rateHz) && (
                <p className="mt-1 text-[11px] text-[color:var(--ciq-accent-amber)]" role="status">
                    Unexpected EEG rate ({rateHz!.toFixed(0)} Hz, expected 256) — fit readings may be off.
                </p>
            )}
        </div>
    );
}
