import { describe, it, expect, vi } from "vitest";
import { WebBluetoothMuse } from "./client";
import { CONTROL_UUID, EEG_UUIDS, ACCEL_UUID, GYRO_UUID, TELEMETRY_UUID, PPG_UUIDS } from "./protocol";
import { packEegPacket, packTelemetryPacket, packImuPacket } from "./pack";
import { ACCEL_SCALE } from "./decode";
import type {
    BluetoothCharacteristicLike,
    BluetoothDeviceLike,
    BluetoothGattLike,
    BluetoothLike,
    BluetoothServiceLike,
    EegReading,
    StartInstant
} from "./types";

const V1_REPLY = '{"ap":"headset","sp":"RevE","tp":"consumer","hw":"3.1","bn":27,"fw":"1.2.13","bl":"1.2.3","pv":1,"rc":0}';

/** Frame reply text as the headband does: [len, ...ascii], in ≤19-byte chunks. */
function controlChunks(text: string): Uint8Array[] {
    const ascii = new TextEncoder().encode(text);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < ascii.length; i += 19) {
        const part = ascii.subarray(i, i + 19);
        const framed = new Uint8Array(part.length + 1);
        framed[0] = part.length;
        framed.set(part, 1);
        chunks.push(framed);
    }
    return chunks;
}

class FakeCharacteristic implements BluetoothCharacteristicLike {
    value: DataView | null = null;
    notifying = false;
    commands: string[] = [];
    private listeners: ((ev: { target: unknown }) => void)[] = [];
    constructor(
        readonly uuid: string,
        private onWrite?: (cmd: string, self: FakeCharacteristic) => void
    ) {}
    async startNotifications() {
        this.notifying = true;
        return this;
    }
    async writeValue(data: BufferSource) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        const cmd = new TextDecoder().decode(bytes.subarray(1, bytes.length - 1));
        this.commands.push(cmd);
        this.onWrite?.(cmd, this);
    }
    addEventListener(_type: "characteristicvaluechanged", listener: (ev: { target: unknown }) => void) {
        this.listeners.push(listener);
    }
    notify(bytes: Uint8Array) {
        this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (const l of [...this.listeners]) l({ target: this });
    }
}

class FakeService implements BluetoothServiceLike {
    chars = new Map<string, FakeCharacteristic>();
    requested: string[] = [];
    constructor(private replyToV1 = true) {}
    async getCharacteristic(uuid: string) {
        this.requested.push(uuid);
        let c = this.chars.get(uuid);
        if (!c) {
            c = new FakeCharacteristic(uuid, (cmd, self) => {
                if (uuid === CONTROL_UUID && cmd === "v1" && this.replyToV1) {
                    for (const chunk of controlChunks(V1_REPLY)) self.notify(chunk);
                }
            });
            this.chars.set(uuid, c);
        }
        return c;
    }
    char(uuid: string): FakeCharacteristic {
        const c = this.chars.get(uuid);
        if (!c) throw new Error(`characteristic ${uuid} never requested`);
        return c;
    }
}

class FakeDevice implements BluetoothDeviceLike {
    name = "Muse-TEST";
    gatt: FakeGatt;
    private listeners: (() => void)[] = [];
    constructor(service: FakeService) {
        this.gatt = new FakeGatt(this, service);
    }
    addEventListener(_type: "gattserverdisconnected", listener: () => void) {
        this.listeners.push(listener);
    }
    fireDisconnected() {
        for (const l of [...this.listeners]) l();
    }
}

class FakeGatt implements BluetoothGattLike {
    connected = false;
    disconnectCalls = 0;
    constructor(
        private device: FakeDevice,
        private service: FakeService
    ) {}
    async connect() {
        this.connected = true;
        return this;
    }
    disconnect() {
        this.disconnectCalls++;
        this.connected = false;
        this.device.fireDisconnected();
    }
    async getPrimaryService() {
        return this.service;
    }
}

class FakeBluetooth implements BluetoothLike {
    lastFilters: unknown;
    constructor(private device: FakeDevice) {}
    async requestDevice(options: { filters: { services: number[] }[] }) {
        this.lastFilters = options.filters;
        return this.device;
    }
}

function rig(opts: { replyToV1?: boolean; v1TimeoutMs?: number; startInstant?: () => StartInstant } = {}) {
    const service = new FakeService(opts.replyToV1 ?? true);
    const device = new FakeDevice(service);
    const bluetooth = new FakeBluetooth(device);
    let t = 1000;
    const now = () => t;
    const advance = (ms: number) => (t += ms);
    const muse = new WebBluetoothMuse(bluetooth, { now, v1TimeoutMs: opts.v1TimeoutMs, startInstant: opts.startInstant });
    return { service, device, bluetooth, muse, advance };
}

