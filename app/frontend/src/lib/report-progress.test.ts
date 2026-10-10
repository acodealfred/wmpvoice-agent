import { describe, expect, it } from "vitest";

import { REPORT_STEPS, STEP_MS, progressAt } from "./report-progress";

describe("progressAt", () => {
    it("ticks one card (25%) per step while the report is ready", () => {
        expect(progressAt(0, true)).toEqual({ stepsDone: 0, percent: 0 });
        expect(progressAt(STEP_MS - 1, true)).toEqual({ stepsDone: 0, percent: 0 });
        expect(progressAt(STEP_MS, true)).toEqual({ stepsDone: 1, percent: 25 });
        expect(progressAt(2 * STEP_MS, true)).toEqual({ stepsDone: 2, percent: 50 });
        expect(progressAt(3 * STEP_MS, true)).toEqual({ stepsDone: 3, percent: 75 });
        expect(progressAt(4 * STEP_MS, true)).toEqual({ stepsDone: 4, percent: 100 });
    });

    it("holds at 75% until the report is actually ready", () => {
        expect(progressAt(4 * STEP_MS, false)).toEqual({ stepsDone: 3, percent: 75 });
        expect(progressAt(60_000, false)).toEqual({ stepsDone: 3, percent: 75 });
        expect(progressAt(60_000, true)).toEqual({ stepsDone: 4, percent: 100 });
    });

    it("never goes past the last card or below zero", () => {
        expect(progressAt(100 * STEP_MS, true).stepsDone).toBe(REPORT_STEPS.length);
        expect(progressAt(-500, true)).toEqual({ stepsDone: 0, percent: 0 });
    });

    it("starts the last card (the closing-line cue) at 3 steps, report ready or not", () => {
        const last = REPORT_STEPS.length - 1;
        expect(progressAt(last * STEP_MS - 1, false).stepsDone).toBe(last - 1);
        expect(progressAt(last * STEP_MS, false).stepsDone).toBe(last);
        expect(progressAt(last * STEP_MS, true).stepsDone).toBe(last);
    });
});
