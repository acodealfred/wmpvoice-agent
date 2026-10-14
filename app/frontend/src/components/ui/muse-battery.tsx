import { BatteryFull, BatteryLow, BatteryMedium } from "lucide-react";

// Muse headband battery, from its telemetry packets (~every 10 s, muse/decode.ts).
// A full assessment (two 3-min baselines + the survey) needs a reasonable charge, so
// the colour warns early: amber at 20 %, red at 10 %.
export const BATTERY = {
    lowAtOrBelow: 20,
    criticalAtOrBelow: 10
} as const;

export type BatteryLevel = "ok" | "low" | "critical";

export function batteryLevel(percent: number): BatteryLevel {
    if (percent <= BATTERY.criticalAtOrBelow) return "critical";
    if (percent <= BATTERY.lowAtOrBelow) return "low";
    return "ok";
}

const COLOR: Record<BatteryLevel, string> = {
    ok: "var(--ciq-accent-green)",
    low: "var(--ciq-accent-amber)",
    critical: "var(--ciq-accent-red)"
};

/** Battery icon + percentage. Renders nothing until the first telemetry packet arrives. */
export function MuseBattery({ percent }: { percent: number | null }) {
    if (percent === null) return null;
    const level = batteryLevel(percent);
    const Icon = level !== "ok" ? BatteryLow : percent > 50 ? BatteryFull : BatteryMedium;
    return (
        <span
            className="font-data flex items-center gap-1 text-[10px] font-semibold"
            style={{ color: COLOR[level] }}
            role="img"
            aria-label={`Headband battery ${percent}%`}
            title={`Headband battery ${percent}%`}
        >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {percent}%
        </span>
    );
}

/** One-line warning when the charge may not last a full assessment; nothing otherwise. */
export function MuseBatteryWarning({ percent }: { percent: number | null }) {
    if (percent === null || batteryLevel(percent) === "ok") return null;
    return (
        <p className="text-[11px]" style={{ color: COLOR[batteryLevel(percent)] }} role="status">
            Headband battery {percent}% — it may not last the whole assessment. Charge it before starting.
        </p>
    );
}
