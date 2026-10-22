import { describe, expect, it } from "vitest";

import { domainChartData, effectiveScores } from "./report-scores";

const max = (qid: string) => (qid.startsWith("cbi_") ? 100 : 5);

// PILOT: one question per domain; cbi_q3 is reverse-scored (0–100 scale → 100 - raw).
const PILOT = [
    { questionId: "bat_q1", domain: "Emotional Exhaustion", score: 4 },
    { questionId: "cbi_q1", domain: "Work-Related Burnout (Item 7)", score: 50 },
    { questionId: "cbi_q3", domain: "Work-Related Burnout (Item 13)", score: 75 }
];
const PILOT_TOTALS = { "Emotional Exhaustion": 4, "Work-Related Burnout (Item 7)": 50, "Work-Related Burnout (Item 13)": 25 };

describe("domainChartData", () => {
    it("plots the reverse-scored question by its reversed score, not the raw answer", () => {
        const data = domainChartData(PILOT, PILOT_TOTALS, max);
        expect(data.find(d => d.domain === "Work-Related Burnout (Item 13)")?.score).toBe(25);
        expect(data.find(d => d.domain === "Emotional Exhaustion")?.score).toBe(80);
        expect(data.find(d => d.domain === "Work-Related Burnout (Item 7)")?.score).toBe(50);
    });

    it("falls back to raw answers without domainTotals (report still calculating, very old saves)", () => {
        expect(domainChartData(PILOT, undefined, max).find(d => d.domain === "Work-Related Burnout (Item 13)")?.score).toBe(75);
        expect(domainChartData(PILOT, {}, max).find(d => d.domain === "Work-Related Burnout (Item 13)")?.score).toBe(75);
    });

    it("averages a multi-question domain over its questions' maximum", () => {
        const two = [
            { questionId: "q1", domain: "D", score: 4 },
            { questionId: "q2", domain: "D", score: 2 }
        ];
        expect(domainChartData(two, { D: 6 }, () => 5)).toEqual([{ domain: "D", score: 60, n: 2 }]);
    });
});

describe("effectiveScores", () => {
    it("gives each single-question domain its reverse-aware score", () => {
        expect(effectiveScores(PILOT, PILOT_TOTALS)).toEqual({ bat_q1: 4, cbi_q1: 50, cbi_q3: 25 });
    });

    it("keeps raw scores in a multi-question domain with nothing reversed, and null when it can't tell", () => {
        const two = [
            { questionId: "q1", domain: "D", score: 4 },
            { questionId: "q2", domain: "D", score: 2 }
        ];
        expect(effectiveScores(two, { D: 6 })).toEqual({ q1: 4, q2: 2 });
        expect(effectiveScores(two, { D: 4 })).toEqual({ q1: null, q2: null });
    });

    it("is null without domainTotals or a score", () => {
        expect(effectiveScores(PILOT, undefined).cbi_q3).toBeNull();
        expect(effectiveScores([{ questionId: "x", domain: "D" }], { D: 3 }).x).toBeNull();
    });
});
