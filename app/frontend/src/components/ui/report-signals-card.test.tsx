import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { SignalComparison } from "@/types";
import { ReportSignalsCard } from "./report-signals-card";

const comparison: SignalComparison = {
    surveyRunId: "run-3",
    referenceRunIds: ["run-2"],
    referenceCount: 1,
    latestReferenceDate: "2026-10-12T09:14:00",
    daysSinceLatest: 7,
    tier: "fixed",
    questions: [
        {
            questionId: "bat_q1",
            label: "Emotional Exhaustion",
            prompt: "At work, I feel mentally exhausted.",
            answer: { previousLabel: "Rarely", currentLabel: "Often", previousValue: 2, currentValue: 4, changed: true },
            status: "changed",
            surfacedBy: "corroborated",
            signals: [
                {
                    id: "blink",
                    direction: "higher",
                    tier: "moved",
                    reference: "past",
                    today: 22,
                    past: -3,
                    delta: 25,
                    unit: "pp",
                    todaySupport: "above_baseline"
                },
                { id: "latency", direction: "shorter", tier: "strong", reference: "past", today: 900, past: 2400, delta: -62.5, unit: "%", todaySupport: null },
                { id: "pitch", direction: "higher", tier: "moved", reference: "past", today: 212, past: 196, delta: 1.37, unit: "st", todaySupport: null }
            ]
        },
        {
            questionId: "cbi_q1",
            label: "Work-Related Burnout (Item 7)",
            prompt: "Is your work emotionally exhausting?",
            answer: { previousLabel: "Often", currentLabel: "Often", previousValue: 75, currentValue: 75, changed: false },
            status: "changed",
            surfacedBy: "strong",
            signals: [
                {
                    id: "face",
                    direction: "changed",
                    tier: "moved",
                    reference: "past",
                    today: "SURPRISED",
                    past: "CALM",
                    delta: null,
                    unit: null,
                    todaySupport: null
                }
            ]
        }
    ]
};

const FORBIDDEN = /\b(lie|lied|honest|mismatch|contradict\w*|verdict|pass|fail\w*|detect\w*|stress\w*|pupil|gaze|should|try|consider)\b/i;

/** The markup of the question blocks only (not the summary). */
function sectionsHtml(html: string): string {
    return (html.match(/<section[\s\S]*?<\/section>/g) ?? []).join("");
}

/** The rendered text of the question blocks only (the header's date legitimately has digits). */
function sectionsText(html: string): string {
    return (html.match(/<section[\s\S]*?<\/section>/g) ?? []).join(" ").replace(/<[^>]+>/g, " ");
}

const steady = (questionId: string, prompt: string, status: "steady" | "no_data"): SignalComparison["questions"][number] => ({
    questionId,
    label: questionId,
    prompt,
    answer: { previousLabel: "Sometimes", currentLabel: "Sometimes", previousValue: 3, currentValue: 3, changed: false },
    status,
    surfacedBy: null,
    signals: []
});

const mixed: SignalComparison = {
    ...comparison,
    questions: [
        comparison.questions[0],
        steady("bat_q2", "I struggle to find any enthusiasm for my work.", "steady"),
        steady("bat_q3", "At work, I have trouble staying focused.", "no_data"),
        comparison.questions[1]
    ]
};

describe("ReportSignalsCard", () => {
    it("renders nothing without a comparison or with no questions", () => {
        expect(renderToStaticMarkup(<ReportSignalsCard comparison={null} />)).toBe("");
        expect(renderToStaticMarkup(<ReportSignalsCard comparison={{ ...comparison, questions: [] }} />)).toBe("");
    });

    it("renders one section per question, named by its prompt", () => {
        const html = renderToStaticMarkup(<ReportSignalsCard comparison={comparison} />);
        expect(html.match(/<section/g)).toHaveLength(2);
        expect(html).toContain('aria-label="At work, I feel mentally exhausted."');
        expect(html).toContain("Rarely → Often");
        expect(html).toContain("Often, same as last time");
        expect(html).toContain("Your blink rate was higher than in your last check-in, and above your calm reading at the start.");
        expect(html).toContain("You answered notably more quickly than last time.");
        expect(html).toContain("Your expression read as calm last time and as surprised this time.");
        expect(html).toContain("Your signals, compared with your past check-ins");
    });

    it("shows no numbers and no forbidden words in the question blocks", () => {
        const text = sectionsText(renderToStaticMarkup(<ReportSignalsCard comparison={comparison} />));
        expect(text).not.toMatch(/\d/);
        expect(text).not.toMatch(FORBIDDEN);
    });

    it("has the footer, without claiming only the participant can see it", () => {
        const html = renderToStaticMarkup(<ReportSignalsCard comparison={comparison} />);
        expect(html).toContain("These are things we noticed, not conclusions.");
        expect(html).not.toContain("Only you can see this");
    });

    it("names the reference: one dated check-in, or the count of recent ones", () => {
        expect(renderToStaticMarkup(<ReportSignalsCard comparison={comparison} />)).toContain("Last check-in:");
        const three = { ...comparison, referenceCount: 3, referenceRunIds: ["a", "b", "c"] };
        expect(renderToStaticMarkup(<ReportSignalsCard comparison={three} />)).toContain("Your last 3 check-ins");
    });

    it("shows every question in the order given, with a line for the quiet ones", () => {
        const html = renderToStaticMarkup(<ReportSignalsCard comparison={mixed} />);
        const order = ["mentally exhausted", "enthusiasm", "staying focused", "emotionally exhausting"].map(t => html.indexOf(t));
        expect(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1]))).toBe(true);
        expect(html).toContain("No notable change in your signals compared with your last check-in.");
        expect(html).toContain("Not enough readings to compare this one.");
        // Quiet questions list no signals: only the two changed ones have a <ul>.
        expect(sectionsHtml(html).match(/<ul/g)).toHaveLength(2);
        const text = sectionsText(html);
        expect(text).not.toMatch(/\d/);
        expect(text).not.toMatch(FORBIDDEN);
    });

    it("keeps the title with the first question and the footer with the last (PDF page breaks)", () => {
        const html = renderToStaticMarkup(<ReportSignalsCard comparison={mixed} />);
        const keepGroups = html.match(/<div class="ciq-print-keep[^"]*">[\s\S]*?<\/section>/g) ?? [];
        expect(keepGroups[0]).toContain("Your signals, compared with your past check-ins");
        expect(keepGroups[0]).toContain("mentally exhausted");
        const lastGroup = html.slice(html.lastIndexOf('<div class="ciq-print-keep'));
        expect(lastGroup).toContain("emotionally exhausting");
        expect(lastGroup).toContain("These are things we noticed, not conclusions.");
        // Every question block is itself unsplittable.
        expect(html.match(/<section[^>]*class="ciq-print-keep/g)).toHaveLength(4);
    });

    it("keeps title, question and footer together when there is only one question", () => {
        const one = { ...comparison, questions: [comparison.questions[0]] };
        const html = renderToStaticMarkup(<ReportSignalsCard comparison={one} />);
        expect(html.match(/These are things we noticed/g)).toHaveLength(1);
        const group = html.slice(html.indexOf('<div class="ciq-print-keep'));
        expect(group).toContain("Your signals, compared");
        expect(group).toContain("These are things we noticed");
    });

    it("has no summary box of its own (the overview is a separate card)", () => {
        expect(renderToStaticMarkup(<ReportSignalsCard comparison={mixed} />)).not.toContain("Summary");
    });
});
