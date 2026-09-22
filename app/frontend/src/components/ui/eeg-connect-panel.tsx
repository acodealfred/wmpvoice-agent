import { useRef, useState } from "react";
import { Bluetooth, BluetoothConnected, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EegWaveform } from "@/components/ui/eeg-waveform";
import type { MuseStatus } from "@/hooks/useMuse";
import type { DeviceInfo, EegChannel } from "@/muse";

interface EegConnectPanelProps {
    status: MuseStatus;
    device: DeviceInfo | null;
    error: string | null;
    available: boolean;
    hasRecording: boolean;
    channels: EegChannel[];
    getChannelSamples: (ch: EegChannel) => Float32Array;
    onConnect: (consentAcceptedAt: string) => void;
    onDisconnect: () => void;
    onSave: () => void;
}

const STATUS_LABEL: Record<MuseStatus, string> = {
    idle: "NOT CONNECTED",
    connecting: "CONNECTING",
    streaming: "RECORDING",
    paused: "PAUSED",
    error: "ERROR",
    disconnected: "DISCONNECTED"
};

/**
 * Self-service pairing for the optional Muse EEG headband, shown on the main
 * assessment screen (not admin-gated, unlike the bench-calibration MusePanel).
 * Renders nothing when Web Bluetooth isn't available — this is an opportunistic
 * extra, not a required step, so there's no error state for unsupported browsers.
 *
 * Shows a throttled, decimated EegWaveform rather than MusePanel's full-rate
 * bench chart — redrawing at 60fps with every sample was competing for the
 * same main thread the camera's face-landmark detection and the voice
 * pipeline need during a real assessment, and caused visible lag/stutter.
 */
export function EegConnectPanel({
    status,
    device,
    error,
    available,
    hasRecording,
    channels,
    getChannelSamples,
    onConnect,
    onDisconnect,
    onSave
}: EegConnectPanelProps) {
    const [consented, setConsented] = useState(false);
    const consentAcceptedAtRef = useRef<string | null>(null);

    if (!available) return null;

    const isBusy = status === "connecting";
    const isLive = status === "streaming";
    const isConnected = isLive || status === "paused";

    const handleConsentChange = (checked: boolean) => {
        setConsented(checked);
        consentAcceptedAtRef.current = checked ? new Date().toISOString() : null;
    };

    return (
        <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3">
            <div className="mb-2 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[color:var(--ciq-text-60)]">EEG Headband (optional)</p>
                <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${
                        isConnected
                            ? "text-[color:var(--ciq-accent-green)]"
                            : status === "error"
                              ? "text-[color:var(--ciq-accent-red)]"
                              : "text-[color:var(--ciq-text-60)]"
                    }`}
                >
                    {STATUS_LABEL[status]}
                </span>
            </div>

            {error && <p className="mb-2 text-xs text-[color:var(--ciq-accent-red)]">{error}</p>}

            {isConnected || isBusy ? (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs text-[color:var(--ciq-text-68)]">
                            <span className="relative flex h-2 w-2 shrink-0">
                                {isLive && (
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--ciq-accent-green)] opacity-60" />
                                )}
                                <span
                                    className="relative inline-flex h-2 w-2 rounded-full"
                                    style={{ background: isLive ? "var(--ciq-accent-green)" : "var(--ciq-text-60)" }}
                                />
                            </span>
                            {device ? `Paired: ${device.name}` : "Connecting…"}
                        </span>
                        <div className="flex items-center gap-2">
                            <Button onClick={onSave} size="sm" variant="outline" disabled={!hasRecording} className="h-6 shrink-0 px-2 text-[10px]">
                                <Download className="mr-1 h-3 w-3" />
                                Save
                            </Button>
                            <Button onClick={onDisconnect} size="sm" variant="outline" disabled={isBusy} className="h-6 shrink-0 px-2 text-[10px]">
                                <BluetoothConnected className="mr-1 h-3 w-3" />
                                {isBusy ? "Connecting…" : "Disconnect"}
                            </Button>
                        </div>
                    </div>
                    {isConnected && (
                        <EegWaveform
                            active={isLive}
                            channels={channels}
                            getChannelSamples={getChannelSamples}
                            className="h-24 w-full overflow-hidden rounded-lg bg-black"
                        />
                    )}
                </div>
            ) : hasRecording ? (
                // The headband disconnected (assessment completed and auto-uploaded, or a
                // manual disconnect) but useMuse() doesn't clear the finished Recorder until
                // the next connect() — so `save()` still works here and downloads the same
                // file that was already uploaded, for anyone who wants a local copy too.
                <div className="space-y-2">
                    <p className="text-xs text-[color:var(--ciq-text-86)]">Recording complete and saved to your assessment.</p>
                    <div className="flex gap-2">
                        <Button onClick={onSave} size="sm" variant="outline" className="flex-1">
                            <Download className="mr-2 h-4 w-4" />
                            Download JSON
                        </Button>
                        <Button onClick={() => onConnect(new Date().toISOString())} size="sm" variant="outline" className="flex-1">
                            <Bluetooth className="mr-2 h-4 w-4" />
                            Pair again
                        </Button>
                    </div>
                </div>
            ) : (
                <div>
                    <label className="mb-2 flex cursor-pointer items-start gap-2 text-xs text-[color:var(--ciq-text-86)]">
                        <input type="checkbox" className="mt-0.5" checked={consented} onChange={e => handleConsentChange(e.target.checked)} />I consent to my
                        EEG being recorded during this assessment.
                    </label>
                    <Button onClick={() => onConnect(consentAcceptedAtRef.current!)} size="sm" disabled={!consented} className="w-full">
                        <Bluetooth className="mr-2 h-4 w-4" />
                        Pair headband
                    </Button>
                </div>
            )}
        </div>
    );
}
