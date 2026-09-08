// The public surface of the Muse bridge — the one import a consuming app needs.
//
// Everything here is dependency-free TypeScript over DataView/Uint8Array. There
// is no DOM access and no npm import in this folder: `navigator.bluetooth` is
// passed *in* to WebBluetoothMuse, so the folder can be lifted into another
// frontend unchanged. See docs/muse-integration.md.
//
// Re-exports are explicit rather than `export *`, so what a consumer may depend
// on stays a deliberate decision; src/muse/index.test.ts asserts this list.

// Sources — both implement MuseSource, so a consumer can swap the simulated
// headband in with no other change.
export { WebBluetoothMuse, V1_TIMEOUT_MS, type WebBluetoothMuseOptions } from "./client";
export { SimulatedMuse, ALPHA_HZ, ALPHA_UV, BLINK_UV, BLINK_PERIOD_S, BLINK_WIDTH_S, NOISE_UV, type SimulatedOptions } from "./simulated";

// Protocol constants and framing.
export {
    MUSE_SERVICE,
    CONTROL_UUID,
    GYRO_UUID,
    ACCEL_UUID,
    TELEMETRY_UUID,
    EEG_UUIDS,
    PPG_UUIDS,
    EEG_RATE_HZ,
    EEG_SAMPLES_PER_PACKET,
    IMU_RATE_HZ,
    IMU_SAMPLES_PER_PACKET,
    PPG_RATE_HZ,
    PPG_SAMPLES_PER_PACKET,
    channelsForPreset,
    presetHasPpg,
    eegChannelForUuid,
    ppgChannelForUuid,
    encodeCommand,
    decodeControlChunk,
    ControlAssembler,
    type EegChannel,
    type PpgChannel,
    type Preset
} from "./protocol";

// Pure decoders. EEG_UV_PER_LSB is disputed — record it alongside any data you
// keep rather than treating it as settled. See docs/muse-2-findings.md.
export {
    EEG_UV_PER_LSB,
    EEG_ZERO,
    ACCEL_SCALE,
    GYRO_SCALE,
    decodeUnsigned12,
    decodeUnsigned24,
    eegMicrovolts,
    decodeEegPacket,
    decodeAccelPacket,
    decodeGyroPacket,
    decodePpgPacket,
    decodeTelemetryPacket
} from "./decode";

// Builds the same bytes the headband sends — for consumers writing their own
// fake GATT server in tests.
export { pack12, packEegPacket, packImuPacket, packPpgPacket, packTelemetryPacket, toDataView } from "./pack";

export { TypedEmitter } from "./emitter";

export type {
    DeviceInfo,
    Xyz,
    EegReading,
    ImuReading,
    PpgReading,
    Telemetry,
    Reading,
    MuseEvents,
    StartInstant,
    MuseSource,
    BluetoothLike,
    BluetoothDeviceLike,
    BluetoothGattLike,
    BluetoothServiceLike,
    BluetoothCharacteristicLike
} from "./types";
