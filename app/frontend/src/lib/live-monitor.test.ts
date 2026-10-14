import { describe, expect, it } from "vitest";

import { formatDuration, issueLog, phaseStepIndex, type MonitorSecond } from "./live-monitor";

describe("formatDuration", () => {
    it("formats minutes and hours", () => {
        expect(formatDuration(75)).toBe("1:15");
        expect(formatDuration(3725)).toBe("1:02:05");
        expect(formatDuration(null)).toBe("—");
    });
});

describe("phaseStepIndex", () => {
    it("places each phase on the stepper", () => {
        expect(phaseStepIndex("baseline_setup")).toBe(-1);
        expect(phaseStepIndex("baseline_eyes_open")).toBe(0);
        expect(phaseStepIndex("survey")).toBe(2);
        expect(phaseStepIndex("report")).toBe(3);
        expect(phaseStepIndex(null)).toBe(-1);
    });
});

describe("issueLog", () => {
    const second = (t: number, issues: string[]): MonitorSecond => ({ t, phase: "survey", levels: {}, channels: {}, issues });

    it("logs an issue when it starts, newest first, not every second it lasts", () => {
        const log = issueLog([
            second(1, []),
            second(2, ["AF7: poor contact"]),
            second(3, ["AF7: poor contact"]),
            second(4, ["AF7: poor contact", "EEG headband disconnected"])
        ]);
        expect(log).toEqual([
            { t: 4, issue: "EEG headband disconnected" },
            { t: 2, issue: "AF7: poor contact" }
        ]);
    });

    it("logs an issue again when it comes back", () => {
        const log = issueLog([second(1, ["x"]), second(2, []), second(3, ["x"])]);
        expect(log.map(e => e.t)).toEqual([3, 1]);
    });
});
