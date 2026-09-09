// Real headband over Web Bluetooth. The Bluetooth object is injected so tests
// drive it with a fake GATT; the page passes navigator.bluetooth.
import {
    MUSE_SERVICE,
    CONTROL_UUID,
    ACCEL_UUID,
    GYRO_UUID,
    TELEMETRY_UUID,
    EEG_UUIDS,
    PPG_UUIDS,
    channelsForPreset,
    presetHasPpg,
    encodeCommand,
    decodeControlChunk,
    ControlAssembler,
    type Preset,
    type PpgChannel
} from "./protocol";
import { decodeEegPacket, decodeAccelPacket, decodeGyroPacket, decodePpgPacket, decodeTelemetryPacket } from "./decode";
import { TypedEmitter } from "./emitter";
import type { BluetoothCharacteristicLike, BluetoothGattLike, BluetoothLike, DeviceInfo, MuseEvents, MuseSource, StartInstant } from "./types";

export const V1_TIMEOUT_MS = 3000;

export interface WebBluetoothMuseOptions {
    now?: () => number;
    v1TimeoutMs?: number;
    /**
     * The single read of both clocks that `start()` takes. One seam, so the
     * wall-clock anchor and `t0` cannot drift apart.
     */
    startInstant?: () => StartInstant;
}

type ControlMessage = Record<string, unknown>;

export class WebBluetoothMuse implements MuseSource {
    readonly kind = "bluetooth" as const;

    private emitter = new TypedEmitter<MuseEvents>();
    private gatt: BluetoothGattLike | null = null;
    private control: BluetoothCharacteristicLike | null = null;
    private assembler = new ControlAssembler();
    private controlWaiters: ((m: ControlMessage) => void)[] = [];
    private now: () => number;
    private startInstant: () => StartInstant;
    private v1TimeoutMs: number;
    private t0 = 0;

    constructor(
        private bluetooth: BluetoothLike,
        opts: WebBluetoothMuseOptions = {}
    ) {
        this.now = opts.now ?? (() => performance.now());
        this.startInstant = opts.startInstant ?? (() => ({ monoMs: this.now(), epochMs: Date.now() }));
        this.v1TimeoutMs = opts.v1TimeoutMs ?? V1_TIMEOUT_MS;
    }

    on<K extends keyof MuseEvents>(event: K, fn: (payload: MuseEvents[K]) => void): () => void {
        return this.emitter.on(event, fn);
    }

    async connect({ preset }: { preset: Preset }): Promise<DeviceInfo> {
        const device = await this.bluetooth.requestDevice({ filters: [{ services: [MUSE_SERVICE] }] });
        if (!device.gatt) throw new Error("This device does not expose a GATT server.");
        const gatt = await device.gatt.connect();
        this.gatt = gatt;
        this.t0 = this.now();
        device.addEventListener("gattserverdisconnected", () => {
            this.gatt = null;
            this.emitter.emit("disconnected", undefined);
        });

        const service = await gatt.getPrimaryService(MUSE_SERVICE);
        this.control = await service.getCharacteristic(CONTROL_UUID);
        await this.subscribe(this.control, view => this.onControl(view));

        await this.send("h");
        const reply = this.nextControlMessage(m => typeof m.fw === "string");
        await this.send("v1");
        const info = await withTimeout(reply, this.v1TimeoutMs, "No reply to v1 from the headband.");

        for (const ch of channelsForPreset(preset)) {
            const c = await service.getCharacteristic(EEG_UUIDS[ch]);
            await this.subscribe(c, view => {
                const { seq, uV } = decodeEegPacket(view);
                this.emitter.emit("eeg", { kind: "eeg", ch, seq, tMs: this.t(), uV });
            });
        }
        await this.subscribe(await service.getCharacteristic(ACCEL_UUID), view => {
            const { seq, samples } = decodeAccelPacket(view);
            this.emitter.emit("imu", { kind: "imu", sensor: "accelerometer", seq, tMs: this.t(), samples });
        });
        await this.subscribe(await service.getCharacteristic(GYRO_UUID), view => {
            const { seq, samples } = decodeGyroPacket(view);
            this.emitter.emit("imu", { kind: "imu", sensor: "gyroscope", seq, tMs: this.t(), samples });
        });
        await this.subscribe(await service.getCharacteristic(TELEMETRY_UUID), view => {
            const t = decodeTelemetryPacket(view);
            this.emitter.emit("telemetry", { kind: "telemetry", tMs: this.t(), ...t });
        });
        if (presetHasPpg(preset)) {
            for (const ch of Object.keys(PPG_UUIDS) as PpgChannel[]) {
                const c = await service.getCharacteristic(PPG_UUIDS[ch]);
                await this.subscribe(c, view => {
                    const { seq, counts } = decodePpgPacket(view);
                    this.emitter.emit("ppg", { kind: "ppg", ch, seq, tMs: this.t(), counts });
                });
            }
        }

        await this.send(preset);

        return {
            name: device.name ?? "Muse",
            firmware: typeof info.fw === "string" ? info.fw : undefined,
            hardware: typeof info.hw === "string" ? info.hw : undefined,
            raw: info
        };
    }

    async start(): Promise<StartInstant> {
        // One read for both clocks, before the stream commands go out: `t0` is the
        // origin of every packet's `tMs`, and the epoch beside it is the only thing
        // tying that origin to a clock another recorder can see.
        const t0 = this.startInstant();
        this.t0 = t0.monoMs;
        await this.send("s");
        await this.send("d");
        return t0;
    }

    async stop(): Promise<void> {
        try {
            await this.send("h");
        } catch {
            // Already gone; the disconnect below is what matters.
        }
        this.gatt?.disconnect();
        this.gatt = null;
    }

    private t(): number {
        return this.now() - this.t0;
    }

    private async send(cmd: string): Promise<void> {
        if (!this.control) throw new Error("Not connected.");
        await this.control.writeValue(encodeCommand(cmd));
    }

    private async subscribe(c: BluetoothCharacteristicLike, onValue: (view: DataView) => void): Promise<void> {
        c.addEventListener("characteristicvaluechanged", ev => {
            const view = (ev.target as BluetoothCharacteristicLike).value;
            if (view) onValue(view);
        });
        await c.startNotifications();
    }

    private onControl(view: DataView): void {
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        for (const msg of this.assembler.push(decodeControlChunk(bytes))) {
            const waiters = this.controlWaiters;
            this.controlWaiters = [];
            for (const w of waiters) w(msg);
        }
    }

    private nextControlMessage(match: (m: ControlMessage) => boolean): Promise<ControlMessage> {
        return new Promise(resolve => {
            const waiter = (m: ControlMessage) => {
                if (match(m)) resolve(m);
                else this.controlWaiters.push(waiter);
            };
            this.controlWaiters.push(waiter);
        });
    }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const id = setTimeout(() => reject(new Error(message)), ms);
        p.then(
            v => {
                clearTimeout(id);
                resolve(v);
            },
            e => {
                clearTimeout(id);
                reject(e);
            }
        );
    });
}
