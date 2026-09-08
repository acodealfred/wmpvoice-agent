// Pure decoders for Muse BLE notifications. Every function takes the bytes as
// the characteristic delivers them (sequence number first) and returns plain
// numbers in physical units. No state, no side effects.
import type { Xyz } from "./types";

export const EEG_UV_PER_LSB = 0.48828125; // 125 / 256
export const EEG_ZERO = 2048;
export const ACCEL_SCALE = 1 / 16384; // g per LSB (±2 g range)
export const GYRO_SCALE = 0.0074768; // °/s per LSB

/** Three bytes hold two 12-bit samples: AAAAAAAA AAAABBBB BBBBBBBB. */
export function decodeUnsigned12(bytes: Uint8Array): number[] {
    const out: number[] = [];
    for (let i = 0; i + 2 < bytes.length; i += 3) {
        out.push((bytes[i] << 4) | (bytes[i + 1] >> 4));
        out.push(((bytes[i + 1] & 0x0f) << 8) | bytes[i + 2]);
    }
    return out;
}

export function decodeUnsigned24(bytes: Uint8Array): number[] {
    const out: number[] = [];
    for (let i = 0; i + 2 < bytes.length; i += 3) {
        out.push((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
    }
    return out;
}

export function eegMicrovolts(raw: number): number {
    return EEG_UV_PER_LSB * (raw - EEG_ZERO);
}

function payload(view: DataView, offset: number): Uint8Array {
    return new Uint8Array(view.buffer, view.byteOffset + offset, view.byteLength - offset);
}

export function decodeEegPacket(view: DataView): { seq: number; uV: number[] } {
    return {
        seq: view.getUint16(0),
        uV: decodeUnsigned12(payload(view, 2)).map(eegMicrovolts)
    };
}

function decodeImuPacket(view: DataView, scale: number): { seq: number; samples: Xyz[] } {
    const sample = (at: number): Xyz => ({
        x: scale * view.getInt16(at),
        y: scale * view.getInt16(at + 2),
        z: scale * view.getInt16(at + 4)
    });
    return { seq: view.getUint16(0), samples: [sample(2), sample(8), sample(14)] };
}

export function decodeAccelPacket(view: DataView): { seq: number; samples: Xyz[] } {
    return decodeImuPacket(view, ACCEL_SCALE);
}

export function decodeGyroPacket(view: DataView): { seq: number; samples: Xyz[] } {
    return decodeImuPacket(view, GYRO_SCALE);
}

export function decodePpgPacket(view: DataView): { seq: number; counts: number[] } {
    return { seq: view.getUint16(0), counts: decodeUnsigned24(payload(view, 2)) };
}

export function decodeTelemetryPacket(view: DataView): {
    seq: number;
    batteryPercent: number;
    fuelGaugeMv: number;
    temperature: number;
} {
    return {
        seq: view.getUint16(0),
        batteryPercent: view.getUint16(2) / 512,
        fuelGaugeMv: view.getUint16(4) * 2.2,
        temperature: view.getUint16(8)
    };
}
