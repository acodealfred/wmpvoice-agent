import { describe, it, expect } from "vitest";
import { Recorder } from "./recorder";
import type { EegReading, ImuReading, PpgReading, Telemetry } from "../muse/types";

const opts = {
    device: { name: "Muse-TEST", firmware: "1.2.13", raw: { fw: "1.2.13" } },
    preset: "p21" as const,
    consentAcceptedAt: "2026-08-22T09:13:41.002Z",
    recordedAt: "2026-08-22T09:14:03.218Z"
};

const eeg = (ch: EegReading["ch"], seq: number, tMs: number, v = 0): EegReading => ({
    kind: "eeg",
    ch,
    seq,
    tMs,
    uV: new Array(12).fill(v)
});

describe("Recorder", () => {
    it("writes the schema, header and consent", () => {
        const file = new Recorder(opts).finish();
        expect(file.schema).toBe("muse-web-bridge/3");
        expect(file.recorded_at).toBe(opts.recordedAt);
        expect(file.device).toEqual(opts.device);
        expect(file.preset).toBe("p21");
        expect(file.consent).toEqual({ accepted_at: opts.consentAcceptedAt });
        expect(file.eeg).toMatchObject({ rate_hz: 256, units: "uV", channels: ["TP9", "AF7", "AF8", "TP10"] });
        // The µV scale is disputed (see docs/muse-2-findings.md), so the file
        // states which conversion produced its numbers instead of assuming one.
        expect(file.eeg.uv_per_lsb).toBe(0.48828125);
        expect(file.eeg.zero_code).toBe(2048);
        expect(file.accelerometer).toMatchObject({ rate_hz: 52, units: "g" });
        expect(file.gyroscope).toMatchObject({ rate_hz: 52, units: "deg/s" });
        expect(file.ppg).toBeUndefined();
    });

    it("records EEG packets with rounded values and counts drops per channel", () => {
        const r = new Recorder(opts);
        r.push(eeg("TP9", 1, 0.04, 0.123456));
        r.push(eeg("TP9", 2, 46.9));
        r.push(eeg("AF7", 1, 0.04));
        r.push(eeg("AF7", 4, 140.6));
        const file = r.finish();
        expect(file.eeg.packets).toHaveLength(4);
        expect(file.eeg.packets[0]).toEqual({ ch: "TP9", seq: 1, t_ms: 0, v: new Array(12).fill(0.12) });
        expect(file.eeg.dropped_packets).toEqual({ TP9: 0, AF7: 2, AF8: 0, TP10: 0 });
        expect(r.packetCount()).toBe(4);
    });

    it("records IMU, PPG and battery", () => {
        const r = new Recorder({ ...opts, preset: "p50" });
        const imu: ImuReading = {
            kind: "imu",
            sensor: "accelerometer",
            seq: 1,
            tMs: 10,
            samples: [
                { x: 0.001234, y: 0, z: 1 },
                { x: 0, y: 0, z: 1 },
                { x: 0, y: 0, z: 1 }
            ]
        };
        const gyro: ImuReading = { ...imu, sensor: "gyroscope", samples: [{ x: 1.23456, y: 0, z: 0 }] };
        const ppg: PpgReading = { kind: "ppg", ch: "infrared", seq: 3, tMs: 20, counts: [1, 2, 3, 4, 5, 6] };
        const tel: Telemetry = { kind: "telemetry", seq: 1, tMs: 30, batteryPercent: 86.998, fuelGaugeMv: 3700, temperature: 30 };
        r.push(imu);
        r.push(gyro);
        r.push(ppg);
        r.push(tel);
        const file = r.finish();
        expect(file.accelerometer.packets[0]).toEqual({
            seq: 1,
            t_ms: 10,
            v: [
                [0.0012, 0, 1],
                [0, 0, 1],
                [0, 0, 1]
            ]
        });
        expect(file.gyroscope.packets[0]).toEqual({ seq: 1, t_ms: 10, v: [[1.2346, 0, 0]] });
        expect(file.ppg?.packets[0]).toEqual({ ch: "infrared", seq: 3, t_ms: 20, v: [1, 2, 3, 4, 5, 6] });
        expect(file.ppg).toMatchObject({ rate_hz: 64, units: "counts", channels: ["ambient", "infrared", "red"] });
        // Temperature and fuel-gauge voltage were decoded and then discarded
        // before 2026-09-04; the headband sends them, so the file keeps them.
        expect(file.telemetry).toEqual([{ t_ms: 30, battery_percent: 87, fuel_gauge_mv: 3700, temperature: 30 }]);
        expect(file.ppg?.dropped_packets).toEqual({ ambient: 0, infrared: 0, red: 0 });
    });

    it("omits the wall-clock anchor when streaming never started", () => {
        const file = new Recorder(opts).finish();
        expect(file.t0_epoch_ms).toBeUndefined();
        // Absent, not zero: a 0 would read as 1 January 1970 to anything joining
        // this file to another recorder's clock.
        expect("t0_epoch_ms" in file).toBe(false);
    });

    it("writes the wall-clock anchor it was given when streaming started", () => {
        const r = new Recorder(opts);
        r.markStarted(1_757_330_043_218);
        const file = r.finish();
        expect(file.t0_epoch_ms).toBe(1_757_330_043_218);
        // recorded_at is a different instant — the page stamps it before the
        // headband is told to stream — so the anchor must not be derived from it.
        expect(file.t0_epoch_ms).not.toBe(Date.parse(opts.recordedAt));
        expect(file.recorded_at).toBe(opts.recordedAt);
    });

    it("keeps the anchor exactly as given, with no jitter correction folded in", () => {
        // The 47 ms of BLE arrival jitter measured in docs/muse-2-findings.md is a
        // caveat for the consumer, not a number to bake in here.
        const r = new Recorder(opts);
        r.markStarted(1_757_330_043_218);
        expect(r.finish().t0_epoch_ms).toBe(1_757_330_043_218);
    });

    it("omits the markers block when no guided run happened", () => {
        const file = new Recorder(opts).finish();
        expect(file.markers).toBeUndefined();
        expect("markers" in file).toBe(false);
    });

    it("keeps guided-protocol markers in session time, in the order they were set", () => {
        const r = new Recorder(opts);
        r.setMarkers([
            { label: "baseline", t_ms_start: 129_000, t_ms_end: 149_000 },
            { label: "blinks", t_ms_start: 149_000, t_ms_end: 159_000 }
        ]);
        const file = r.finish();
        expect(file.schema).toBe("muse-web-bridge/3");
        expect(file.markers).toEqual([
            { label: "baseline", t_ms_start: 129_000, t_ms_end: 149_000 },
            { label: "blinks", t_ms_start: 149_000, t_ms_end: 159_000 }
        ]);
    });

    it("replaces the markers of an earlier run rather than appending to them", () => {
        const r = new Recorder(opts);
        r.setMarkers([{ label: "baseline", t_ms_start: 0, t_ms_end: 20_000 }]);
        r.setMarkers([{ label: "baseline", t_ms_start: 50_000, t_ms_end: 70_000 }]);
        expect(r.finish().markers).toEqual([{ label: "baseline", t_ms_start: 50_000, t_ms_end: 70_000 }]);
    });

    it("counts dropped PPG packets per channel, not just EEG", () => {
        const r = new Recorder({ ...opts, preset: "p50" });
        const ppg = (ch: PpgReading["ch"], seq: number): PpgReading => ({ kind: "ppg", ch, seq, tMs: seq * 94, counts: [1, 2, 3, 4, 5, 6] });
        r.push(ppg("infrared", 10));
        r.push(ppg("infrared", 11));
        r.push(ppg("infrared", 15)); // three missed
        r.push(ppg("red", 4));
        r.push(ppg("red", 5));
        const file = r.finish();
        expect(file.ppg?.dropped_packets).toEqual({ ambient: 0, infrared: 3, red: 0 });
        // EEG counting is unaffected by PPG traffic.
        expect(file.eeg.dropped_packets).toEqual({ TP9: 0, AF7: 0, AF8: 0, TP10: 0 });
    });

    it("lists AUX when the preset is p20", () => {
        const file = new Recorder({ ...opts, preset: "p20" }).finish();
        expect(file.eeg.channels).toEqual(["TP9", "AF7", "AF8", "TP10", "AUX"]);
        expect(file.eeg.dropped_packets).toEqual({ TP9: 0, AF7: 0, AF8: 0, TP10: 0, AUX: 0 });
    });
});
