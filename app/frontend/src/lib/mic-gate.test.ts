import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MIC_REOPEN_TAIL_MS, MIC_SAFETY_TIMEOUT_MS, MicGate } from "./mic-gate";

function setup() {
    const changes: boolean[] = [];
    const gate = new MicGate(open => changes.push(open));
    return { gate, changes };
}

describe("MicGate", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("starts open", () => {
        expect(setup().gate.isOpen()).toBe(true);
    });

    it("closes on agent audio and stays closed through more chunks", () => {
        const { gate, changes } = setup();
        gate.agentAudio();
        gate.agentAudio();
        gate.agentAudio();
        expect(gate.isOpen()).toBe(false);
        expect(changes).toEqual([false]);
    });

    it("reopens only after response.done AND playback drained, plus the tail", () => {
        const { gate, changes } = setup();
        gate.agentAudio();
        gate.responseDone();
        vi.advanceTimersByTime(5_000);
        expect(gate.isOpen()).toBe(false); // still playing

        gate.drained();
        vi.advanceTimersByTime(MIC_REOPEN_TAIL_MS - 1);
        expect(gate.isOpen()).toBe(false);
        vi.advanceTimersByTime(1);
        expect(gate.isOpen()).toBe(true);
        expect(changes).toEqual([false, true]);
    });

    it("stays closed when playback drains mid-response (network gap)", () => {
        const { gate } = setup();
        gate.agentAudio();
        gate.drained(); // queue emptied, but the response is still generating
        vi.advanceTimersByTime(MIC_REOPEN_TAIL_MS * 3);
        expect(gate.isOpen()).toBe(false);

        gate.agentAudio(); // more audio arrives
        gate.responseDone();
        gate.drained();
        vi.advanceTimersByTime(MIC_REOPEN_TAIL_MS);
        expect(gate.isOpen()).toBe(true);
    });

    it("new agent audio during the tail keeps it closed", () => {
        const { gate } = setup();
        gate.agentAudio();
        gate.responseDone();
        gate.drained();
        vi.advanceTimersByTime(MIC_REOPEN_TAIL_MS - 50);
        gate.agentAudio(); // next response starts speaking
        vi.advanceTimersByTime(MIC_REOPEN_TAIL_MS);
        expect(gate.isOpen()).toBe(false);
    });

    it("reopens via the safety timeout if no signal ever arrives", () => {
        const { gate } = setup();
        gate.agentAudio();
        vi.advanceTimersByTime(MIC_SAFETY_TIMEOUT_MS - 1);
        expect(gate.isOpen()).toBe(false);
        vi.advanceTimersByTime(1);
        expect(gate.isOpen()).toBe(true);
    });

    it("reset reopens immediately and cancels pending timers", () => {
        const { gate, changes } = setup();
        gate.agentAudio();
        gate.reset();
        expect(gate.isOpen()).toBe(true);
        vi.advanceTimersByTime(MIC_SAFETY_TIMEOUT_MS);
        expect(changes).toEqual([false, true]);
    });

    it("hold closes the mic until the requested turn has played, or the safety timeout", () => {
        const { gate } = setup();
        gate.hold();
        expect(gate.isOpen()).toBe(false);
        gate.agentAudio(); // the requested turn arrives
        gate.responseDone();
        gate.drained();
        vi.advanceTimersByTime(MIC_REOPEN_TAIL_MS);
        expect(gate.isOpen()).toBe(true);

        gate.hold(); // a turn that never arrives
        vi.advanceTimersByTime(MIC_SAFETY_TIMEOUT_MS);
        expect(gate.isOpen()).toBe(true);
    });

    it("ignores response.done and drained while already open", () => {
        const { gate, changes } = setup();
        gate.responseDone();
        gate.drained();
        vi.advanceTimersByTime(MIC_SAFETY_TIMEOUT_MS);
        expect(gate.isOpen()).toBe(true);
        expect(changes).toEqual([]);
    });
});
