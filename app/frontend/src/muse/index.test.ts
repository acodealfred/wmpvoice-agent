// The barrel is the handoff contract: what a consuming app imports from
// `muse/`. These tests fail if a re-export is dropped or renamed, which is
// exactly the breakage a lift-and-shift into another repo would otherwise
// surface only at the consumer's build.
import { describe, it, expect } from "vitest";
import * as muse from "./index";
import { EEG_UV_PER_LSB, EEG_ZERO, decodeEegPacket } from "./decode";
import { EEG_RATE_HZ, MUSE_SERVICE } from "./protocol";
import type { MuseSource } from "./types";

// This list IS the documented contract in docs/muse-integration.md. Adding to
// it should be a deliberate edit to both.
const CONTRACT = [
    // sources
    "WebBluetoothMuse",
    "SimulatedMuse",
    "V1_TIMEOUT_MS",
    // protocol
    "MUSE_SERVICE",
    "CONTROL_UUID",
    "EEG_UUIDS",
    "PPG_UUIDS",
    "GYRO_UUID",
    "ACCEL_UUID",
    "TELEMETRY_UUID",
    "EEG_RATE_HZ",
    "EEG_SAMPLES_PER_PACKET",
    "IMU_RATE_HZ",
    "IMU_SAMPLES_PER_PACKET",
    "PPG_RATE_HZ",
    "PPG_SAMPLES_PER_PACKET",
    "channelsForPreset",
    "presetHasPpg",
    "eegChannelForUuid",
    "ppgChannelForUuid",
    "encodeCommand",
    "decodeControlChunk",
    "ControlAssembler",
    // decode
    "EEG_UV_PER_LSB",
    "EEG_ZERO",
    "ACCEL_SCALE",
    "GYRO_SCALE",
    "decodeUnsigned12",
    "decodeUnsigned24",
    "eegMicrovolts",
    "decodeEegPacket",
    "decodeAccelPacket",
    "decodeGyroPacket",
    "decodePpgPacket",
    "decodeTelemetryPacket",
    // building device bytes, for consumers writing their own fakes
    "pack12",
    "packEegPacket",
    "packImuPacket",
    "packPpgPacket",
    "packTelemetryPacket",
    "toDataView",
    // simulated headband knobs
    "ALPHA_HZ",
    "ALPHA_UV",
    "BLINK_UV",
    "BLINK_PERIOD_S",
    "BLINK_WIDTH_S",
    "NOISE_UV",
    // support
    "TypedEmitter"
];

describe("muse barrel", () => {
    it("re-exports the identical bindings, not copies", () => {
        expect(muse.EEG_UV_PER_LSB).toBe(EEG_UV_PER_LSB);
        expect(muse.EEG_ZERO).toBe(EEG_ZERO);
        expect(muse.EEG_RATE_HZ).toBe(EEG_RATE_HZ);
        expect(muse.MUSE_SERVICE).toBe(MUSE_SERVICE);
        expect(muse.decodeEegPacket).toBe(decodeEegPacket);
    });

    it("exposes exactly the documented surface — no more, no less", () => {
        // Exact set equality both ways: a missing export breaks the consuming
        // app, and an accidental `export *` of a module's internals silently
        // widens what that app is allowed to depend on.
        expect(Object.keys(muse).sort()).toEqual([...CONTRACT].sort());
    });

    it("builds both sources through the barrel and they satisfy MuseSource", () => {
        const sim: MuseSource = new muse.SimulatedMuse();
        const bt: MuseSource = new muse.WebBluetoothMuse({
            requestDevice: async () => {
                throw new Error("not used");
            }
        });
        expect(sim.kind).toBe("simulated");
        expect(bt.kind).toBe("bluetooth");
        for (const source of [sim, bt]) {
            expect(typeof source.connect).toBe("function");
            expect(typeof source.start).toBe("function");
            expect(typeof source.stop).toBe("function");
            expect(typeof source.on).toBe("function");
        }
    });

    it("carries working functions, not just names", () => {
        // Round-trip real device bytes through the barrel's own pack + decode.
        const uV = [10, -10, 20, -20, 0, 5, -5, 15, -15, 1, -1, 2];
        const codes = uV.map(v => Math.round(v / muse.EEG_UV_PER_LSB) + muse.EEG_ZERO);
        const view = muse.toDataView(muse.packEegPacket(7, codes));
        const decoded = muse.decodeEegPacket(view);
        expect(decoded.seq).toBe(7);
        expect(decoded.uV).toHaveLength(muse.EEG_SAMPLES_PER_PACKET);
        // The wire carries 12-bit codes, so a round trip is exact only to half
        // an LSB (0.244 uV here). Asserting tighter would be asserting against
        // the format rather than the code.
        const tolerance = muse.EEG_UV_PER_LSB / 2 + 1e-9;
        for (let i = 0; i < uV.length; i++) {
            expect(Math.abs(decoded.uV[i] - uV[i]), `sample ${i}`).toBeLessThanOrEqual(tolerance);
        }
    });

    it("keeps the p50 preset the one that carries PPG", () => {
        expect(muse.presetHasPpg("p50")).toBe(true);
        expect(muse.presetHasPpg("p21")).toBe(false);
        expect(muse.channelsForPreset("p21")).toEqual(["TP9", "AF7", "AF8", "TP10"]);
        expect(muse.channelsForPreset("p20")).toEqual(["TP9", "AF7", "AF8", "TP10", "AUX"]);
    });
});
