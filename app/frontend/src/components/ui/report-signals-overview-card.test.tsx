import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { SignalComparison } from "@/types";
import { ReportSignalsOverviewCard } from "./report-signals-overview-card";

const comparison: SignalComparison = {
    surveyRunId: "run-3",
    referenceRunIds: ["a", "b", "c"],
    referenceCount: 3,
    latestReferenceDate: "2026-10-19T09:00:00",
    daysSinceLatest: 2,
    tier: "fixed",
    questions: [
        {
            questionId: "bat_q1",
            label: "Emotional Exhaustion",
            shortLabel: "Mental exhaustion",
            prompt: "At work, I feel mentally exhausted.",
            answer: { previousLabel: "Never", currentLabel: "Sometimes", previousValue: 1, currentValue: 3, changed: true },
            status: "changed",
            surfacedBy: "strong",
            signals: [
                { id: "blink", direction: "higher", tier: "strong", reference: "past", today: 30, past: 0, delta: 30, unit: "pp", todaySupport: null },
                {
                    id: "sentiment",
                    direction: "changed",
                    tier: "moved",
                    reference: "past",
                    today: "positive",
                    past: "neutral",
                    delta: null,
                    unit: null,
                    todaySupport: null
                }
            ]
        },
        {
            questionId: "cbi_q2",
            label: "Work-Related Burnout (Item 11)",
            shortLabel: "Morning exhaustion",
            prompt: "Are you exhausted in the morning at the thought of another day at work?",
            answer: { previousLabel: "Sometimes", currentLabel: "Sometimes", previousValue: 50, currentValue: 50, changed: false },
            status: "steady",
            surfacedBy: null,
            signals: []
        }
    ]
};

describe("ReportSignalsOverviewCard", () => {
    it("renders nothing without a comparison", () => {
        expect(renderToStaticMarkup(<ReportSignalsOverviewCard comparison={null} />)).toBe("");
        expect(renderToStaticMarkup(<ReportSignalsOverviewCard comparison={{ ...comparison, questions: [] }} />)).toBe("");
    });

    it("shows the headline and one table row per question", () => {
        const html = renderToStaticMarkup(<ReportSignalsOverviewCard comparison={comparison} />);
        expect(html).toContain("Your check-in at a glance");
        expect(html).toContain("Compared with your recent check-ins");
        expect(html).toContain("Your answers changed on one of two questions. Your signals showed a notable change on one question.");
        expect(html.match(/<tr>/g)).toHaveLength(2);
        expect(html).toContain("Mental exhaustion");
        expect(html).toContain("Never → Sometimes");
        expect(html).toContain("Blink rate higher · Tone more positive");
        expect(html).toContain("Sometimes (same)");
        expect(html).toContain("No notable change");
    });

    it("has no digits in its text", () => {
        const text = renderToStaticMarkup(<ReportSignalsOverviewCard comparison={comparison} />).replace(/<[^>]+>/g, " ");
        expect(text).not.toMatch(/\d/);
    });
});
