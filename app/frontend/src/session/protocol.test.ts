import { describe, it, expect } from "vitest";
import { BENCH_PROTOCOL, ProtocolRun, protocolDurationMs } from "./protocol";

const steps = [
    { label: "a", instruction: "do a", seconds: 20 },
    { label: "b", instruction: "do b", seconds: 10 },
    { label: "c", instruction: "do c", seconds: 5 }
];

describe("BENCH_PROTOCOL", () => {
    it("is the bench sequence the science-team document describes", () => {
        expect(BENCH_PROTOCOL.map(s => s.label)).toEqual(["baseline", "eyes closed", "eyes open", "blinks", "jaw clench"]);
        expect(protocolDurationMs(BENCH_PROTOCOL)).toBe(105_000);
        for (const s of BENCH_PROTOCOL) expect(s.instruction.length).toBeGreaterThan(0);
    });

    it("measures before it disturbs: nothing that shifts an electrode precedes eyes closed", () => {
        // A 2026-09-04 bench run lost its eyes-closed window to electrode recovery
        // after a jaw clench ran first. The artefact steps now come last.
        const labels = BENCH_PROTOCOL.map(s => s.label);
        expect(labels.indexOf("eyes closed")).toBeLessThan(labels.indexOf("blinks"));
        expect(labels.indexOf("eyes closed")).toBeLessThan(labels.indexOf("jaw clench"));
        expect(BENCH_PROTOCOL[labels.indexOf("eyes closed")].seconds).toBe(60);
    });
});

describe("ProtocolRun.at", () => {
    it("reports the first step at the instant it starts", () => {
        const run = new ProtocolRun(steps, 0);
        expect(run.at(0)).toEqual({ done: false, index: 0, total: 3, step: steps[0], remainingMs: 20_000 });
    });

    it("holds the step until its final millisecond, then advances", () => {
        const run = new ProtocolRun(steps, 0);
        expect(run.at(19_999)).toMatchObject({ index: 0, remainingMs: 1 });
        expect(run.at(20_000)).toMatchObject({ index: 1, remainingMs: 10_000 });
        expect(run.at(29_999)).toMatchObject({ index: 1, remainingMs: 1 });
        expect(run.at(30_000)).toMatchObject({ index: 2, remainingMs: 5_000 });
    });

    it("is done once the last step's time is spent", () => {
        const run = new ProtocolRun(steps, 0);
        expect(run.at(34_999)).toMatchObject({ done: false, index: 2 });
        expect(run.at(35_000)).toEqual({ done: true });
        expect(run.at(99_000)).toEqual({ done: true });
    });

    it("is measured from the session time the run was started, not from zero", () => {
        // Started 2:09 into a session that was already recording.
        const run = new ProtocolRun(steps, 129_000);
        expect(run.at(129_000)).toMatchObject({ index: 0, remainingMs: 20_000 });
        expect(run.at(149_000)).toMatchObject({ index: 1, remainingMs: 10_000 });
        expect(run.at(164_000)).toEqual({ done: true });
    });
});

describe("ProtocolRun.marks", () => {
    it("emits nothing before any step has elapsed", () => {
        expect(new ProtocolRun(steps, 0).marks(0)).toEqual([]);
    });

    it("clips the step in progress to now, so an abandoned run still yields markers", () => {
        const run = new ProtocolRun(steps, 0);
        expect(run.marks(25_000)).toEqual([
            { label: "a", t_ms_start: 0, t_ms_end: 20_000 },
            { label: "b", t_ms_start: 20_000, t_ms_end: 25_000 }
        ]);
    });

    it("emits every step in full once the run is complete", () => {
        const run = new ProtocolRun(steps, 0);
        expect(run.marks(35_000)).toEqual([
            { label: "a", t_ms_start: 0, t_ms_end: 20_000 },
            { label: "b", t_ms_start: 20_000, t_ms_end: 30_000 },
            { label: "c", t_ms_start: 30_000, t_ms_end: 35_000 }
        ]);
        // Time past the end does not stretch the last marker.
        expect(run.marks(99_000)).toEqual(run.marks(35_000));
    });

    it("offsets markers into session time so they line up with packet t_ms", () => {
        const run = new ProtocolRun(steps, 129_000);
        expect(run.marks(155_000)).toEqual([
            { label: "a", t_ms_start: 129_000, t_ms_end: 149_000 },
            { label: "b", t_ms_start: 149_000, t_ms_end: 155_000 }
        ]);
    });
});
