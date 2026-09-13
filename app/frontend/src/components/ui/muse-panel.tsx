import { useEffect, useRef } from "react";
import { AlertTriangle, Bluetooth, BluetoothConnected, Download, Loader2, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMuse } from "@/hooks/useMuse";
import type { EegChannel } from "@/muse";

const CHANNEL_COLOR: Record<EegChannel, string> = {
    TP9: "#38bdf8",
    AF7: "#a855f7",
    AF8: "#f59e0b",
    TP10: "#22c55e",
    AUX: "#f43f5e"
};

// Full lane half-height, in microvolts. Fixed rather than auto-scaled so the
// trace can't silently shrink to hide a wildly noisy or railed channel.
const SCALE_UV = 150;

/** Pairs a real Muse headband over Web Bluetooth and charts its live EEG. */
export function MusePanel() {
    const { status, device, error, available, hasRecording, connect, disconnect, pause, resume, save, getChannelSamples, channels } = useMuse();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Keep the canvas's backing resolution matched to its displayed size and DPR
    // so the waveform stays sharp instead of blurring on resize.
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;
        const resize = () => {
            const dpr = window.devicePixelRatio || 1;
            const rect = container.getBoundingClientRect();
            canvas.width = Math.max(1, Math.round(rect.width * dpr));
            canvas.height = Math.max(1, Math.round(rect.height * dpr));
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(container);
        return () => ro.disconnect();
    }, []);

    // Redraws off the animation-frame clock, reading straight from the hook's
    // rolling buffers — bypassing React state so a 256 Hz stream doesn't force
    // 256 re-renders a second.
    useEffect(() => {
        if (status !== "streaming") return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        let raf = 0;

        const draw = () => {
            const { width, height } = canvas;
            ctx.clearRect(0, 0, width, height);
            const laneH = height / channels.length;

            channels.forEach((ch, i) => {
                const top = i * laneH;

                ctx.strokeStyle = "rgba(255,255,255,0.12)";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, top + laneH / 2);
                ctx.lineTo(width, top + laneH / 2);
                ctx.stroke();

                const samples = getChannelSamples(ch);
                if (samples.length > 1) {
                    ctx.strokeStyle = CHANNEL_COLOR[ch];
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    const denom = Math.max(1, samples.length - 1);
                    for (let s = 0; s < samples.length; s++) {
                        const x = (s / denom) * width;
                        const v = Math.max(-SCALE_UV, Math.min(SCALE_UV, samples[s]));
                        const y = top + laneH / 2 - (v / SCALE_UV) * (laneH / 2 - 6);
                        if (s === 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                }

                ctx.fillStyle = "rgba(255,255,255,0.65)";
                ctx.font = "11px ui-monospace, monospace";
                ctx.fillText(ch, 8, top + 16);
            });

            raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [status, channels, getChannelSamples]);

    const isBusy = status === "connecting";
    const isLive = status === "streaming";
    const isPaused = status === "paused";
    const isConnected = isLive || isPaused;

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

                    <div className="flex flex-wrap items-center gap-3">
                        {isConnected || isBusy ? (
                            <Button onClick={() => disconnect()} variant="outline" disabled={isBusy}>
                                <BluetoothConnected className="mr-2 h-4 w-4" />
                                {isBusy ? "Connecting…" : "Disconnect"}
                            </Button>
                        ) : (
                            <Button onClick={() => connect()} disabled={!available}>
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

                    <div ref={containerRef} className="h-72 w-full overflow-hidden rounded-xl bg-black">
                        <canvas ref={canvasRef} className="block h-full w-full" />
                    </div>
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
