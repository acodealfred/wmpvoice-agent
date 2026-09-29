import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaselineProtocol, CUE_FALLBACK_MS, type BaselineProtocolOptions } from "./baseline-protocol";

function setup(overrides: Partial<BaselineProtocolOptions> = {}) {
    const events: string[] = [];
    const opts: BaselineProtocolOptions = {
        eyesOpenSeconds: 180,
        eyesClosedSeconds: 180,
        sendCue: cue => events.push(`cue:${cue}`),
        onPhaseStart: phase => events.push(`start:${phase}`),
        onPhaseEnd: phase => events.push(`end:${phase}`),
        onComplete: r => events.push(`complete:${r.eyesClosed ? "closed" : "open"}${r.skipped ? ":skipped" : ""}`),
        ...overrides
    };
    return { protocol: new BaselineProtocol(opts), events };
}

// 1s of PCM16 @ 24 kHz = 48000 bytes = 64000 base64 chars.
const ONE_SECOND_OF_AUDIO = "A".repeat(64_000);
// Negligible audio, so a spoken cue's response.done starts the phase right away.
const TINY_AUDIO = "AAAA";

function cueSpoken(protocol: BaselineProtocol) {
    protocol.notifyAudioDelta(TINY_AUDIO);
    protocol.notifyResponseDone();
}

describe("BaselineProtocol", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("runs eyes open then eyes closed when a headband is connected", () => {
        const { protocol, events } = setup();
        protocol.start(true);
        cueSpoken(protocol);
        vi.advanceTimersByTime(500);
        expect(protocol.getState()).toMatchObject({ stage: "recording", phase: "eyes_open" });

        vi.advanceTimersByTime(180_000);
        expect(events).toEqual(["cue:eyes_open_start", "start:eyes_open", "end:eyes_open", "cue:eyes_closed_start"]);

        cueSpoken(protocol);
        vi.advanceTimersByTime(500 + 180_000);
        expect(events.slice(4)).toEqual(["start:eyes_closed", "end:eyes_closed", "complete:closed"]);
        expect(protocol.getState().stage).toBe("done");
    });

    it("falls back to the eyes-open phase only without a headband", () => {
        const { protocol, events } = setup();
        protocol.start(false);
        cueSpoken(protocol);
        vi.advanceTimersByTime(500 + 180_000);
        expect(events).toEqual(["cue:eyes_open_start", "start:eyes_open", "end:eyes_open", "complete:open"]);
    });

    it("waits for the cue's audio to finish playing before recording", () => {
        const { protocol } = setup();
        protocol.start(false);
        for (let i = 0; i < 4; i++) protocol.notifyAudioDelta(ONE_SECOND_OF_AUDIO);
        protocol.notifyResponseDone();
        vi.advanceTimersByTime(4_000);
        expect(protocol.getState().stage).toBe("cue");
        vi.advanceTimersByTime(500);
        expect(protocol.getState().stage).toBe("recording");
    });

    it("starts the phase anyway if response.done never arrives", () => {
        const { protocol } = setup();
        protocol.start(true);
        vi.advanceTimersByTime(CUE_FALLBACK_MS);
        expect(protocol.getState()).toMatchObject({ stage: "recording", phase: "eyes_open" });
    });

    it("skip during eyes closed ends the phase and completes as eyes-closed", () => {
        const { protocol, events } = setup();
        protocol.start(true);
        cueSpoken(protocol);
        vi.advanceTimersByTime(500 + 180_000);
        cueSpoken(protocol);
        vi.advanceTimersByTime(500 + 10_000);
        protocol.skip();
        expect(events.slice(-2)).toEqual(["end:eyes_closed", "complete:closed:skipped"]);
        vi.advanceTimersByTime(600_000);
        expect(events.at(-1)).toBe("complete:closed:skipped");
    });

    it("cancel stops everything without callbacks", () => {
        const { protocol, events } = setup();
        protocol.start(true);
        cueSpoken(protocol);
        vi.advanceTimersByTime(500);
        protocol.cancel();
        vi.advanceTimersByTime(600_000);
        expect(events).toEqual(["cue:eyes_open_start", "start:eyes_open"]);
        expect(protocol.getState().stage).toBe("idle");
    });

    it("ignores a response.done with no audio (e.g. a tool call) during a cue", () => {
        const { protocol } = setup();
        protocol.start(true);
        protocol.notifyResponseDone();
        vi.advanceTimersByTime(5_000);
        expect(protocol.getState().stage).toBe("cue");
        cueSpoken(protocol);
        vi.advanceTimersByTime(600);
        expect(protocol.getState()).toMatchObject({ stage: "recording", phase: "eyes_open" });
    });

    it("ignores response.done for unrelated agent turns while recording", () => {
        const { protocol } = setup();
        protocol.start(false);
        cueSpoken(protocol);
        vi.advanceTimersByTime(500);
        const endsAt = protocol.getState().phaseEndsAt;
        cueSpoken(protocol);
        vi.advanceTimersByTime(1_000);
        expect(protocol.getState()).toMatchObject({ stage: "recording", phaseEndsAt: endsAt });
    });
});
