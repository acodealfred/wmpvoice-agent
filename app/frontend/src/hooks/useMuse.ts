import { useCallback, useEffect, useRef, useState } from "react";
import { WebBluetoothMuse, channelsForPreset, type BluetoothLike, type DeviceInfo, type EegChannel } from "@/muse";
import { Recorder } from "@/session/recorder";
import { RollingWindow } from "@/session/stability";
import { isWebBluetoothAvailable } from "@/support";
import { explainConnectError, explainStartError } from "@/ui/errors";

export type MuseStatus = "idle" | "connecting" | "streaming" | "paused" | "error" | "disconnected";

// 5 seconds of scrolling history at the headband's 256 Hz EEG rate.
const CHART_WINDOW_SAMPLES = 256 * 5;
// p50 is the preset with no bandwidth downside (see docs/muse-integration.md §4)
// and the only one that also carries PPG, so it's the sensible default even
// though this view only charts EEG today.
const PRESET = "p50" as const;

const nav = typeof navigator === "undefined" ? undefined : (navigator as unknown as { bluetooth?: BluetoothLike });

/**
 * Connects to a real Muse headband over Web Bluetooth and exposes its live EEG
 * as per-channel rolling buffers. Buffers are read imperatively via
 * `getChannelSamples` (not React state) so a 256 Hz stream doesn't force a
 * re-render on every packet — a consumer should read them from a
 * requestAnimationFrame loop.
 */
export function useMuse() {
    const [status, setStatus] = useState<MuseStatus>("idle");
    const [device, setDevice] = useState<DeviceInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hasRecording, setHasRecording] = useState(false);

    const sourceRef = useRef<WebBluetoothMuse | null>(null);
    const buffersRef = useRef<Map<EegChannel, RollingWindow>>(new Map());
    const unsubsRef = useRef<Array<() => void>>([]);
    const recorderRef = useRef<Recorder | null>(null);
    // While true, incoming packets are dropped instead of buffered/recorded — the
    // headband keeps streaming and the Bluetooth link stays up, only the session
    // capture is paused. Read inside listeners registered once at connect() time,
    // so it has to be a ref rather than a status check.
    const pausedRef = useRef(false);

    const available = isWebBluetoothAvailable(nav);

    const teardownListeners = useCallback(() => {
        unsubsRef.current.forEach(off => off());
        unsubsRef.current = [];
    }, []);

    const connect = useCallback(async () => {
        if (!available || !nav?.bluetooth) {
            setError("This browser doesn't support Web Bluetooth. Use Chrome, Edge, or Opera on desktop.");
            setStatus("error");
            return;
        }
        teardownListeners();
        setError(null);
        setStatus("connecting");

        const buffers = new Map<EegChannel, RollingWindow>();
        for (const ch of channelsForPreset(PRESET)) buffers.set(ch, new RollingWindow(CHART_WINDOW_SAMPLES));
        buffersRef.current = buffers;

        const source = new WebBluetoothMuse(nav.bluetooth);
        sourceRef.current = source;
        recorderRef.current = null;
        pausedRef.current = false;
        setHasRecording(false);
        unsubsRef.current.push(
            source.on("eeg", r => {
                if (pausedRef.current) return;
                buffersRef.current.get(r.ch)?.push(r.uV);
            })
        );
        unsubsRef.current.push(source.on("disconnected", () => setStatus("disconnected")));

        // Tracks whether the failure happened during the connect handshake or after
        // (during start()), so the error message matches what actually went wrong.
        let handshakeDone = false;
        try {
            const info = await source.connect({ preset: PRESET });
            handshakeDone = true;
            setDevice(info);

            const now = new Date().toISOString();
            const recorder = new Recorder({ device: info, preset: PRESET, consentAcceptedAt: now, recordedAt: now });
            for (const event of ["eeg", "imu", "ppg", "telemetry"] as const) {
                unsubsRef.current.push(
                    source.on(event, r => {
                        if (pausedRef.current) return;
                        recorder.push(r);
                    })
                );
            }
            recorderRef.current = recorder;
            setHasRecording(true);

            const t0 = await source.start();
            recorder.markStarted(t0.epochMs);
            setStatus("streaming");
        } catch (e) {
            setError(handshakeDone ? explainStartError(e) : explainConnectError(e));
            setStatus("error");
            teardownListeners();
            sourceRef.current = null;
        }
    }, [available, teardownListeners]);

    const disconnect = useCallback(async () => {
        teardownListeners();
        try {
            await sourceRef.current?.stop();
        } catch {
            // Best-effort — the connection may already be gone.
        }
        sourceRef.current = null;
        buffersRef.current = new Map();
        pausedRef.current = false;
        setDevice(null);
        setStatus("idle");
    }, [teardownListeners]);

    // Pauses/resumes capture without touching the Bluetooth link: the headband
    // keeps streaming, but paused packets are dropped instead of hitting the
    // chart buffers or the recorder, so a resumed session picks up where it
    // left off rather than starting a new one.
    const pause = useCallback(() => {
        if (!sourceRef.current) return;
        pausedRef.current = true;
        setStatus("paused");
    }, []);

    const resume = useCallback(() => {
        if (!sourceRef.current) return;
        pausedRef.current = false;
        setStatus("streaming");
    }, []);

    // Drop any live connection when whatever mounted this hook goes away.
    useEffect(
        () => () => {
            void disconnect();
        },
        [disconnect]
    );

    const getChannelSamples = useCallback((ch: EegChannel): Float32Array => {
        return buffersRef.current.get(ch)?.values() ?? new Float32Array(0);
    }, []);

    // Downloads everything recorded so far (EEG, IMU, PPG, telemetry) as a
    // muse-web-bridge/3 session file. Works mid-stream or after disconnect —
    // the recorder isn't cleared until the next connect().
    const save = useCallback(() => {
        const recorder = recorderRef.current;
        if (!recorder) return false;
        const file = recorder.finish();
        const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const name = (device?.name ?? "muse").replace(/[^a-z0-9-]+/gi, "-");
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}-${file.recorded_at.replace(/[:.]/g, "-")}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return true;
    }, [device]);

    return { status, device, error, available, hasRecording, connect, disconnect, pause, resume, save, getChannelSamples, channels: channelsForPreset(PRESET) };
}
