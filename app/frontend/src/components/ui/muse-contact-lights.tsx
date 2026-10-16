import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import type { EegChannel } from "@/muse";
import { contactNoise, contactQuality, rateLooksWrong, type ContactQuality } from "@/muse/contact";
import { contactGuidance, DIAGRAM_POINTS, DIAGRAM_VIEWBOX, type ContactGuidance } from "@/muse/contact-guidance";

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

/** Head-and-band picture with the sensor in question highlighted, plus the steps to fix it. */
function SensorHelp({ ch, quality, guidance }: { ch: EegChannel; quality: ContactQuality; guidance: ContactGuidance }) {
    const { width, height } = DIAGRAM_VIEWBOX;
    return (
        <div className="mt-2 flex gap-3 rounded-md bg-white/5 p-2" role="status" data-testid="sensor-help">
            <figure className="shrink-0">
                <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-20" role="img" aria-label={`Diagram: where ${ch} sits on the headband`}>
                    <ellipse cx="50" cy="52" rx="30" ry="38" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
                    <ellipse cx="17" cy="56" rx="4" ry="9" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
                    <ellipse cx="83" cy="56" rx="4" ry="9" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
                    <path d="M17 56 C 20 22, 80 22, 83 56" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="3" />
                    {(Object.keys(DIAGRAM_POINTS) as EegChannel[]).map(c => {
                        const p = DIAGRAM_POINTS[c]!;
                        const active = c === ch;
                        return (
                            <circle
                                key={c}
                                cx={p.x}
                                cy={p.y}
                                r={active ? 6 : 3.5}
                                fill={active ? DOT[quality] : "currentColor"}
                                fillOpacity={active ? 1 : 0.4}
                            />
                        );
                    })}
                </svg>
                <figcaption className="text-center text-[9px] text-[color:var(--ciq-text-40)]">as in a mirror</figcaption>
            </figure>
            <div className="min-w-0">
                <p className="text-[11px] font-semibold text-[color:var(--ciq-text-68)]">{guidance.title}</p>
                <p className="mb-1 text-[11px] text-[color:var(--ciq-text-60)]">{guidance.summary}</p>
                <ol className="list-decimal space-y-0.5 pl-4 text-[11px] text-[color:var(--ciq-text-60)]">
                    {guidance.steps.map(s => (
                        <li key={s}>{s}</li>
                    ))}
                </ol>
            </div>
        </div>
    );
}

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
    const [hovered, setHovered] = useState<EegChannel | null>(null);
    const [pinned, setPinned] = useState<EegChannel | null>(null);

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

    // Hover/focus wins over a tapped (pinned) sensor. Guidance disappears once the sensor is fine.
    const helpFor = hovered ?? pinned;
    const helpReading = readings.find(r => r.ch === helpFor);
    const guidance = helpReading ? contactGuidance(helpReading.ch, helpReading.quality) : null;

    return (
        <div className="rounded-lg bg-black/20 px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[color:var(--ciq-text-60)]">Headband fit</p>
                <p className="text-[10px] text-[color:var(--ciq-text-40)]">approximate · µV noise</p>
            </div>
            <ul className="grid grid-cols-4 gap-1" aria-label="Headband sensor contact">
                {readings.map(r => {
                    const hasHelp = contactGuidance(r.ch, r.quality) !== null;
                    return (
                        <li
                            key={r.ch}
                            className="flex flex-col items-center gap-0.5"
                            title={`${r.ch}: ${STATE_LABEL[r.quality]}`}
                            onMouseEnter={() => hasHelp && setHovered(r.ch)}
                            onMouseLeave={() => setHovered(null)}
                        >
                            <span className="text-[10px] font-semibold text-[color:var(--ciq-text-68)]">{r.ch}</span>
                            {hasHelp ? (
                                <button
                                    type="button"
                                    className="h-[15px] w-[15px] rounded-full p-0 ring-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
                                    style={{ background: DOT[r.quality] }}
                                    aria-label={`${r.ch} ${STATE_LABEL[r.quality]} — how to fix`}
                                    aria-expanded={helpFor === r.ch}
                                    onClick={() => setPinned(p => (p === r.ch ? null : r.ch))}
                                    onFocus={() => setHovered(r.ch)}
                                    onBlur={() => setHovered(null)}
                                />
                            ) : (
                                <span
                                    className="h-[11px] w-[11px] rounded-full"
                                    style={{ background: DOT[r.quality] }}
                                    role="img"
                                    aria-label={`${r.ch} ${STATE_LABEL[r.quality]}`}
                                />
                            )}
                            <span className="font-data text-[10px] text-[color:var(--ciq-text-40)]">{r.noise === null ? "--" : r.noise.toFixed(0)}</span>
                        </li>
                    );
                })}
            </ul>
            {guidance && helpReading && <SensorHelp ch={helpReading.ch} quality={helpReading.quality} guidance={guidance} />}
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
