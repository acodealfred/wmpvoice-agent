import { describe, it, expect } from "vitest";
import {
    decodeUnsigned12,
    decodeUnsigned24,
    eegMicrovolts,
    decodeEegPacket,
    decodeAccelPacket,
    decodeGyroPacket,
    decodePpgPacket,
    decodeTelemetryPacket,
    ACCEL_SCALE,
    GYRO_SCALE
} from "./decode";
import { pack12, packEegPacket, packImuPacket, packPpgPacket, packTelemetryPacket, toDataView } from "./pack";

describe("12-bit unpacking", () => {
    it("unpacks two samples from three bytes", () => {
        expect(decodeUnsigned12(new Uint8Array([0x80, 0x00, 0x00]))).toEqual([0x800, 0x000]);
        expect(decodeUnsigned12(new Uint8Array([0xff, 0xfa, 0xbc]))).toEqual([0xfff, 0xabc]);
    });

    it("unpacks 12 samples from an 18-byte payload", () => {
        const samples = [0, 1, 2, 4095, 2048, 2047, 100, 200, 300, 400, 500, 600];
        expect(decodeUnsigned12(pack12(samples))).toEqual(samples);
    });

    it("ignores a dangling partial group", () => {
        expect(decodeUnsigned12(new Uint8Array([0x80, 0x00, 0x00, 0xff]))).toEqual([0x800, 0x000]);
    });
});

describe("24-bit unpacking", () => {
    it("reads big-endian triplets", () => {
        expect(decodeUnsigned24(new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xff, 0xff]))).toEqual([0x010203, 0xffffff]);
    });
});

describe("EEG scaling", () => {
    it.each([
        [0x800, 0],
        [0x000, -1000],
        [0xfff, 999.51171875],
        [0x801, 0.48828125]
    ])("raw %i → %f µV", (raw, uv) => {
        expect(eegMicrovolts(raw)).toBeCloseTo(uv, 8);
    });
});

describe("EEG packet", () => {
    it("reads the big-endian sequence number and 12 µV samples", () => {
        const bytes = packEegPacket(0x1234, [2048, 0, 4095, 2049, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048]);
        expect(bytes.length).toBe(20);
        const { seq, uV } = decodeEegPacket(toDataView(bytes));
        expect(seq).toBe(0x1234);
        expect(uV).toHaveLength(12);
        expect(uV[0]).toBe(0);
        expect(uV[1]).toBe(-1000);
        expect(uV[2]).toBeCloseTo(999.51171875, 8);
        expect(uV[3]).toBeCloseTo(0.48828125, 8);
    });

    it("honours a DataView byteOffset", () => {
        const packet = packEegPacket(7, new Array(12).fill(2048));
        const padded = new Uint8Array(4 + packet.length);
        padded.set(packet, 4);
        const view = new DataView(padded.buffer, 4, packet.length);
        expect(decodeEegPacket(view)).toEqual({ seq: 7, uV: new Array(12).fill(0) });
    });
});

describe("IMU packets", () => {
    const samples = [
        { x: 0.5, y: -0.25, z: 1 },
        { x: 0, y: 0, z: 0 },
        { x: -1, y: 0.125, z: 0.75 }
    ];

    it("round-trips accelerometer samples in g at the documented scale", () => {
        expect(ACCEL_SCALE).toBeCloseTo(0.0000610352, 9);
        const bytes = packImuPacket(300, samples, ACCEL_SCALE);
        expect(bytes.length).toBe(20);
        const out = decodeAccelPacket(toDataView(bytes));
        expect(out.seq).toBe(300);
        out.samples.forEach((s, i) => {
            expect(s.x).toBeCloseTo(samples[i].x, 4);
            expect(s.y).toBeCloseTo(samples[i].y, 4);
            expect(s.z).toBeCloseTo(samples[i].z, 4);
        });
    });

    it("round-trips gyroscope samples in °/s", () => {
        expect(GYRO_SCALE).toBe(0.0074768);
        const deg = [
            { x: 10, y: -20, z: 30 },
            { x: 0, y: 0, z: 0 },
            { x: 244, y: -244, z: 1 }
        ];
        const out = decodeGyroPacket(toDataView(packImuPacket(9, deg, GYRO_SCALE)));
        out.samples.forEach((s, i) => {
            expect(s.x).toBeCloseTo(deg[i].x, 1);
            expect(s.y).toBeCloseTo(deg[i].y, 1);
            expect(s.z).toBeCloseTo(deg[i].z, 1);
        });
    });

    it("reads samples from byte offsets 2, 8 and 14", () => {
        const view = toDataView(packImuPacket(1, samples, ACCEL_SCALE));
        expect(view.getInt16(2)).toBe(Math.round(0.5 / ACCEL_SCALE));
        expect(view.getInt16(14)).toBe(Math.round(-1 / ACCEL_SCALE));
    });
});

describe("PPG packet", () => {
    it("reads six 24-bit counts after the sequence number", () => {
        const counts = [0, 1, 0xffffff, 123456, 654321, 42];
        const out = decodePpgPacket(toDataView(packPpgPacket(65535, counts)));
        expect(out).toEqual({ seq: 65535, counts });
    });
});

describe("telemetry packet", () => {
    it("scales battery, fuel gauge and temperature", () => {
        const view = toDataView(packTelemetryPacket(5, 87.5, 3700, 30));
        const out = decodeTelemetryPacket(view);
        expect(out.seq).toBe(5);
        expect(out.batteryPercent).toBeCloseTo(87.5, 2);
        expect(out.fuelGaugeMv).toBeCloseTo(3700, 0);
        expect(out.temperature).toBe(30);
    });

    it("reads the documented offsets", () => {
        const bytes = new Uint8Array(10);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, 1);
        view.setUint16(2, 512 * 50);
        view.setUint16(4, 1000);
        view.setUint16(8, 25);
        expect(decodeTelemetryPacket(view)).toEqual({
            seq: 1,
            batteryPercent: 50,
            fuelGaugeMv: 2200,
            temperature: 25
        });
    });
});
