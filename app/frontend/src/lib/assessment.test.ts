import { describe, expect, it } from "vitest";

import { assessmentControls } from "./assessment";

const shown = (c: ReturnType<typeof assessmentControls>) =>
    Object.entries(c)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort();

describe("assessmentControls", () => {
    it("shows only Start when nothing is open", () => {
        expect(shown(assessmentControls({ isRecording: false, inBaseline: false, hasResumable: false, assessmentComplete: false }))).toEqual(["start"]);
    });

    it("shows Start new, Continue and Close for a paused assessment", () => {
        expect(shown(assessmentControls({ isRecording: false, inBaseline: false, hasResumable: true, assessmentComplete: false }))).toEqual([
            "close",
            "continue",
            "startNew"
        ]);
    });

    it("shows only Pause while recording the survey, whatever else is true", () => {
        for (const hasResumable of [false, true]) {
            for (const assessmentComplete of [false, true]) {
                expect(shown(assessmentControls({ isRecording: true, inBaseline: false, hasResumable, assessmentComplete }))).toEqual(["pause"]);
            }
        }
    });

    it("shows only Close (no Pause) while recording the baseline, whatever else is true", () => {
        for (const hasResumable of [false, true]) {
            for (const assessmentComplete of [false, true]) {
                expect(shown(assessmentControls({ isRecording: true, inBaseline: true, hasResumable, assessmentComplete }))).toEqual(["close"]);
            }
        }
    });

    it("ignores inBaseline when not recording", () => {
        expect(shown(assessmentControls({ isRecording: false, inBaseline: true, hasResumable: false, assessmentComplete: false }))).toEqual(["start"]);
        expect(shown(assessmentControls({ isRecording: false, inBaseline: true, hasResumable: true, assessmentComplete: false }))).toEqual([
            "close",
            "continue",
            "startNew"
        ]);
    });

    it("offers the post-report conversation and Finish after a finished assessment, but no Close", () => {
        expect(shown(assessmentControls({ isRecording: false, inBaseline: false, hasResumable: false, assessmentComplete: true }))).toEqual([
            "continue",
            "finish",
            "startNew"
        ]);
    });

    it("prefers the paused run over a finished one on screen", () => {
        expect(assessmentControls({ isRecording: false, inBaseline: false, hasResumable: true, assessmentComplete: true }).close).toBe(true);
    });
});
