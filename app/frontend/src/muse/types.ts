import type { EegChannel, PpgChannel, Preset } from "./protocol";

export interface DeviceInfo {
    name: string;
    model?: string;
    firmware?: string;
    hardware?: string;
    serial?: string;
    /** The headband's raw `v1` reply, kept verbatim for the session file. */
    raw?: Record<string, unknown>;
}

export interface Xyz {
    x: number;
    y: number;
    z: number;
}

/** `tMs` on every reading is milliseconds since `start()` resolved, from the page clock. */
export interface EegReading {
    kind: "eeg";
    ch: EegChannel;
    seq: number;
    tMs: number;
    uV: number[];
}

export interface ImuReading {
    kind: "imu";
    sensor: "accelerometer" | "gyroscope";
    seq: number;
    tMs: number;
    samples: Xyz[];
}

export interface PpgReading {
    kind: "ppg";
    ch: PpgChannel;
    seq: number;
    tMs: number;
    counts: number[];
}

export interface Telemetry {
    kind: "telemetry";
    seq: number;
    tMs: number;
    batteryPercent: number;
    fuelGaugeMv: number;
    temperature: number;
}

export type Reading = EegReading | ImuReading | PpgReading | Telemetry;

export type MuseEvents = {
    eeg: EegReading;
    imu: ImuReading;
    ppg: PpgReading;
    telemetry: Telemetry;
    disconnected: undefined;
};

/**
 * One read of both clocks. The two must come from a single read: `monoMs` is the
 * origin every packet's `tMs` counts from, and `epochMs` says what wall-clock
 * instant that origin was, so a recording can be lined up with something recorded
 * elsewhere. Read them separately and the anchor names an instant the packets are
 * not counted from.
 */
export interface StartInstant {
    /** Page-clock milliseconds, on the same clock as the source's `now`. */
    monoMs: number;
    /** Wall clock at that same instant, milliseconds since the epoch. */
    epochMs: number;
}

export interface MuseSource {
    readonly kind: "bluetooth" | "simulated";
    connect(opts: { preset: Preset }): Promise<DeviceInfo>;
    /** Begin streaming, returning the instant `tMs` is counted from. */
    start(): Promise<StartInstant>;
    stop(): Promise<void>;
    on<K extends keyof MuseEvents>(event: K, fn: (payload: MuseEvents[K]) => void): () => void;
}

// Narrow views of the Web Bluetooth API — just what the client touches, so
// tests can supply fakes and we avoid a types dependency.

export interface BluetoothCharacteristicLike {
    readonly uuid: string;
    readonly value?: DataView | null;
    startNotifications(): Promise<unknown>;
    writeValue(data: BufferSource): Promise<void>;
    addEventListener(type: "characteristicvaluechanged", listener: (ev: { target: unknown }) => void): void;
}

export interface BluetoothServiceLike {
    getCharacteristic(uuid: string): Promise<BluetoothCharacteristicLike>;
}

export interface BluetoothGattLike {
    readonly connected: boolean;
    connect(): Promise<BluetoothGattLike>;
    disconnect(): void;
    getPrimaryService(uuid: number | string): Promise<BluetoothServiceLike>;
}

export interface BluetoothDeviceLike {
    readonly name?: string | null;
    readonly gatt?: BluetoothGattLike | null;
    addEventListener(type: "gattserverdisconnected", listener: () => void): void;
}

export interface BluetoothLike {
    requestDevice(options: { filters: { services: number[] }[] }): Promise<BluetoothDeviceLike>;
}
