// Accumulates readings into the "muse-web-bridge/3" session file.
import { EEG_RATE_HZ, IMU_RATE_HZ, PPG_RATE_HZ, PPG_UUIDS, channelsForPreset, presetHasPpg, type EegChannel, type PpgChannel, type Preset } from "../muse/protocol";
import { EEG_UV_PER_LSB, EEG_ZERO } from "../muse/decode";
import type { DeviceInfo, Reading } from "../muse/types";
import { DropCounter } from "./drops";
import type { Marker } from "./protocol";

export const SESSION_SCHEMA = "muse-web-bridge/3";

export interface EegPacketRecord {
    ch: EegChannel;
    seq: number;
    t_ms: number;
    v: number[];
}
export interface ImuPacketRecord {
    seq: number;
    t_ms: number;
    v: [number, number, number][];
}
export interface PpgPacketRecord {
    ch: PpgChannel;
    seq: number;
    t_ms: number;
    v: number[];
}

export interface SessionFile {
    schema: typeof SESSION_SCHEMA;
    /** When the page set the recording up — earlier than `t0_epoch_ms`, and a different instant. */
    recorded_at: string;
    /**
     * Wall clock at `t0`, in milliseconds since the epoch: what instant the packet
     * timeline starts from, read at the same moment as the page clock every `t_ms`
     * counts from. Absent when streaming never started — never 0.
     *
     * It exists so a recording can be lined up with one made elsewhere (an iPhone
     * writing its own ISO-8601 start, say) without going near `t_ms`. Timing stays
     * on `seq`; the anchor only says where the seq timeline begins:
     *
     *     epoch_ms = t0_epoch_ms + 1000 * seconds_from_seq
     *     EEG (seq * 12 + k) / 256   PPG (seq * 6 + k) / 64   IMU (seq * 3 + k) / 52
     *
     * Treat it as an offset to refine, not a reference. It is stamped on the host
     * when streaming is asked for, so it carries the host's BLE arrival jitter —
     * measured up to 47 ms here (docs/muse-2-findings.md) — plus whatever the
     * headband took to act on the command. Nothing corrects for that here.
     */
    t0_epoch_ms?: number;
    device: DeviceInfo;
    preset: Preset;
    consent: { accepted_at: string };
    eeg: {
        rate_hz: number;
        units: "uV";
        /**
         * The conversion these microvolts came from: uV = uv_per_lsb * (code - zero_code).
         * Stated rather than assumed, because the correct scale for a Muse 2 is
         * genuinely disputed — LibMuse, muse-js and published research each use a
         * different constant. See docs/muse-2-findings.md. Rescale with
         * `uv * (their_uv_per_lsb / uv_per_lsb)`.
         */
        uv_per_lsb: number;
        zero_code: number;
        channels: EegChannel[];
        packets: EegPacketRecord[];
        dropped_packets: Record<string, number>;
    };
    accelerometer: { rate_hz: number; units: "g"; packets: ImuPacketRecord[] };
    gyroscope: { rate_hz: number; units: "deg/s"; packets: ImuPacketRecord[] };
    ppg?: {
        rate_hz: number;
        units: "counts";
        channels: PpgChannel[];
        packets: PpgPacketRecord[];
        dropped_packets: Record<string, number>;
    };
    /**
     * Everything the telemetry characteristic carries, not just the battery.
     * `temperature` is the raw 16-bit field: the headband sends it, but its
     * units are unverified against any InterAxon documentation.
     */
    telemetry: { t_ms: number; battery_percent: number; fuel_gauge_mv: number; temperature: number }[];
    /** Present only when a guided bench protocol was run. */
    markers?: Marker[];
}

export interface RecorderOptions {
    device: DeviceInfo;
    preset: Preset;
    consentAcceptedAt: string;
    recordedAt: string;
}

const round = (x: number, places: number) => {
    const f = 10 ** places;
    return Math.round(x * f) / f;
};

