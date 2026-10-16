import { describe, expect, it } from "vitest";

import { contactGuidance, DIAGRAM_POINTS, DIAGRAM_VIEWBOX, SENSOR_SITES } from "./contact-guidance";
import type { ContactQuality } from "./contact";
import type { EegChannel } from "./protocol";

const SENSORS: EegChannel[] = ["TP9", "AF7", "AF8", "TP10"];

describe("contactGuidance", () => {
    it("gives no guidance for sensors that are good or still waiting", () => {
        for (const ch of SENSORS) {
            expect(contactGuidance(ch, "good")).toBeNull();
            expect(contactGuidance(ch, "unknown")).toBeNull();
        }
    });

    it("gives guidance for every sensor that is floating or marginal", () => {
        for (const ch of SENSORS) {
            for (const q of ["floating", "marginal"] as ContactQuality[]) {
                const g = contactGuidance(ch, q);
                expect(g, `${ch} ${q}`).not.toBeNull();
                expect(g!.title).toContain(ch);
                expect(g!.where.length).toBeGreaterThan(0);
                expect(g!.steps.length).toBeGreaterThanOrEqual(3);
                for (const s of g!.steps) expect(s.trim().length).toBeGreaterThan(0);
            }
        }
    });

    it("places each sensor on the right side and region of the head", () => {
        expect(SENSOR_SITES.TP9).toMatchObject({ region: "ear", side: "left" });
        expect(SENSOR_SITES.TP10).toMatchObject({ region: "ear", side: "right" });
        expect(SENSOR_SITES.AF7).toMatchObject({ region: "forehead", side: "left" });
        expect(SENSOR_SITES.AF8).toMatchObject({ region: "forehead", side: "right" });
    });

    it("gives ear sensors hair advice and forehead sensors skin advice", () => {
        const ear = contactGuidance("TP9", "floating")!.steps.join(" ").toLowerCase();
        const forehead = contactGuidance("AF7", "floating")!.steps.join(" ").toLowerCase();
        expect(ear).toContain("hair");
        expect(forehead).toContain("forehead");
        expect(forehead).not.toContain("behind the ear");
    });

    it("says floating needs a refit and marginal only a small adjustment", () => {
        const floating = contactGuidance("TP10", "floating")!;
        const marginal = contactGuidance("TP10", "marginal")!;
        expect(floating.summary).not.toEqual(marginal.summary);
        expect(floating.summary.toLowerCase()).toContain("not touching");
        expect(marginal.summary.toLowerCase()).toContain("nearly");
    });

    it("draws every sensor inside the diagram, left on the left, forehead above ears", () => {
        const { width, height } = DIAGRAM_VIEWBOX;
        for (const ch of SENSORS) {
            const p = DIAGRAM_POINTS[ch]!;
            expect(p.x, ch).toBeGreaterThan(0);
            expect(p.x, ch).toBeLessThan(width);
            expect(p.y, ch).toBeGreaterThan(0);
            expect(p.y, ch).toBeLessThan(height);
        }
        // Mirror view: the person's left is on the left of the picture.
        expect(DIAGRAM_POINTS.TP9!.x).toBeLessThan(DIAGRAM_POINTS.TP10!.x);
        expect(DIAGRAM_POINTS.AF7!.x).toBeLessThan(DIAGRAM_POINTS.AF8!.x);
        expect(DIAGRAM_POINTS.AF7!.x).toBeGreaterThan(DIAGRAM_POINTS.TP9!.x);
        expect(DIAGRAM_POINTS.AF8!.x).toBeLessThan(DIAGRAM_POINTS.TP10!.x);
        expect(DIAGRAM_POINTS.AF7!.y).toBeLessThan(DIAGRAM_POINTS.TP9!.y);
        expect(DIAGRAM_POINTS.AF8!.y).toBeLessThan(DIAGRAM_POINTS.TP10!.y);
    });

    it("never calls the reading a signal-quality or fit score", () => {
        for (const ch of SENSORS) {
            for (const q of ["floating", "marginal"] as ContactQuality[]) {
                const g = contactGuidance(ch, q)!;
                const text = [g.title, g.summary, g.where, ...g.steps].join(" ").toLowerCase();
                expect(text).not.toContain("signal quality");
                expect(text).not.toContain("fit score");
            }
        }
    });
});
