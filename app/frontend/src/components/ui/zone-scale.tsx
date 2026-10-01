import { PILL, TEXT_TONE } from "@/lib/badges";
import { LEAN_HINT, LEAN_LABEL, ZONE_DISCLAIMER, ZONE_LABEL, ZONE_TONE, hasMarker, scaleAriaLabel, trendBadge } from "@/lib/zone";
import type { ZoneResult, ZoneTrend } from "@/types";

/** Fatigue ↔ Burnout line + strain zone + trend badge + approximate signal chips. Own data only. */
export function ZoneScale({ zone, trend }: { zone: ZoneResult; trend?: ZoneTrend }) {
    const badge = trend ? trendBadge(trend.status) : null;
    const marked = hasMarker(zone);

    return (
        <div>
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <p className={`text-lg font-semibold ${TEXT_TONE[ZONE_TONE[zone.zone]]}`}>{ZONE_LABEL[zone.zone]}</p>
                    <p className="text-xs text-[color:var(--ciq-text-60)]">Strain {zone.severity} / 100 · lower is better</p>
                </div>
                {badge && <span className={`rounded-full px-3 py-1 text-xs font-medium ${PILL[badge.tone]}`}>{badge.text}</span>}
            </div>

            <div className="mt-5">
                <div className="flex justify-between text-xs font-medium text-[color:var(--ciq-text-60)]">
                    <span>Fatigue</span>
                    <span>Burnout</span>
                </div>
                <div
                    role="img"
                    aria-label={scaleAriaLabel(zone)}
                    className={`relative mt-2 h-2 rounded-full bg-gradient-to-r from-[color:var(--ciq-accent-amber)] to-[color:var(--ciq-accent-red)] ${marked ? "" : "opacity-30 grayscale"}`}
                >
                    {marked && (
                        <span
                            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--ciq-card)] bg-[color:var(--ciq-text-strong)]"
                            style={{ left: `${zone.marker}%` }}
                        />
                    )}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-[color:var(--ciq-text-40)]">
                    <span>rest likely helps</span>
                    <span>situation may need to change</span>
                </div>
            </div>

            <p className="mt-3 text-sm text-[color:var(--ciq-text-86)]">
                {zone.lean !== "none" && <b>{LEAN_LABEL[zone.lean]}. </b>}
                {LEAN_HINT[zone.lean]}
            </p>

            {zone.signals.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                    {zone.signals.map(s => (
                        <span key={s.key} className={`rounded-full px-2.5 py-1 text-xs ${PILL.neutral}`}>
                            {s.label}
                            {s.approximate && " · approximate"}
                        </span>
                    ))}
                </div>
            )}

            <p className="mt-3 text-xs text-[color:var(--ciq-text-40)]">{ZONE_DISCLAIMER}</p>
        </div>
    );
}
