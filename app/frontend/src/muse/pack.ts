// Inverse of decode.ts: build the exact byte layouts the headband sends.
// Used by the simulated headband and by tests; never by the real client.
import type { Xyz } from "./types";

export function pack12(samples: number[]): Uint8Array {
    if (samples.length % 2 !== 0) throw new Error("pack12 needs an even number of samples");
    const out = new Uint8Array((samples.length / 2) * 3);
    for (let i = 0, o = 0; i < samples.length; i += 2, o += 3) {
        const a = samples[i] & 0xfff;
        const b = samples[i + 1] & 0xfff;
        out[o] = a >> 4;
        out[o + 1] = ((a & 0x0f) << 4) | (b >> 8);
        out[o + 2] = b & 0xff;
    }
    return out;
}

function withSeq(seq: number, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(2 + body.length);
    new DataView(out.buffer).setUint16(0, seq & 0xffff);
    out.set(body, 2);
    return out;
}

export function packEegPacket(seq: number, samples12: number[]): Uint8Array {
    return withSeq(seq, pack12(samples12));
}

const clampInt16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

export function packImuPacket(seq: number, samples: Xyz[], scale: number): Uint8Array {
    const body = new Uint8Array(samples.length * 6);
    const view = new DataView(body.buffer);
    samples.forEach((s, i) => {
        view.setInt16(i * 6, clampInt16(s.x / scale));
        view.setInt16(i * 6 + 2, clampInt16(s.y / scale));
        view.setInt16(i * 6 + 4, clampInt16(s.z / scale));
    });
    return withSeq(seq, body);
}

export function packPpgPacket(seq: number, counts: number[]): Uint8Array {
    const body = new Uint8Array(counts.length * 3);
    counts.forEach((c, i) => {
        const v = c & 0xffffff;
        body[i * 3] = v >> 16;
        body[i * 3 + 1] = (v >> 8) & 0xff;
        body[i * 3 + 2] = v & 0xff;
    });
    return withSeq(seq, body);
}

export function packTelemetryPacket(seq: number, batteryPercent: number, fuelGaugeMv: number, temperature: number): Uint8Array {
    const out = new Uint8Array(10);
    const view = new DataView(out.buffer);
    view.setUint16(0, seq & 0xffff);
    view.setUint16(2, Math.round(batteryPercent * 512));
    view.setUint16(4, Math.round(fuelGaugeMv / 2.2));
    view.setUint16(8, Math.round(temperature));
    return out;
}

export function toDataView(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
