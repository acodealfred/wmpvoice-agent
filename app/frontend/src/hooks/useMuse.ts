import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebBluetoothMuse, channelsForPreset, type BluetoothLike, type DeviceInfo, type EegChannel } from "@/muse";
import { Recorder, type SessionFile } from "@/session/recorder";
import type { Marker } from "@/session/protocol";
import { RollingWindow } from "@/session/stability";
import { downloadJson, sessionFilename } from "@/ui/download";
import { isWebBluetoothAvailable } from "@/support";
import { explainConnectError, explainStartError } from "@/ui/errors";

export type MuseStatus = "idle" | "connecting" | "streaming" | "paused" | "error" | "disconnected";

// 5 seconds of scrolling history at the headband's 256 Hz EEG rate.
const CHART_WINDOW_SAMPLES = 256 * 5;
// p50 is the only preset that streams PPG — on p21/p20 the session file has no
// pulse data at all, and there's no way to add it after the fact (docs/muse-wiring.md §1).
const PRESET = "p50" as const;

const nav = typeof navigator === "undefined" ? undefined : (navigator as unknown as { bluetooth?: BluetoothLike });

/**
 * Connects to a real Muse headband over Web Bluetooth, exposes its live EEG as
 * per-channel rolling buffers for charting, and records the full session (EEG,
 * IMU, PPG, telemetry) per docs/muse-wiring.md. Chart buffers are read
 * imperatively via `getChannelSamples` (not React state) so a 256 Hz stream
 * doesn't force a re-render on every packet — a consumer should read them
 * from a requestAnimationFrame loop.
 */
