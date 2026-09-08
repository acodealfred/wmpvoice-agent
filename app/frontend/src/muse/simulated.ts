// A headband that exists only in software. It builds the same bytes the real
// device sends and pushes them through the same decoders, so the page and the
// session file are exercised end-to-end without hardware.
import {
    EEG_RATE_HZ,
    EEG_SAMPLES_PER_PACKET,
    IMU_RATE_HZ,
    IMU_SAMPLES_PER_PACKET,
    PPG_RATE_HZ,
    PPG_SAMPLES_PER_PACKET,
    PPG_UUIDS,
    channelsForPreset,
    presetHasPpg,
    type EegChannel,
    type PpgChannel,
    type Preset
} from "./protocol";
import {
    ACCEL_SCALE,
    GYRO_SCALE,
    EEG_UV_PER_LSB,
    EEG_ZERO,
    decodeEegPacket,
    decodeAccelPacket,
    decodeGyroPacket,
    decodePpgPacket,
    decodeTelemetryPacket
} from "./decode";
import { packEegPacket, packImuPacket, packPpgPacket, packTelemetryPacket, toDataView } from "./pack";
import { TypedEmitter } from "./emitter";
import type { DeviceInfo, MuseEvents, MuseSource, StartInstant, Xyz } from "./types";

export const ALPHA_HZ = 10;
export const ALPHA_UV = 20;
export const BLINK_UV = 150;
export const BLINK_PERIOD_S = 4;
export const BLINK_WIDTH_S = 0.3;
export const NOISE_UV = 8;
const DEFAULT_DROP_EVERY = 97;
const EEG_PERIOD_MS = (1000 * EEG_SAMPLES_PER_PACKET) / EEG_RATE_HZ;
const IMU_PERIOD_MS = (1000 * IMU_SAMPLES_PER_PACKET) / IMU_RATE_HZ;
const PPG_PERIOD_MS = (1000 * PPG_SAMPLES_PER_PACKET) / PPG_RATE_HZ;
const TELEMETRY_PERIOD_MS = 1000;

export interface SimulatedOptions {
    seed?: number;
    /** Drop every Nth EEG packet on AF7 to exercise drop counting. 0 disables. */
    dropEvery?: number;
    now?: () => number;
    /** The single read of both clocks that `start()` takes; see the real client. */
    startInstant?: () => StartInstant;
}

