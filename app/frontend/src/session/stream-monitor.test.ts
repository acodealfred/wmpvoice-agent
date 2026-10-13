import { describe, it, expect } from "vitest";
import { StreamMonitor, type DiagEvent } from "./stream-monitor";

function setup(stallMs = 2000) {
    let now = 0;
    const logged: DiagEvent[] = [];
    const monitor = new StreamMonitor({
        now: () => now,
        wallClock: () => `wall@${now}`,
        stallMs,
        log: e => logged.push(e)
    });
    return {
        monitor,
        logged,
        advance: (ms: number) => {
            now += ms;
        }
    };
}

describe("StreamMonitor", () => {
    it("does not flag a stall while packets keep arriving", () => {
        const { monitor, logged, advance } = setup();
        for (let i = 0; i < 10; i++) {
            monitor.note("eeg");
            advance(500);
            monitor.check();
        }
        expect(logged.filter(e => e.type === "stall")).toEqual([]);
    });

    it("flags a stall once when a stream goes silent past the threshold", () => {
        const { monitor, logged, advance } = setup(2000);
        monitor.note("eeg");
        advance(2500);
        monitor.check();
        advance(1000);
        monitor.check();
        const stalls = logged.filter(e => e.type === "stall");
        expect(stalls).toHaveLength(1);
        expect(stalls[0].data).toMatchObject({ stream: "eeg", silentMs: 2500 });
    });

    it("never flags a stream that has not sent anything yet", () => {
        const { monitor, logged, advance } = setup();
        monitor.note("eeg");
        advance(5000);
        monitor.check();
        const flagged = logged.filter(e => e.type === "stall").map(e => e.data?.stream);
        expect(flagged).toEqual(["eeg"]);
    });

    it("logs a resume with the length of the gap when packets return", () => {
        const { monitor, logged, advance } = setup(2000);
        monitor.note("eeg");
        advance(4000);
        monitor.check();
        monitor.note("eeg");
        const resumed = logged.filter(e => e.type === "resumed");
        expect(resumed).toHaveLength(1);
        expect(resumed[0].data).toMatchObject({ stream: "eeg", gapMs: 4000 });
        // A later silence is a new stall episode.
        advance(3000);
        monitor.check();
        expect(logged.filter(e => e.type === "stall")).toHaveLength(2);
    });

    it("records a disconnect with how long each stream had been silent", () => {
        const { monitor, logged, advance } = setup();
        monitor.note("eeg");
        advance(300);
        monitor.note("imu");
        advance(700);
        monitor.disconnected();
        const d = logged.find(e => e.type === "disconnected");
        expect(d).toBeDefined();
        expect(d?.data).toMatchObject({ silentMs: { eeg: 1000, imu: 700 } });
    });

    it("heartbeat reports packet counts, silence and the latest battery reading", () => {
        const { monitor, logged, advance } = setup();
        monitor.note("eeg");
        monitor.note("eeg");
        monitor.note("imu");
        monitor.noteTelemetry(10, 2972.2);
        advance(1500);
        monitor.heartbeat({ paused: false, recorderPackets: 3 });
        const h = logged.find(e => e.type === "heartbeat");
        expect(h?.data).toMatchObject({
            counts: { eeg: 2, imu: 1, ppg: 0, telemetry: 0 },
            silentMs: { eeg: 1500, imu: 1500 },
            batteryPercent: 10,
            fuelGaugeMv: 2972.2,
            paused: false,
            recorderPackets: 3
        });
    });

    it("keeps every event, in order, for later export", () => {
        const { monitor, advance } = setup(1000);
        monitor.note("eeg");
        advance(1500);
        monitor.check();
        monitor.disconnected();
        expect(monitor.events().map(e => e.type)).toEqual(["stall", "disconnected"]);
    });

    it("stamps events with the wall clock", () => {
        const { monitor, logged, advance } = setup(1000);
        monitor.note("eeg");
        advance(1500);
        monitor.check();
        expect(logged[0].wall).toBe("wall@1500");
    });
});
