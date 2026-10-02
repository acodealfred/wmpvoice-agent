// Fatigue ↔ Burnout zone — labels, colours and copy for GET /api/zone-trend.
//
// All figures come from the backend (ciq/zone.py); this module only decides how
// to present them. A wellbeing guide, not a diagnosis.

import { apiFetch } from "@/lib/api";
import type { ZoneKey, ZoneLean, ZoneTrend, ZoneTrendResponse } from "@/types";

export const ZONE_DISCLAIMER = "A wellbeing guide, not a diagnosis.";
export const ZONE_EMPTY_TEXT = "Complete a check-in to see your zone.";
export const ZONE_UNAVAILABLE_TEXT = "Zone unavailable right now.";

/** Severity zone edges (lower bound of each zone) — shaded bands on the chart. */
export const ZONE_BANDS: { zone: ZoneKey; from: number; to: number }[] = [
    { zone: "well", from: 0, to: 25 },
    { zone: "mild", from: 25, to: 50 },
    { zone: "moderate", from: 50, to: 75 },
    { zone: "high", from: 75, to: 100 }
];

const ZONE_LABEL: Record<ZoneKey, string> = {
    well: "Doing well",
    mild: "Mild strain",
    moderate: "Moderate strain",
    high: "High strain"
};

const ZONE_COLOR: Record<ZoneKey, string> = {
    well: "var(--ciq-accent-green)",
    mild: "var(--ciq-accent-blue)",
    moderate: "var(--ciq-accent-amber)",
    high: "var(--ciq-accent-red)"
};

const LEAN_LABEL: Record<ZoneLean, string> = {
    fatigue: "Fatigue-leaning",
    burnout: "Burnout-leaning",
    mixed: "Mixed",
    none: "No clear lean"
};

const LEAN_HINT: Record<ZoneLean, string> = {
    fatigue: "Mostly tiredness — rest and recovery are likely to help.",
    burnout: "More detachment or loss of control — something about the situation may need to change.",
    mixed: "A mix of tiredness and detachment.",
    none: "Strain is low, so there is no lean to show."
};

export const zoneLabel = (zone: ZoneKey) => ZONE_LABEL[zone];
export const zoneColor = (zone: ZoneKey) => ZONE_COLOR[zone];
export const leanLabel = (lean: ZoneLean) => LEAN_LABEL[lean];
export const leanHint = (lean: ZoneLean) => LEAN_HINT[lean];

/** True when the Fatigue ↔ Burnout line should be greyed out with no marker. */
export const isScaleMuted = (marker: number | null) => marker === null;

export type TrendBadge = { text: string; tone: "good" | "neutral" | "bad" };

/** Badge for the trend's direction. Lower severity is better. */
export function trendBadge(trend: ZoneTrend): TrendBadge {
    switch (trend.status) {
        case "none":
            return { text: "No check-ins yet", tone: "neutral" };
        case "first":
            return { text: "First check-in", tone: "neutral" };
        case "improving":
            return { text: "Improving", tone: "good" };
        case "steady":
            return { text: "Steady", tone: "neutral" };
        case "worsening":
            return { text: "Worsening", tone: "bad" };
    }
}

/** One sentence explaining what the badge compared against, or null when there was no comparison. */
export function trendDetail(trend: ZoneTrend): string | null {
    if (!("compared" in trend)) return null;
    const runs = trend.compared === 1 ? "your previous check-in" : `your previous ${trend.compared} check-ins`;
    const sign = trend.delta > 0 ? "+" : "";
    return `Strain ${sign}${trend.delta} vs ${runs} (average ${trend.ref}).`;
}

/** "2026-09-08" → "Sep 8". The date is a UTC calendar date, so format it in UTC. */
export function formatZoneDate(date: string): string {
    const [y, m, d] = date.split("-").map(Number);
    if (!y || !m || !d) return date;
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** GET /api/zone-trend. Throws on any non-OK response (the caller shows its own fallback). */
export async function fetchZoneTrend(): Promise<ZoneTrendResponse> {
    const res = await apiFetch("/api/zone-trend");
    if (!res.ok) throw new Error(`/api/zone-trend failed (${res.status})`);
    return res.json();
}