/** Small seeded PRNG so tests are repeatable. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class SimulatedMuse implements MuseSource {
    readonly kind = "simulated" as const;
    eyesClosed = false;

    private emitter = new TypedEmitter<MuseEvents>();
    private preset: Preset = "p21";
    private timers: ReturnType<typeof setInterval>[] = [];
    private rng: () => number;
    private now: () => number;
    private startInstant: () => StartInstant;
    private dropEvery: number;
    private t0 = 0;
    private eegEmitted = 0;
    private imuEmitted = 0;
    private ppgEmitted = 0;
    private telemetryEmitted = 0;
    private battery = 87;

    constructor(opts: SimulatedOptions = {}) {
        this.rng = mulberry32(opts.seed ?? 1);
        this.now = opts.now ?? (() => performance.now());
        this.startInstant = opts.startInstant ?? (() => ({ monoMs: this.now(), epochMs: Date.now() }));
        this.dropEvery = opts.dropEvery ?? DEFAULT_DROP_EVERY;
    }

    on<K extends keyof MuseEvents>(event: K, fn: (payload: MuseEvents[K]) => void): () => void {
        return this.emitter.on(event, fn);
    }

    async connect({ preset }: { preset: Preset }): Promise<DeviceInfo> {
        this.preset = preset;
        return { name: "Muse-SIM", model: "Simulated Muse 2", firmware: "sim-1", raw: { simulated: true } };
    }

    // Packets are emitted by wall-clock time, not by timer tick: each tick emits
    // everything that has become due. A throttled background tab (timers at
    // 1 Hz) then still produces the right number of samples, as a real
    // headband would.
    async start(): Promise<StartInstant> {
        // One read for both clocks, exactly as the real client does it, so a
        // simulated run produces the same anchored session file.
        const t0 = this.startInstant();
        this.t0 = t0.monoMs;
        this.timers.push(setInterval(() => this.catchUp(EEG_PERIOD_MS, () => this.eegEmitted, () => this.tickEeg()), EEG_PERIOD_MS));
        this.timers.push(setInterval(() => this.catchUp(IMU_PERIOD_MS, () => this.imuEmitted, () => this.tickImu()), IMU_PERIOD_MS));
        this.timers.push(setInterval(() => this.catchUp(TELEMETRY_PERIOD_MS, () => this.telemetryEmitted, () => this.tickTelemetry()), TELEMETRY_PERIOD_MS));
        if (presetHasPpg(this.preset)) {
            this.timers.push(setInterval(() => this.catchUp(PPG_PERIOD_MS, () => this.ppgEmitted, () => this.tickPpg()), PPG_PERIOD_MS));
        }
        return t0;
    }

    private catchUp(periodMs: number, emitted: () => number, emitOne: () => void): void {
        const due = Math.floor(this.t() / periodMs);
        while (emitted() < due) emitOne();
    }

    async stop(): Promise<void> {
        for (const id of this.timers) clearInterval(id);
        this.timers = [];
        this.emitter.emit("disconnected", undefined);
    }

    private t(): number {
        return this.now() - this.t0;
    }

    private gaussian(): number {
        const u = 1 - this.rng();
        const v = this.rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    /** One EEG sample in µV for a channel at signal time `s` seconds. */
    private eegSample(ch: EegChannel, s: number): number {
        let v = NOISE_UV * this.gaussian();
        if (this.eyesClosed && (ch === "TP9" || ch === "TP10")) {
            v += ALPHA_UV * Math.sin(2 * Math.PI * ALPHA_HZ * s);
        }
        if (ch === "AF7" || ch === "AF8") {
            const phase = s % BLINK_PERIOD_S;
            if (phase < BLINK_WIDTH_S) v += BLINK_UV * Math.sin((Math.PI * phase) / BLINK_WIDTH_S);
        }
        return v;
    }

    private tickEeg(): void {
        const n = this.eegEmitted++;
        const seq = n & 0xffff;
        const base = n * EEG_SAMPLES_PER_PACKET;
        const tMs = n * EEG_PERIOD_MS;
        for (const ch of channelsForPreset(this.preset)) {
            if (ch === "AF7" && this.dropEvery > 0 && seq % this.dropEvery === 0) continue;
            const raw: number[] = [];
            for (let k = 0; k < EEG_SAMPLES_PER_PACKET; k++) {
                const uv = this.eegSample(ch, (base + k) / EEG_RATE_HZ);
                raw.push(Math.max(0, Math.min(4095, Math.round(uv / EEG_UV_PER_LSB + EEG_ZERO))));
            }
            const decoded = decodeEegPacket(toDataView(packEegPacket(seq, raw)));
            this.emitter.emit("eeg", { kind: "eeg", ch, seq: decoded.seq, tMs, uV: decoded.uV });
        }
    }

    private tickImu(): void {
        const n = this.imuEmitted++;
        const seq = n & 0xffff;
        const tMs = n * IMU_PERIOD_MS;
        const accel: Xyz[] = [];
        const gyro: Xyz[] = [];
        for (let k = 0; k < IMU_SAMPLES_PER_PACKET; k++) {
            accel.push({ x: 0.02 * this.gaussian(), y: 0.01 * this.gaussian(), z: 1 + 0.01 * this.gaussian() });
            gyro.push({ x: 0.5 * this.gaussian(), y: 0.5 * this.gaussian(), z: 0.5 * this.gaussian() });
        }
        const a = decodeAccelPacket(toDataView(packImuPacket(seq, accel, ACCEL_SCALE)));
        this.emitter.emit("imu", { kind: "imu", sensor: "accelerometer", seq: a.seq, tMs, samples: a.samples });
        const g = decodeGyroPacket(toDataView(packImuPacket(seq, gyro, GYRO_SCALE)));
        this.emitter.emit("imu", { kind: "imu", sensor: "gyroscope", seq: g.seq, tMs, samples: g.samples });
    }

    private tickPpg(): void {
        const n = this.ppgEmitted++;
        const seq = n & 0xffff;
        const tMs = n * PPG_PERIOD_MS;
        const s = tMs / 1000;
        for (const ch of Object.keys(PPG_UUIDS) as PpgChannel[]) {
            const counts: number[] = [];
            for (let k = 0; k < PPG_SAMPLES_PER_PACKET; k++) {
                const tt = s + k / PPG_RATE_HZ;
                const pulse = 20000 * Math.sin(2 * Math.PI * 1.1 * tt); // ~66 bpm
                counts.push(Math.max(0, Math.round(500000 + pulse + 2000 * this.gaussian())));
            }
            const d = decodePpgPacket(toDataView(packPpgPacket(seq, counts)));
            this.emitter.emit("ppg", { kind: "ppg", ch, seq: d.seq, tMs, counts: d.counts });
        }
    }

    private tickTelemetry(): void {
        const n = this.telemetryEmitted++;
        const seq = n & 0xffff;
        this.battery = Math.max(0, this.battery - 0.01);
        const d = decodeTelemetryPacket(toDataView(packTelemetryPacket(seq, this.battery, 3700, 30)));
        this.emitter.emit("telemetry", { kind: "telemetry", tMs: n * TELEMETRY_PERIOD_MS, ...d });
    }
}