describe("WebBluetoothMuse.connect", () => {
    it("filters on the Muse service, halts, asks v1, subscribes, then sets the preset", async () => {
        const { service, bluetooth, muse } = rig();
        const info = await muse.connect({ preset: "p21" });
        expect(bluetooth.lastFilters).toEqual([{ services: [0xfe8d] }]);
        expect(service.char(CONTROL_UUID).commands).toEqual(["h", "v1", "p21"]);
        expect(service.char(CONTROL_UUID).notifying).toBe(true);
        expect(info).toMatchObject({ name: "Muse-TEST", firmware: "1.2.13", hardware: "3.1" });
        expect(info.raw).toMatchObject({ fw: "1.2.13", rc: 0 });
    });

    it("subscribes to the four EEG channels, IMU and telemetry under p21 — not AUX or PPG", async () => {
        const { service, muse } = rig();
        await muse.connect({ preset: "p21" });
        for (const uuid of [EEG_UUIDS.TP9, EEG_UUIDS.AF7, EEG_UUIDS.AF8, EEG_UUIDS.TP10, ACCEL_UUID, GYRO_UUID, TELEMETRY_UUID]) {
            expect(service.char(uuid).notifying).toBe(true);
        }
        expect(service.requested).not.toContain(EEG_UUIDS.AUX);
        expect(service.requested).not.toContain(PPG_UUIDS.ambient);
    });

    it("subscribes to PPG under p50", async () => {
        const { service, muse } = rig();
        await muse.connect({ preset: "p50" });
        expect(service.char(PPG_UUIDS.ambient).notifying).toBe(true);
        expect(service.char(PPG_UUIDS.red).notifying).toBe(true);
    });

    it("rejects when the headband never answers v1", async () => {
        const { muse } = rig({ replyToV1: false, v1TimeoutMs: 20 });
        await expect(muse.connect({ preset: "p21" })).rejects.toThrow(/no reply/i);
    });
});

describe("WebBluetoothMuse streaming", () => {
    it("start sends s then d", async () => {
        const { service, muse } = rig();
        await muse.connect({ preset: "p21" });
        await muse.start();
        expect(service.char(CONTROL_UUID).commands.slice(-2)).toEqual(["s", "d"]);
    });

    it("returns the wall clock at t0, and takes it from one read — not two that could differ", async () => {
        // A clock that has moved on by the time it is read again. If start() reads
        // it twice — once for t0, once for the anchor — the anchor names an instant
        // the packets are not counted from, and all three assertions below break.
        let reads = 0;
        const startInstant = () => {
            reads += 1;
            return { monoMs: 1000 * reads, epochMs: 1_757_330_000_000 + 1000 * reads };
        };
        const { service, muse, advance } = rig({ startInstant });
        await muse.connect({ preset: "p21" });
        const started = await muse.start();

        expect(reads).toBe(1);
        expect(started).toEqual({ monoMs: 1000, epochMs: 1_757_330_001_000 });

        // t0 is the monoMs of that same read: the page clock also stands at 1000
        // here, so a packet 250 ms later is 250 ms into the session.
        const got: EegReading[] = [];
        muse.on("eeg", r => got.push(r));
        advance(250);
        service.char(EEG_UUIDS.TP9).notify(packEegPacket(1, new Array(12).fill(2048)));
        expect(got[0].tMs).toBe(250);
    });

    it("takes the anchor when streaming is asked for, not when the device was found", async () => {
        let reads = 0;
        const startInstant = () => {
            reads += 1;
            return { monoMs: 1000, epochMs: 1_757_330_001_000 };
        };
        const { muse } = rig({ startInstant });
        await muse.connect({ preset: "p21" });
        expect(reads).toBe(0);
        await muse.start();
        expect(reads).toBe(1);
    });

    it("emits decoded EEG readings with channel, seq and page-relative time", async () => {
        const { service, muse, advance } = rig();
        await muse.connect({ preset: "p21" });
        await muse.start();
        const got: EegReading[] = [];
        muse.on("eeg", r => got.push(r));
        advance(250);
        service.char(EEG_UUIDS.TP9).notify(packEegPacket(42, [2048, 0, 4095, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048, 2048]));
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ kind: "eeg", ch: "TP9", seq: 42, tMs: 250 });
        expect(got[0].uV[0]).toBe(0);
        expect(got[0].uV[1]).toBe(-1000);
    });

    it("emits telemetry and IMU readings", async () => {
        const { service, muse } = rig();
        await muse.connect({ preset: "p21" });
        await muse.start();
        const telemetry = vi.fn();
        const imu = vi.fn();
        muse.on("telemetry", telemetry);
        muse.on("imu", imu);
        service.char(TELEMETRY_UUID).notify(packTelemetryPacket(1, 87, 3700, 30));
        service.char(ACCEL_UUID).notify(
            packImuPacket(
                2,
                [
                    { x: 0, y: 0, z: 1 },
                    { x: 0, y: 0, z: 1 },
                    { x: 0, y: 0, z: 1 }
                ],
                ACCEL_SCALE
            )
        );
        expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: "telemetry", batteryPercent: 87 }));
        expect(imu).toHaveBeenCalledWith(expect.objectContaining({ kind: "imu", sensor: "accelerometer", seq: 2 }));
        expect(imu.mock.calls[0][0].samples[0].z).toBeCloseTo(1, 3);
    });

    it("emits disconnected when the GATT server drops", async () => {
        const { device, muse } = rig();
        await muse.connect({ preset: "p21" });
        const disconnected = vi.fn();
        muse.on("disconnected", disconnected);
        device.fireDisconnected();
        expect(disconnected).toHaveBeenCalledTimes(1);
    });

    it("stop halts the stream and disconnects", async () => {
        const { service, device, muse } = rig();
        await muse.connect({ preset: "p21" });
        await muse.start();
        await muse.stop();
        // Indexed rather than .at(-1): Array.prototype.at is ES2022, and this
        // folder has to compile under a consumer targeting ES2020.
        const commands = service.char(CONTROL_UUID).commands;
        expect(commands[commands.length - 1]).toBe("h");
        expect(device.gatt.disconnectCalls).toBe(1);
    });
});
