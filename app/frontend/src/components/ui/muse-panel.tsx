import { useRef, useState } from "react";
import { AlertTriangle, Bluetooth, BluetoothConnected, Download, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMuse } from "@/hooks/useMuse";
import { EegWaveform } from "@/components/ui/eeg-waveform";

// Full lane half-height caption shown below the chart — see EegWaveform for the SCALE_UV it charts against.
const SCALE_UV = 150;

/** Pairs a real Muse headband over Web Bluetooth and charts its live EEG. */
export function MusePanel() {
    const { status, device, error, available, hasRecording, connect, disconnect, pause, resume, save, getChannelSamples, channels } = useMuse();
    // The operator confirms consent before pairing, not when connect() resolves —
    // this is when accepted_at is stamped (docs/muse-wiring.md §2).
    const [consented, setConsented] = useState(false);
    const consentAcceptedAtRef = useRef<string | null>(null);

    const isBusy = status === "connecting";
    const isLive = status === "streaming";
    const isPaused = status === "paused";
    const isConnected = isLive || isPaused;

    const handleConsentChange = (checked: boolean) => {
        setConsented(checked);
        consentAcceptedAtRef.current = checked ? new Date().toISOString() : null;
    };

    return (
        <section className="ciq-glass-card">
            <div className="flex h-full flex-col">
                <div className="flex items-center justify-between border-b border-[color:var(--ciq-divider)] px-5 py-3">
                    <h2 className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">Muse EEG (live)</h2>
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--ciq-text-60)]">{status}</span>
                </div>
                <div className="space-y-4 p-4">
                    {!available && (
                        <div className="flex items-start gap-2 rounded-xl border border-[rgba(255,180,80,0.3)] bg-[rgba(255,180,80,0.08)] p-3 text-xs text-[color:var(--ciq-text-86)]">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ciq-accent-amber)]" />
                            Web Bluetooth isn&apos;t available in this browser. Use Chrome, Edge, or Opera on desktop.
                        </div>
                    )}

                    {error && (
                        <div className="flex items-start gap-2 rounded-xl border border-[rgba(255,50,50,0.25)] bg-[rgba(255,50,50,0.08)] p-3 text-xs text-[color:var(--ciq-text-86)]">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--ciq-accent-red)]" />
                            {error}
                        </div>
                    )}

                    {!isConnected && !isBusy && (
                        <label className="flex cursor-pointer items-start gap-2 text-xs text-[color:var(--ciq-text-86)]">
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={consented}
                                onChange={e => handleConsentChange(e.target.checked)}
                            />
                            I have the participant&apos;s consent to record this EEG session.
                        </label>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                        {isConnected || isBusy ? (
                            <Button onClick={() => disconnect()} variant="outline" disabled={isBusy}>
                                <BluetoothConnected className="mr-2 h-4 w-4" />
                                {isBusy ? "Connecting…" : "Disconnect"}
                            </Button>
                        ) : (
                            <Button onClick={() => connect(consentAcceptedAtRef.current!)} disabled={!available || !consented}>
                                <Bluetooth className="mr-2 h-4 w-4" />
                                Pair headband
                            </Button>
                        )}
                        {isConnected && (
                            <Button onClick={() => (isPaused ? resume() : pause())} variant="outline">
                                {isPaused ? (
                                    <>
                                        <Play className="mr-2 h-4 w-4" />
                                        Resume
                                    </>
                                ) : (
                                    <>
                                        <Pause className="mr-2 h-4 w-4" />
                                        Pause
                                    </>
                                )}
                            </Button>
                        )}
                        {isBusy && <Loader2 className="h-4 w-4 animate-spin text-[color:var(--ciq-text-60)]" />}
                        <Button onClick={() => save()} variant="outline" disabled={!hasRecording}>
                            <Download className="mr-2 h-4 w-4" />
                            Save session
                        </Button>
                        {device && (
                            <span className="text-xs text-[color:var(--ciq-text-60)]">
                                {device.name}
                                {device.firmware ? ` · fw ${device.firmware}` : ""}
                            </span>
                        )}
                    </div>

                    <EegWaveform active={isLive} channels={channels} getChannelSamples={getChannelSamples} />
                    <p className="text-[11px] text-[color:var(--ciq-text-46)]">
                        Last 5 seconds, ±{SCALE_UV} µV per channel, clipped beyond that range. Pairing requires a real
                        click and Chrome/Edge/Opera — Web Bluetooth won&apos;t work otherwise. The µV scale is not
                        settled (see docs/muse-integration.md) — treat these values as relative, not calibrated.
                    </p>
                </div>
            </div>
        </section>
    );
}
