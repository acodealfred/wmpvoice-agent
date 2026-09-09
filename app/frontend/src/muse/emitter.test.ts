import { describe, it, expect, vi } from "vitest";
import { TypedEmitter } from "./emitter";

type Events = { tick: number; done: undefined };

describe("TypedEmitter", () => {
    it("delivers payloads to listeners of that event only", () => {
        const em = new TypedEmitter<Events>();
        const tick = vi.fn();
        const done = vi.fn();
        em.on("tick", tick);
        em.on("done", done);
        em.emit("tick", 3);
        expect(tick).toHaveBeenCalledWith(3);
        expect(done).not.toHaveBeenCalled();
    });

    it("returns an unsubscribe function", () => {
        const em = new TypedEmitter<Events>();
        const tick = vi.fn();
        const off = em.on("tick", tick);
        off();
        em.emit("tick", 1);
        expect(tick).not.toHaveBeenCalled();
    });

    it("is safe to unsubscribe during emit", () => {
        const em = new TypedEmitter<Events>();
        const second = vi.fn();
        const off = em.on("tick", () => off());
        em.on("tick", second);
        em.emit("tick", 1);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it("removeAll drops every listener", () => {
        const em = new TypedEmitter<Events>();
        const fn = vi.fn();
        em.on("tick", fn);
        em.removeAll();
        em.emit("tick", 1);
        expect(fn).not.toHaveBeenCalled();
    });
});
