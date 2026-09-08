// Muse 2 / Muse S (gen 1-2) BLE protocol constants and control framing.
// Source: muse-js (MIT, github.com/urish/muse-js), cross-checked against the
// InterAxon SDK 8.0.9 release notes. All multi-byte integers are big-endian.

export const MUSE_SERVICE = 0xfe8d;

const UUID_SUFFIX = "-4c4d-454d-96be-f03bac821358";
const uuid = (short: string) => `273e${short}${UUID_SUFFIX}`;

export const CONTROL_UUID = uuid("0001");
export const GYRO_UUID = uuid("0009");
export const ACCEL_UUID = uuid("000a");
export const TELEMETRY_UUID = uuid("000b");

export const EEG_UUIDS = {
    TP9: uuid("0003"),
    AF7: uuid("0004"),
    AF8: uuid("0005"),
    TP10: uuid("0006"),
    AUX: uuid("0007")
} as const;

export const PPG_UUIDS = {
    ambient: uuid("000f"),
    infrared: uuid("0010"),
    red: uuid("0011")
} as const;

export type EegChannel = keyof typeof EEG_UUIDS;
export type PpgChannel = keyof typeof PPG_UUIDS;
export type Preset = "p21" | "p20" | "p50";

export const EEG_RATE_HZ = 256;
export const EEG_SAMPLES_PER_PACKET = 12;
export const IMU_RATE_HZ = 52;
export const IMU_SAMPLES_PER_PACKET = 3;
export const PPG_RATE_HZ = 64;
export const PPG_SAMPLES_PER_PACKET = 6;

const FOUR_CHANNELS: EegChannel[] = ["TP9", "AF7", "AF8", "TP10"];

/** EEG channels the headband streams under a preset. p20 adds the AUX electrode. */
export function channelsForPreset(preset: Preset): EegChannel[] {
    return preset === "p20" ? [...FOUR_CHANNELS, "AUX"] : [...FOUR_CHANNELS];
}

export function presetHasPpg(preset: Preset): boolean {
    return preset === "p50";
}

export function eegChannelForUuid(id: string): EegChannel | undefined {
    const lower = id.toLowerCase();
    return (Object.keys(EEG_UUIDS) as EegChannel[]).find(ch => EEG_UUIDS[ch] === lower);
}

export function ppgChannelForUuid(id: string): PpgChannel | undefined {
    const lower = id.toLowerCase();
    return (Object.keys(PPG_UUIDS) as PpgChannel[]).find(ch => PPG_UUIDS[ch] === lower);
}

/**
 * Frame a control command: [length of (ascii + newline), ...ascii, 0x0a].
 *
 * The return type is inferred deliberately. Writing it out as
 * `Uint8Array<ArrayBuffer>` needs TypeScript >= 5.7, where typed arrays became
 * generic over their buffer; a consumer on 5.6 fails with "Type 'Uint8Array' is
 * not generic". Inference gives each version the type its own lib defines, and
 * both satisfy the `BufferSource` that `writeValue` takes.
 */
export function encodeCommand(cmd: string) {
    const ascii = new TextEncoder().encode(cmd);
    const out = new Uint8Array(ascii.length + 2);
    out[0] = ascii.length + 1;
    out.set(ascii, 1);
    out[out.length - 1] = 0x0a;
    return out;
}

/** Control replies arrive as chunks [len, ...ascii]; returns the ascii text. */
export function decodeControlChunk(bytes: Uint8Array): string {
    const len = bytes[0] ?? 0;
    return new TextDecoder().decode(bytes.subarray(1, 1 + len));
}

/** Accumulates reply text until a closing brace, then yields parsed JSON objects. */
export class ControlAssembler {
    private buffer = "";

    push(chunk: string): Record<string, unknown>[] {
        this.buffer += chunk;
        const out: Record<string, unknown>[] = [];
        let end = this.buffer.indexOf("}");
        while (end >= 0) {
            const text = this.buffer.slice(0, end + 1);
            this.buffer = this.buffer.slice(end + 1);
            const start = text.indexOf("{");
            if (start >= 0) {
                try {
                    out.push(JSON.parse(text.slice(start)) as Record<string, unknown>);
                } catch {
                    // Malformed fragment from the headband; skip it rather than abort the stream.
                }
            }
            end = this.buffer.indexOf("}");
        }
        return out;
    }
}
