import { describe, expect, it } from "vitest";

import { ReportSpeech, type ReportSpeechState } from "./report-speech";

function setup() {
    const states: ReportSpeechState[] = [];
    return { speech: new ReportSpeech(s => states.push(s)), states };
}

describe("ReportSpeech", () => {
    it("start sends report_explain and finishes once generated and played out", () => {
        const { speech, states } = setup();
        expect(speech.start()).toBe("report_explain");
        speech.agentAudio("item-1");
        speech.drained(); // network gap mid-sentence — not done yet
        expect(speech.getState()).toBe("explaining");
        speech.agentAudio("item-1");
        speech.responseDone();
        expect(speech.getState()).toBe("explaining"); // still playing
        speech.drained();
        expect(states).toEqual(["explaining", "done"]);
    });

    it("pause mid-explanation truncates at the heard position, continue resumes", () => {
        const { speech } = setup();
        speech.start();
        speech.agentAudio("item-1");
        expect(speech.pause({ itemId: "item-1", playedMs: 4200 })).toEqual({ itemId: "item-1", playedMs: 4200 });
        expect(speech.getState()).toBe("paused");
        expect(speech.resume()).toBe("report_continue");
        expect(speech.getState()).toBe("explaining");
    });

    it("restarts from the top if paused before any explanation audio was heard", () => {
        const { speech } = setup();
        speech.start();
        expect(speech.pause(null)).toBeNull();
        expect(speech.resume()).toBe("report_explain");
    });

    it("ignores a playback position from a different item", () => {
        const { speech } = setup();
        speech.start();
        speech.agentAudio("item-1");
        expect(speech.pause({ itemId: "older-item", playedMs: 900 })).toBeNull();
        expect(speech.resume()).toBe("report_explain");
    });

    it("restarts from the top if the session was replaced while paused", () => {
        const { speech } = setup();
        speech.start();
        speech.agentAudio("item-1");
        speech.pause({ itemId: "item-1", playedMs: 3000 });
        speech.sessionReset();
        expect(speech.resume()).toBe("report_explain");
    });

    it("a resumed explanation tracks its new item", () => {
        const { speech } = setup();
        speech.start();
        speech.agentAudio("item-1");
        speech.pause({ itemId: "item-1", playedMs: 3000 });
        speech.resume();
        speech.agentAudio("item-2");
        expect(speech.pause({ itemId: "item-2", playedMs: 1500 })).toEqual({ itemId: "item-2", playedMs: 1500 });
    });

    it("pause after the explanation is done needs no truncate, and continue sends no cue", () => {
        const { speech } = setup();
        speech.start();
        speech.agentAudio("item-1");
        speech.responseDone();
        speech.drained();
        expect(speech.pause({ itemId: "item-1", playedMs: 9000 })).toBeNull();
        expect(speech.getState()).toBe("done");
        expect(speech.resume()).toBeNull();
    });

    it("ignores agent audio outside the explanation and resets to idle", () => {
        const { speech } = setup();
        speech.agentAudio("closing-line");
        speech.responseDone();
        speech.drained();
        expect(speech.getState()).toBe("idle");
        speech.start();
        speech.reset();
        expect(speech.getState()).toBe("idle");
    });
});