export function useMuse() {
    const [status, setStatus] = useState<MuseStatus>("idle");
    const [device, setDevice] = useState<DeviceInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hasRecording, setHasRecording] = useState(false);
    // True once markSurveyStarted has actually fired for the CURRENT recorder — i.e.
    // the assessment itself has begun, not just "the headband is paired". Exists so a
    // consumer (EegConnectPanel) can tell those two apart and only show the live
    // waveform once real assessment recording is underway, per docs/muse-wiring.md.
    const [surveyStarted, setSurveyStarted] = useState(false);

    const sourceRef = useRef<WebBluetoothMuse | null>(null);
    const buffersRef = useRef<Map<EegChannel, RollingWindow>>(new Map());
    const unsubsRef = useRef<Array<() => void>>([]);
    const recorderRef = useRef<Recorder | null>(null);
    const recordedAtRef = useRef<Date | null>(null);
    // The wall-clock instant streaming started, from source.start() itself —
    // reused as the anchor for any later recorder created by beginNewRecording,
    // since that anchor names when the packet clock zeroed, not when a
    // particular Recorder object was created (docs/muse-wiring.md §3).
    const t0EpochMsRef = useRef<number | null>(null);
    // Session time as the EEG packets carry it, so markers share a clock with
    // the samples (docs/muse-wiring.md §4) rather than wall time.
    const sessionTMsRef = useRef(0);
    // Per-question markers accumulated as the assessment progresses, rather
    // than recomputed from a state machine. `setMarkers` replaces the whole
    // list each time, so this ref holds the running total.
    const questionMarkersRef = useRef<Marker[]>([]);
    // Session time of the most recent record_survey_response resolution (or of
    // connect()/beginNewRecording() if no question has resolved yet) — the lower
    // bound for the NEXT marker. There's no separate "question asked" signal
    // from the backend: survey.update and survey.biometric.update both fire
    // together, after record_survey_response scores the question (see
    // markQuestionResolved below), so the only real boundary available is
    // "between two consecutive resolutions" — which is what a question's own
    // asking + answering actually happened during.
    const prevResolutionTMsRef = useRef(0);
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

    const resetSession = useCallback(() => {
        recorderRef.current = null;
        recordedAtRef.current = null;
        t0EpochMsRef.current = null;
        pausedRef.current = false;
        sessionTMsRef.current = 0;
        questionMarkersRef.current = [];
        prevResolutionTMsRef.current = 0;
        setHasRecording(false);
        setSurveyStarted(false);
    }, []);

    /** `consentAcceptedAt` is when the operator confirmed consent — take it before pairing, not here (docs/muse-wiring.md §2). */
    const connect = useCallback(
        async (consentAcceptedAt: string) => {
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
            resetSession();
            unsubsRef.current.push(source.on("disconnected", () => setStatus("disconnected")));

            // Tracks whether the failure happened during the connect handshake or after
            // (during start()), so the error message matches what actually went wrong.
            let handshakeDone = false;
            try {
                const info = await source.connect({ preset: PRESET });
                handshakeDone = true;
                setDevice(info);

                const recordedAt = new Date();
                recordedAtRef.current = recordedAt;
                const recorder = new Recorder({ device: info, preset: PRESET, consentAcceptedAt, recordedAt: recordedAt.toISOString() });
                recorderRef.current = recorder;
                setHasRecording(true);

                // Listeners read recorderRef.current rather than closing over `recorder`
                // directly, so beginNewRecording can redirect packets to a fresh Recorder
                // later without re-subscribing to the still-open Bluetooth link.
                unsubsRef.current.push(
                    source.on("eeg", r => {
                        buffersRef.current.get(r.ch)?.push(r.uV);
                        if (pausedRef.current) return;
                        sessionTMsRef.current = r.tMs;
                        recorderRef.current?.push(r);
                    })
                );
                for (const event of ["imu", "ppg", "telemetry"] as const) {
                    unsubsRef.current.push(
                        source.on(event, r => {
                            if (pausedRef.current) return;
                            recorderRef.current?.push(r);
                        })
                    );
                }

                // t0 comes from start() itself, never a separate Date.now(): only start()
                // knows the instant the packet clock was zeroed (docs/muse-wiring.md §3).
                const t0 = await source.start();
                t0EpochMsRef.current = t0.epochMs;
                recorder.markStarted(t0.epochMs);
                setStatus("streaming");
            } catch (e) {
                setError(handshakeDone ? explainStartError(e) : explainConnectError(e));
                setStatus("error");
                teardownListeners();
                sourceRef.current = null;
            }
        },
        [available, teardownListeners, resetSession]
    );

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
        questionMarkersRef.current = [];
        setDevice(null);
        setStatus("idle");
        setSurveyStarted(false);
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

    /**
     * Call once per question, when record_survey_response resolves it (the only
     * moment the backend tells the frontend about a question at all — there is
     * no earlier "question asked" event to anchor a start time on). Marks the
     * just-elapsed window — from the previous resolution to now — as `label`,
     * since that's the interval during which this question was actually asked
     * and answered.
     */
    const markQuestionResolved = useCallback((label: string) => {
        const recorder = recorderRef.current;
        if (!recorder) return;
        const start = prevResolutionTMsRef.current;
        const end = sessionTMsRef.current;
        if (end > start) {
            questionMarkersRef.current = [...questionMarkersRef.current, { label, t_ms_start: start, t_ms_end: end }];
            recorder.setMarkers(questionMarkersRef.current);
        }
        prevResolutionTMsRef.current = end;
    }, []);

    /**
     * Marks the session-clock instant the assessment itself began — distinct from
     * when the headband paired, since pairing can happen earlier during consent.
     * Safe to call on every Start/Resume press: idempotent on the Recorder itself
     * (Recorder.markSurveyStarted only keeps the first call), so only the actual
     * first press after a fresh connect() or beginNewRecording() takes effect.
     */
    const markSurveyStarted = useCallback(() => {
        if (!recorderRef.current) return;
        recorderRef.current.markSurveyStarted(sessionTMsRef.current);
        setSurveyStarted(true);
    }, []);

    /**
     * Starts a fresh recording (new Recorder, cleared markers) against the
     * already-connected headband, without dropping the Bluetooth link — for a
     * survey retake, so the participant isn't forced to re-pair.
     */
    const beginNewRecording = useCallback(
        (consentAcceptedAt: string) => {
            if (!sourceRef.current || !device) return false;
            questionMarkersRef.current = [];
            // Not reset to 0 — the Bluetooth link (and its seq/session clock) stays
            // live across a retake, so the new recording's first marker should start
            // from "now", not from the previous recording's session start.
            prevResolutionTMsRef.current = sessionTMsRef.current;
            const recordedAt = new Date();
            recordedAtRef.current = recordedAt;
            const recorder = new Recorder({ device, preset: PRESET, consentAcceptedAt, recordedAt: recordedAt.toISOString() });
            if (t0EpochMsRef.current !== null) recorder.markStarted(t0EpochMsRef.current);
            recorderRef.current = recorder;
            setHasRecording(true);
            // This new recorder hasn't had markSurveyStarted called on it yet — drops the
            // waveform back out until the retake's own Start actually fires, same as a
            // fresh connect().
            setSurveyStarted(false);
            return true;
        },
        [device]
    );

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

    // Downloads everything recorded so far (EEG, IMU, PPG, telemetry, markers)
    // as a muse-web-bridge/3 session file. Works mid-stream or after disconnect —
    // the recorder isn't cleared until the next connect().
    const save = useCallback(() => {
        const recorder = recorderRef.current;
        const recordedAt = recordedAtRef.current;
        if (!recorder || !recordedAt) return false;
        const file = recorder.finish();
        downloadJson(file, sessionFilename(recordedAt, device?.name ?? "muse"));
        return true;
    }, [device]);

    /** Same data as `save()`, but returned for the caller to upload instead of downloaded as a file. */
    const finishForUpload = useCallback((): SessionFile | null => {
        const recorder = recorderRef.current;
        if (!recorder) return null;
        return recorder.finish();
    }, []);

    // channelsForPreset returns a fresh array every call — memoized so a consumer
    // like EegWaveform, whose draw loop keys a useEffect off this array, doesn't
    // tear down and restart that loop on every unrelated re-render of whatever
    // mounted this hook (which, during a live assessment, is very often).
    const channels = useMemo(() => channelsForPreset(PRESET), []);

    return {
        status,
        device,
        error,
        available,
        hasRecording,
        surveyStarted,
        connect,
        disconnect,
        pause,
        resume,
        markQuestionResolved,
        markSurveyStarted,
        beginNewRecording,
        save,
        finishForUpload,
        getChannelSamples,
        channels
    };
}
