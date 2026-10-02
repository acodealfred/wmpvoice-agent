import { Activity, Info } from "lucide-react";

import type { ZoneResult, ZoneTrend } from "@/types";
import { ZONE_DISCLAIMER, isScaleMuted, leanHint, leanLabel, trendBadge, trendDetail, zoneColor, zoneLabel, type TrendBadge } from "@/lib/zone";

const BADGE_TONE: Record<TrendBadge["tone"], string> = {
    good: "var(--ciq-accent-green)",
    neutral: "var(--ciq-text-60)",
    bad: "var(--ciq-accent-red)"
};

/**
 * The Fatigue ↔ Burnout line for one check-in: marker (or greyed out when strain is
 * low), the severity zone, the trend badge and any approximate fatigue signals.
 * Personal data only. Biometric chips never affect the marker or the zone.
 */
export function ZoneScale({ latest, trend }: { latest: ZoneResult; trend: ZoneTrend }) {
    const muted = isScaleMuted(latest.marker);
    const badge = trendBadge(trend);
    const detail = trendDetail(trend);
    const color = zoneColor(latest.zone);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
                    <span className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">{zoneLabel(latest.zone)}</span>
                    <span className="text-sm text-[color:var(--ciq-text-60)]">· strain {latest.severity}/100</span>
                </div>
                <span
                    className="rounded-full border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] px-3 py-1 text-xs font-semibold"
                    style={{ color: BADGE_TONE[badge.tone] }}
                >
                    {badge.text}
                </span>
            </div>

            <div>
                <div className={`relative h-2.5 rounded-full ${muted ? "opacity-40" : ""}`} style={{ background: "var(--ciq-track)" }}>
                    <div
                        className="absolute inset-0 rounded-full opacity-60"
                        style={{ background: "linear-gradient(90deg, var(--ciq-accent-amber), var(--ciq-accent-purple), var(--ciq-accent-red))" }}
                        aria-hidden
                    />
                    {!muted && (
                        <div
                            className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--ciq-card)] shadow-md"
                            style={{ left: `${latest.marker}%`, background: color }}
                            role="img"
                            aria-label={`${leanLabel(latest.lean)}: ${latest.marker} on a scale from 0 (fatigue) to 100 (burnout)`}
                        />
                    )}
                </div>
                <div className="mt-2 flex justify-between text-xs font-medium text-[color:var(--ciq-text-60)]">
                    <span>Fatigue</span>
                    <span>Burnout</span>
                </div>
            </div>

            <p className="text-sm leading-relaxed text-[color:var(--ciq-text-86)]">
                {!muted && <b className="font-semibold">{leanLabel(latest.lean)}. </b>}
                {leanHint(latest.lean)}
            </p>

            {detail && <p className="text-xs text-[color:var(--ciq-text-60)]">{detail}</p>}

            {latest.signals.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                    {latest.signals.map(s => (
                        <li
                            key={s.key}
                            className="flex items-center gap-1.5 rounded-full border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] px-3 py-1 text-xs text-[color:var(--ciq-text-86)]"
                        >
                            <Activity className="h-3 w-3 text-[color:var(--ciq-accent-amber)]" aria-hidden />
                            {s.label}
                            <span className="text-[color:var(--ciq-text-40)]">(approximate)</span>
                        </li>
                    ))}
                </ul>
            )}

            <p className="flex items-center gap-1.5 text-xs text-[color:var(--ciq-text-40)]">
                <Info className="h-3 w-3 shrink-0" aria-hidden />
                {ZONE_DISCLAIMER}
            </p>
        </div>
    );
}
