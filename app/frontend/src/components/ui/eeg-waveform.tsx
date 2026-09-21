import { useEffect, useRef } from "react";
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

// Redraw at ~20fps rather than every animation frame (60fps) — still a large
// cut to the canvas work, but frequent enough that the trace visibly moves
// rather than reading as a slideshow of a mostly-unchanged 5-second window
// (dropping this much lower made real signal look falsely "steady"). Still
// scheduled via rAF (not setInterval) so it fully pauses in a backgrounded tab.
const REDRAW_INTERVAL_MS = 50;
// Cap how many points get drawn per lane, regardless of how many samples the
// rolling buffer holds. Decimates by taking every Nth sample rather than
// averaging — enough to track real waveform shape (EEG's fastest features are
// well under this rate) while still being far cheaper than plotting every one
// of a 1280-sample window.
const MAX_POINTS_PER_LANE = 480;

interface EegWaveformProps {
    /** Whether to run the redraw loop — pass `status === "streaming"` from useMuse. */
    active: boolean;
    channels: EegChannel[];
    getChannelSamples: (ch: EegChannel) => Float32Array;
    className?: string;
}

/**
 * Live scrolling EEG trace, one lane per channel. Shared by the admin bench
 * panel and the assessment-screen EEG control so both read the same
 * `useMuse().getChannelSamples` buffers without duplicating the canvas math.
 */
export function EegWaveform({ active, channels, getChannelSamples, className }: EegWaveformProps) {
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
    // 256 re-renders a second. Gated to REDRAW_INTERVAL_MS so a live signal
    // doesn't cost more than it needs to on a page that's also running camera
    // ML inference and real-time audio at the same time.
    useEffect(() => {
        if (!active) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        let raf = 0;
        let lastDrawAt = 0;

        const draw = (now: number) => {
            raf = requestAnimationFrame(draw);
            if (now - lastDrawAt < REDRAW_INTERVAL_MS) return;
            lastDrawAt = now;

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
                    const step = Math.max(1, Math.floor(samples.length / MAX_POINTS_PER_LANE));
                    ctx.strokeStyle = CHANNEL_COLOR[ch];
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    const denom = Math.max(1, samples.length - 1);
                    let started = false;
                    for (let s = 0; s < samples.length; s += step) {
                        const x = (s / denom) * width;
                        const v = Math.max(-SCALE_UV, Math.min(SCALE_UV, samples[s]));
                        const y = top + laneH / 2 - (v / SCALE_UV) * (laneH / 2 - 6);
                        if (!started) {
                            ctx.moveTo(x, y);
                            started = true;
                        } else {
                            ctx.lineTo(x, y);
                        }
                    }
                    ctx.stroke();
                }

                ctx.fillStyle = "rgba(255,255,255,0.65)";
                ctx.font = "11px ui-monospace, monospace";
                ctx.fillText(ch, 8, top + 16);
            });
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [active, channels, getChannelSamples]);

    return (
        <div ref={containerRef} className={className ?? "h-72 w-full overflow-hidden rounded-xl bg-black"}>
            <canvas ref={canvasRef} className="block h-full w-full" />
        </div>
    );
}
