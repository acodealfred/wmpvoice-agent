// Fatigue ↔ Burnout zone — display helpers (pure). Numbers/edges mirror
// app/backend/ciq/zone.py ZONE_CONFIG; keep them identical to the BE.
import type { Tone } from "@/lib/badges";
import type { LeanKey, ZoneKey, ZoneResult, ZoneTrendStatus } from "@/types";

export const ZONE_LABEL: Record<ZoneKey, string> = {
    well: "Doing well",
    mild: "Mild strain",
    moderate: "Moderate strain",
    high: "High strain",
};

export const ZONE_TONE: Record<ZoneKey, Tone> = { well: "green", mild: "blue", moderate: "amber", high: "red" };

export const LEAN_LABEL: Record<LeanKey, string> = {
    none: "",
    fatigue: "Fatigue-leaning",
    mixed: "Mixed",
    burnout: "Burnout-leaning",
};

export const LEAN_HINT: Record<LeanKey, string> = {
    none: "Low strain overall, so there is nothing to lean towards.",
    fatigue: "Rest and recovery are likely to help.",
    mixed: "A mix of tiredness and detachment.",
    burnout: "Something about the work situation may need to change.",
};

export const ZONE_BANDS: ReadonlyArray<{ from: number; to: number; zone: ZoneKey }> = [
    { from: 0, to: 25, zone: "well" },
    { from: 25, to: 50, zone: "mild" },
    { from: 50, to: 75, zone: "moderate" },
    { from: 75, to: 100, zone: "high" },
];

export const ZONE_EMPTY_TEXT = "Complete a check-in to see your zone";
export const ZONE_DISCLAIMER = "A wellbeing guide, not a diagnosis.";

const BADGE: Record<ZoneTrendStatus, { text: string; tone: Tone }> = {
    none: { text: "No check-ins yet", tone: "neutral" },
    first: { text: "First check-in", tone: "neutral" },
    improving: { text: "Improving", tone: "green" },
    steady: { text: "Steady", tone: "blue" },
    worsening: { text: "Worsening", tone: "red" },
};

export function trendBadge(status: ZoneTrendStatus): { text: string; tone: Tone } {
    return BADGE[status];
}

export function hasMarker(zone: Pick<ZoneResult, "marker">): boolean {
    return zone.marker !== null;
}

export function scaleAriaLabel(zone: Pick<ZoneResult, "marker" | "lean">): string {
    if (zone.marker === null) return "Fatigue to burnout scale: low strain, no lean";
    return `Fatigue to burnout scale: marker at ${zone.marker} of 100, ${LEAN_LABEL[zone.lean].toLowerCase()}`;
}
