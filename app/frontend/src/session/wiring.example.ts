// The wiring an app writes to record a session: the same steps the prototype page
// takes in main.ts, with nothing page-specific. docs/muse-wiring.md shows this file
// verbatim, and wiring.example.test.ts keeps the two identical.
import type { MuseSource } from "../muse";
import { Recorder, type SessionFile } from "./recorder";
import { BENCH_PROTOCOL, ProtocolRun, type ProtocolState } from "./protocol";
import { sessionFilename } from "../ui/download";

export interface MuseRecording {
    /** Begin the guided bench protocol from the current session time. */
    startGuidedRun(): void;
    /** The step to show on screen, or null before a guided run starts. */
    guidedState(): ProtocolState | null;
    /** The file to save, and its name. Recording carries on; call it as often as you like. */
    finish(): { file: SessionFile; filename: string };
    /** Stop streaming and release the headband. */
    stop(): Promise<void>;
}

/** `consentAcceptedAt` is when the person agreed: take it in your consent handler, before pairing. */
export async function startRecording(source: MuseSource, consentAcceptedAt: string): Promise<MuseRecording> {
    // p50 is the only preset that streams PPG. On p21 the file has no pulse data.
    const preset = "p50";
    const device = await source.connect({ preset });
    const recordedAt = new Date();
    const recorder = new Recorder({ device, preset, consentAcceptedAt, recordedAt: recordedAt.toISOString() });

    // Session time as the packets carry it, so markers share a clock with the samples.
    let sessionTMs = 0;
    let guided: ProtocolRun | null = null;

    const off = [
        source.on("eeg", r => {
            sessionTMs = r.tMs;
            recorder.push(r);
            // Without this line the file has no markers, even when the steps were run.
            if (guided) recorder.setMarkers(guided.marks(sessionTMs));
        }),
        source.on("imu", r => recorder.push(r)),
        source.on("ppg", r => recorder.push(r)),
        source.on("telemetry", r => recorder.push(r))
    ];

    try {
        // t0 comes from start() itself, never a separate Date.now(): only start()
        // knows the instant the packet clock was zeroed.
        const started = await source.start();
        recorder.markStarted(started.epochMs);
    } catch (e) {
        // Streaming never began. Release the headband so it can be paired again.
        for (const f of off) f();
        await source.stop().catch(() => undefined);
        throw e;
    }

    return {
        startGuidedRun: () => {
            guided = new ProtocolRun(BENCH_PROTOCOL, sessionTMs);
        },
        guidedState: () => (guided ? guided.at(sessionTMs) : null),
        finish: () => ({ file: recorder.finish(), filename: sessionFilename(recordedAt, device.name) }),
        stop: async () => {
            for (const f of off) f();
            await source.stop();
        }
    };
}
