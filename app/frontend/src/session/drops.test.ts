import { describe, it, expect } from "vitest";
import { DropCounter } from "./drops";

describe("DropCounter", () => {
    it("does not count the first packet of a channel", () => {
        const d = new DropCounter();
        expect(d.observe("TP9", 500)).toBe(0);
        expect(d.dropped()).toEqual({ TP9: 0 });
    });

    it("counts gaps per channel", () => {
        const d = new DropCounter();
        d.observe("TP9", 1);
        d.observe("AF7", 1);
        expect(d.observe("TP9", 2)).toBe(0);
        expect(d.observe("TP9", 5)).toBe(2);
        expect(d.observe("AF7", 2)).toBe(0);
        expect(d.dropped()).toEqual({ TP9: 2, AF7: 0 });
    });

    it("handles the 16-bit wrap without counting it as a drop", () => {
        const d = new DropCounter();
        d.observe("TP9", 65535);
        expect(d.observe("TP9", 0)).toBe(0);
        expect(d.observe("TP9", 2)).toBe(1);
    });

    it("ignores a duplicate or out-of-order packet", () => {
        const d = new DropCounter();
        d.observe("TP9", 10);
        expect(d.observe("TP9", 10)).toBe(0);
        expect(d.observe("TP9", 9)).toBe(0);
        expect(d.dropped()).toEqual({ TP9: 0 });
    });

    it("register lists a stream with zero drops and does not affect the first packet", () => {
        const d = new DropCounter();
        d.register("TP10");
        expect(d.dropped()).toEqual({ TP10: 0 });
        expect(d.observe("TP10", 900)).toBe(0);
        expect(d.observe("TP10", 901)).toBe(0);
    });
});
