import { describe, expect, it } from "vitest";

import { answerLevel, describeDomain, describeGauge } from "./report-descriptions";

// The real survey configs — so a renamed/added domain can't silently lose its hover text.
type SurveyJson = { questions: { domain?: string }[]; scoringSections?: { label: string }[] };
const surveys = import.meta.glob<SurveyJson>("../../../backend/surveys/*.json", { eager: true, import: "default" });

describe("report chart descriptions", () => {
    it("loads the backend survey configs", () => {
        expect(Object.keys(surveys).length).toBeGreaterThan(0);
    });

    it("describes every domain used by a survey (placeholders excepted)", () => {
        const domains = new Set(
            Object.values(surveys)
                .flatMap(s => s.questions.map(q => q.domain))
                .filter((d): d is string => !!d && d !== "Placeholder")
        );
        for (const domain of domains) expect(describeDomain(domain), domain).toBeTruthy();
    });

    it("describes every scoring section gauge", () => {
        const labels = Object.values(surveys).flatMap(s => (s.scoringSections ?? []).map(x => x.label));
        for (const label of labels) expect(describeGauge(label, false)).not.toMatch(/^The total of all your answers/);
    });

    it("adds the item wording for CBI radar points", () => {
        expect(describeDomain("Work-Related Burnout (Item 13)")).toMatch(/leisure time/);
        expect(describeDomain("Work-Related Burnout (Item 13)")).toMatch(/Reverse-scored/);
    });

    it("falls back to undefined / the overall text for unknown names", () => {
        expect(describeDomain("Something New")).toBeUndefined();
        expect(describeGauge("Overall", false)).toMatch(/total of all your answers/);
        expect(describeGauge("Overall", true)).toMatch(/readiness/);
    });

    it("bands answers like the report's colours", () => {
        expect([answerLevel(20), answerLevel(21), answerLevel(60), answerLevel(61)]).toEqual(["Low", "Moderate", "Moderate", "High"]);
    });
});