export class Recorder {
    private eeg: EegPacketRecord[] = [];
    private accel: ImuPacketRecord[] = [];
    private gyro: ImuPacketRecord[] = [];
    private ppg: PpgPacketRecord[] = [];
    private telemetry: SessionFile["telemetry"] = [];
    private drops = new DropCounter();
    private ppgDrops = new DropCounter();
    private channels: EegChannel[];
    private markers: Marker[] | null = null;
    private t0EpochMs: number | null = null;

    constructor(private opts: RecorderOptions) {
        this.channels = channelsForPreset(opts.preset);
        for (const ch of this.channels) this.drops.register(ch);
        if (presetHasPpg(opts.preset)) {
            for (const ch of Object.keys(PPG_UUIDS) as PpgChannel[]) this.ppgDrops.register(ch);
        }
    }

    push(r: Reading): void {
        const t_ms = round(r.tMs, 1);
        switch (r.kind) {
            case "eeg":
                this.drops.observe(r.ch, r.seq);
                this.eeg.push({ ch: r.ch, seq: r.seq, t_ms, v: r.uV.map(x => round(x, 2)) });
                break;
            case "imu": {
                const rec: ImuPacketRecord = {
                    seq: r.seq,
                    t_ms,
                    v: r.samples.map(s => [round(s.x, 4), round(s.y, 4), round(s.z, 4)])
                };
                (r.sensor === "accelerometer" ? this.accel : this.gyro).push(rec);
                break;
            }
            case "ppg":
                this.ppgDrops.observe(r.ch, r.seq);
                this.ppg.push({ ch: r.ch, seq: r.seq, t_ms, v: r.counts });
                break;
            case "telemetry":
                this.telemetry.push({
                    t_ms,
                    battery_percent: round(r.batteryPercent, 0),
                    fuel_gauge_mv: round(r.fuelGaugeMv, 1),
                    temperature: r.temperature
                });
                break;
        }
    }

    /**
     * Anchor the packet timeline to the wall clock, from the instant `start()` took
     * as `t0`. Left unset if streaming never began, and the file then has no anchor.
     */
    markStarted(t0EpochMs: number): void {
        this.t0EpochMs = t0EpochMs;
    }

    /** Label the recording with the steps of a guided run; a later run replaces an earlier one. */
    setMarkers(markers: Marker[]): void {
        this.markers = [...markers];
    }

    packetCount(): number {
        return this.eeg.length + this.accel.length + this.gyro.length + this.ppg.length;
    }

    dropped(): Record<string, number> {
        return this.drops.dropped();
    }

    finish(): SessionFile {
        const file: SessionFile = {
            schema: SESSION_SCHEMA,
            recorded_at: this.opts.recordedAt,
            // Spread so an unstarted recording has no key at all, rather than a 0
            // that would read as 1 January 1970.
            ...(this.t0EpochMs !== null ? { t0_epoch_ms: this.t0EpochMs } : {}),
            device: this.opts.device,
            preset: this.opts.preset,
            consent: { accepted_at: this.opts.consentAcceptedAt },
            eeg: {
                rate_hz: EEG_RATE_HZ,
                units: "uV",
                uv_per_lsb: EEG_UV_PER_LSB,
                zero_code: EEG_ZERO,
                channels: this.channels,
                packets: this.eeg,
                dropped_packets: this.drops.dropped()
            },
            accelerometer: { rate_hz: IMU_RATE_HZ, units: "g", packets: this.accel },
            gyroscope: { rate_hz: IMU_RATE_HZ, units: "deg/s", packets: this.gyro },
            telemetry: this.telemetry
        };
        if (this.markers && this.markers.length > 0) file.markers = this.markers;
        if (presetHasPpg(this.opts.preset)) {
            file.ppg = {
                rate_hz: PPG_RATE_HZ,
                units: "counts",
                channels: Object.keys(PPG_UUIDS) as PpgChannel[],
                packets: this.ppg,
                dropped_packets: this.ppgDrops.dropped()
            };
        }
        return file;
    }
}
