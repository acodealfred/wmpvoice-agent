import { describe, expect, it } from "vitest";

import { eegDisconnectAlert } from "./eeg-alert";

const base = { isRecording: true, eegExpected: true, eegStatus: "disconnected", assessmentComplete: false, inBaseline: false };

describe("eegDisconnectAlert", () => {
    it("alerts when the headband drops mid-survey", () => {
        expect(eegDisconnectAlert(base)).toBe("survey");
    });

    it("alerts with the baseline wording during the baseline", () => {
        expect(eegDisconnectAlert({ ...base, inBaseline: true })).toBe("baseline");
    });

    it("treats any non-streaming state (idle after Disconnect, error) as a drop", () => {
        expect(eegDisconnectAlert({ ...base, eegStatus: "idle" })).toBe("survey");
        expect(eegDisconnectAlert({ ...base, eegStatus: "error" })).toBe("survey");
    });

    it("stays quiet while streaming", () => {
        expect(eegDisconnectAlert({ ...base, eegStatus: "streaming" })).toBeNull();
    });

    it("stays quiet when EEG was never streaming this stretch (Continue without EEG)", () => {
        expect(eegDisconnectAlert({ ...base, eegExpected: false })).toBeNull();
    });

    it("stays quiet when not recording (paused) or after the survey completed", () => {
        expect(eegDisconnectAlert({ ...base, isRecording: false })).toBeNull();
        expect(eegDisconnectAlert({ ...base, assessmentComplete: true })).toBeNull();
    });
});
