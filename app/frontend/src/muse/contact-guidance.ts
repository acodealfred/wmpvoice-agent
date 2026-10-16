// What to tell the person when a headband sensor isn't reading well — where the sensor is
// and a few steps to get it green. Pure data, so it can be tested without a DOM.
//
// DRAFT WORDING: general Muse placement advice, not yet reviewed against the device or the
// pilot. The lights are a warning only (muse/contact.ts), so these are suggestions.

import type { ContactQuality } from "./contact";
import type { EegChannel } from "./protocol";

export type SensorRegion = "ear" | "forehead";
export type SensorSide = "left" | "right";

export interface SensorSite {
    region: SensorRegion;
    side: SensorSide;
}

/** TP9/TP10 are the temporal sensors on the band's arms; AF7/AF8 are the forehead sensors. */
export const SENSOR_SITES: Partial<Record<EegChannel, SensorSite>> = {
    TP9: { region: "ear", side: "left" },
    TP10: { region: "ear", side: "right" },
    AF7: { region: "forehead", side: "left" },
    AF8: { region: "forehead", side: "right" }
};

/** Front view as in a mirror — the person's left is on the left of the picture. */
export const DIAGRAM_VIEWBOX = { width: 100, height: 100 } as const;

export const DIAGRAM_POINTS: Partial<Record<EegChannel, { x: number; y: number }>> = {
    TP9: { x: 17, y: 56 },
    TP10: { x: 83, y: 56 },
    AF7: { x: 36, y: 30 },
    AF8: { x: 64, y: 30 }
};

export interface ContactGuidance {
    title: string;
    summary: string;
    where: string;
    steps: string[];
}

const EAR_STEPS = [
    "Part the hair around the pad so it touches bare skin, not hair.",
    "Lightly dampen the pad with a drop of water.",
    "Move the band so the pad sits snugly just behind and above the ear.",
    "Move glasses arms and earrings out of the way."
];

const FOREHEAD_STEPS = [
    "Push any fringe or hair off the forehead so the pad touches bare skin.",
    "Wipe the forehead dry and clean; oil and make-up weaken contact.",
    "Lightly dampen the pad with a drop of water.",
    "Seat the band flat across the forehead and press it gently."
];

export function contactGuidance(ch: EegChannel, quality: ContactQuality): ContactGuidance | null {
    if (quality !== "floating" && quality !== "marginal") return null;
    const site = SENSOR_SITES[ch];
    if (!site) return null;

    const sideWord = site.side === "left" ? "left" : "right";
    const where = site.region === "ear" ? `${sideWord} ear, behind and just above it` : `${sideWord} side of the forehead`;
    return {
        title: `${ch} · ${where}`,
        summary: quality === "floating" ? "This sensor is not touching the skin." : "This sensor is nearly in contact — a small adjustment should do it.",
        where,
        steps: site.region === "ear" ? EAR_STEPS : FOREHEAD_STEPS
    };
}
