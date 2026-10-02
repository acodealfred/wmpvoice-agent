// The agent-voice playback worklet (public/audio-playback-worklet.js), run outside the
// browser: the file is evaluated with stand-ins for the AudioWorklet globals.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("../../../public/audio-playback-worklet.js", import.meta.url), "utf8");
const QUANTUM = 128;

type Worklet = {
    handleMessage: (e: { data: Int16Array | null }) => void;
    process: (inputs: unknown, outputs: Float32Array[][], params: unknown) => boolean;
};

function load() {
    const posted: unknown[] = [];
    class AudioWorkletProcessor {
        port = { onmessage: null as unknown, postMessage: (m: unknown) => posted.push(m) };
    }
    let Ctor: (new () => Worklet) | null = null;
    const registerProcessor = (_name: string, cls: new () => Worklet) => {
        Ctor = cls;
    };
    new Function("AudioWorkletProcessor", "registerProcessor", SOURCE)(AudioWorkletProcessor, registerProcessor);
    const worklet = new Ctor!();
    const tick = () => {
        const channel = new Float32Array(QUANTUM).fill(NaN);
        worklet.process([], [[channel]], {});
        return channel;
    };
    return { worklet, tick, posted };
}

/** PCM16 values that ramp, so order and gaps are easy to check. */
const ramp = (from: number, n: number) => Int16Array.from({ length: n }, (_, i) => (from + i) % 32768);

describe("audio playback worklet", () => {
    it("plays a long backlog of uneven chunks in order, with nothing skipped or repeated", () => {
        const { worklet, tick } = load();
        // ~60 s at 24 kHz, in chunk sizes that never line up with the 128-sample tick.
        const sizes = [4800, 333, 9600, 1, 7777, 2400];
        let total = 0;
        while (total < 24_000 * 60) {
            const n = sizes[total % sizes.length];
            worklet.handleMessage({ data: ramp(total, n) });
            total += n;
        }
        const out: number[] = [];
        while (out.length < total) out.push(...Array.from(tick(), v => Math.round(v * 32768)));
        expect(out.slice(0, total)).toEqual(Array.from(ramp(0, total)));
    });

    it("pads a partly-filled tick with silence and reports drained once", () => {
        const { worklet, tick, posted } = load();
        worklet.handleMessage({ data: ramp(1, 100) });
        const out = tick();
        expect(Array.from(out.slice(100))).toEqual(new Array(28).fill(0));
        expect(posted).toEqual(["drained"]);
        tick();
        expect(posted).toEqual(["drained"]); // not again while idle
    });

    it("stop reports the unplayed samples, clears the queue and drains", () => {
        const { worklet, tick, posted } = load();
        worklet.handleMessage({ data: ramp(0, 1000) });
        tick(); // 128 played
        worklet.handleMessage({ data: null });
        expect(posted).toEqual([{ type: "stopped", unplayed: 872 }, "drained"]);
        expect(Array.from(tick())).toEqual(new Array(QUANTUM).fill(0));
    });

    it("plays silence when idle and ignores empty chunks", () => {
        const { worklet, tick, posted } = load();
        worklet.handleMessage({ data: new Int16Array(0) });
        expect(Array.from(tick())).toEqual(new Array(QUANTUM).fill(0));
        expect(posted).toEqual([]);
    });
});
