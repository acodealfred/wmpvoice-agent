import { useEffect, useRef } from "react";

// ── Tunable constants ────────────────────────────────────────────────────────
const CONFIG = {
    // Audio reactivity
    sensitivity: 2.2, // multiplies normalized volume → mouth open amount
    ampSmoothing: 0.78, // 0..1 — higher = smoother/laggier mouth
    speakThreshold: 0.04, // amplitude above this counts as "speaking"
    voiceBandLo: 0.04, // fraction of the FFT bins used as the voice band (low)
    voiceBandHi: 0.6, // …and high
    tongueSpeed: 0.013, // rad/ms — tongue bob/articulation rate

    // Idle animations
    blinkMinMs: 2400,
    blinkMaxMs: 6200,
    blinkDurationMs: 150,
    breatheSpeed: 0.0016, // rad/ms — gentle scale pulse
    breatheAmount: 0.018,
    floatSpeed: 0.0011, // rad/ms — vertical bob
    floatAmount: 0.012, // fraction of height

    // Look
    glowBlur: 18,
    scanlineGap: 6 // px between digital scanlines
} as const;

interface CyberAvatarProps {
    /** App integration: returns the shared agent-output analyser (recreated per session). */
    getAnalyser?: () => AnalyserNode | null;
    /** Generic integration: the component creates and owns its own analyser for this stream. */
    audioStream?: MediaStream;
    className?: string;
}

type Palette = {
    primary: string; // face strokes / eyes — accent blue
    secondary: string; // hair / accents — accent purple
    glow: string; // bright fill
    bg1: string; // backdrop center
    bg2: string; // backdrop edge
    ink: string; // strong text/feature color
};

function readPalette(): Palette {
    const s = getComputedStyle(document.documentElement);
    const g = (n: string, fb: string) => s.getPropertyValue(n).trim() || fb;
    return {
        primary: g("--ciq-accent-blue", "#2563eb"),
        secondary: g("--ciq-accent-purple", "#6d28d9"),
        glow: g("--ciq-accent-blue", "#7cb0ff"),
        bg1: g("--ciq-card-2", "#182634"),
        bg2: g("--ciq-card", "#101c26"),
        ink: g("--ciq-text-strong", "#fffaf2")
    };
}

/** Average the voice band of the FFT and normalize to 0..1. */
function readAmplitude(analyser: AnalyserNode, data: Uint8Array): number {
    analyser.getByteFrequencyData(data);
    const len = data.length;
    const lo = Math.floor(len * CONFIG.voiceBandLo);
    const hi = Math.floor(len * CONFIG.voiceBandHi);
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += data[i];
    const n = Math.max(1, hi - lo);
    return sum / (n * 255);
}

export function CyberAvatar({ getAnalyser, audioStream, className = "" }: CyberAvatarProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    // Keep the latest getAnalyser in a ref so the animation effect doesn't restart
    // when the parent re-renders (the hook returns a fresh function each render).
    const getAnalyserRef = useRef(getAnalyser);
    getAnalyserRef.current = getAnalyser;

    useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = wrapRef.current;
        if (!canvas || !wrap) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let palette = readPalette();
        const themeObs = new MutationObserver(() => (palette = readPalette()));
        themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

        // Size the canvas to its container at device resolution.
        let cssW = 0;
        let cssH = 0;
        const resize = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            cssW = wrap.clientWidth;
            cssH = wrap.clientHeight;
            canvas.width = Math.max(1, Math.round(cssW * dpr));
            canvas.height = Math.max(1, Math.round(cssH * dpr));
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(wrap);

        // Optionally own an analyser built from a raw MediaStream (generic contract).
        let ownedCtx: AudioContext | null = null;
        let ownedAnalyser: AnalyserNode | null = null;
        if (audioStream) {
            ownedCtx = new AudioContext();
            ownedAnalyser = ownedCtx.createAnalyser();
            ownedAnalyser.fftSize = 256;
            ownedAnalyser.smoothingTimeConstant = 0.8;
            ownedCtx.createMediaStreamSource(audioStream).connect(ownedAnalyser);
        }

        const freq = new Uint8Array(128);
        let amp = 0; // smoothed amplitude 0..1
        let eyeOpen = 1; // 0 (shut) .. 1 (open)
        let nextBlinkAt = performance.now() + CONFIG.blinkMinMs;
        let blinkStart = 0;
        let raf = 0;

        const scheduleBlink = (now: number) => {
            nextBlinkAt = now + CONFIG.blinkMinMs + Math.random() * (CONFIG.blinkMaxMs - CONFIG.blinkMinMs);
        };

        const draw = (now: number) => {
            // ── Audio ──
            const analyser = ownedAnalyser ?? getAnalyserRef.current?.() ?? null;
            const raw = analyser ? readAmplitude(analyser, freq) : 0;
            amp = amp * CONFIG.ampSmoothing + raw * (1 - CONFIG.ampSmoothing);
            const speaking = amp > CONFIG.speakThreshold;
            const mouthOpen = Math.min(1, amp * CONFIG.sensitivity);

            // ── Blink ──
            if (blinkStart) {
                const k = (now - blinkStart) / CONFIG.blinkDurationMs;
                if (k >= 1) {
                    blinkStart = 0;
                    eyeOpen = 1;
                    scheduleBlink(now);
                } else {
                    // down then up
                    eyeOpen = Math.abs(k - 0.5) * 2;
                }
            } else {
                eyeOpen = 1;
                if (now >= nextBlinkAt) blinkStart = now;
            }

            // ── Layout ──
            const W = cssW;
            const H = cssH;
            ctx.clearRect(0, 0, W, H);

            // Backdrop glow
            const bg = ctx.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.5, Math.max(W, H) * 0.7);
            bg.addColorStop(0, palette.bg1);
            bg.addColorStop(1, palette.bg2);
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, W, H);

            const unit = Math.min(W, H) / 2;
            const breathe = 1 + Math.sin(now * CONFIG.breatheSpeed) * CONFIG.breatheAmount + (speaking ? mouthOpen * 0.02 : 0);
            const floatY = Math.sin(now * CONFIG.floatSpeed) * H * CONFIG.floatAmount;
            const cx = W / 2;
            const cy = H * 0.5 + floatY;
            const r = unit * 0.82 * breathe;

            const glowOn = 0.55 + amp * 0.45;

            ctx.save();
            ctx.translate(cx, cy);

            // ── Hair (female cue): rounded side panels + top fringe, behind the face ──
            ctx.save();
            ctx.shadowColor = palette.secondary;
            ctx.shadowBlur = CONFIG.glowBlur;
            ctx.fillStyle = withAlpha(palette.secondary, 0.9);
            // top fringe
            roundedRect(ctx, -r * 0.92, -r * 1.06, r * 1.84, r * 0.7, r * 0.5);
            ctx.fill();
            // side locks
            roundedRect(ctx, -r * 1.0, -r * 0.7, r * 0.34, r * 1.5, r * 0.18);
            ctx.fill();
            roundedRect(ctx, r * 0.66, -r * 0.7, r * 0.34, r * 1.5, r * 0.18);
            ctx.fill();
            ctx.restore();

            // ── Face plate ──
            ctx.save();
            ctx.shadowColor = palette.primary;
            ctx.shadowBlur = CONFIG.glowBlur;
            const faceGrad = ctx.createLinearGradient(0, -r, 0, r);
            faceGrad.addColorStop(0, withAlpha(palette.bg1, 1));
            faceGrad.addColorStop(1, withAlpha(palette.bg2, 1));
            ctx.fillStyle = faceGrad;
            ctx.strokeStyle = withAlpha(palette.primary, glowOn);
            ctx.lineWidth = Math.max(1.5, unit * 0.018);
            roundedRect(ctx, -r * 0.72, -r * 0.82, r * 1.44, r * 1.64, r * 0.42);
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            // Digital scanlines clipped to the face
            ctx.save();
            roundedRectPath(ctx, -r * 0.72, -r * 0.82, r * 1.44, r * 1.64, r * 0.42);
            ctx.clip();
            ctx.strokeStyle = withAlpha(palette.primary, 0.06 + amp * 0.08);
            ctx.lineWidth = 1;
            for (let y = -r; y < r; y += CONFIG.scanlineGap) {
                ctx.beginPath();
                ctx.moveTo(-r, y);
                ctx.lineTo(r, y);
                ctx.stroke();
            }
            ctx.restore();

            // ── Eyes ──
            const eyeY = -r * 0.12;
            const eyeDX = r * 0.34;
            const eyeRX = r * 0.2;
            const eyeRY = r * 0.24 * eyeOpen;
            drawEye(ctx, -eyeDX, eyeY, eyeRX, eyeRY, palette, glowOn);
            drawEye(ctx, eyeDX, eyeY, eyeRX, eyeRY, palette, glowOn);

            // Eyebrows / lashes (soft accent ticks above outer corners)
            ctx.save();
            ctx.strokeStyle = withAlpha(palette.secondary, 0.85);
            ctx.lineWidth = Math.max(1.5, unit * 0.02);
            ctx.lineCap = "round";
            brow(ctx, -eyeDX, eyeY - eyeRX * 1.5, eyeRX);
            brow(ctx, eyeDX, eyeY - eyeRX * 1.5, eyeRX, true);
            ctx.restore();

            // ── Cheeks (friendly) ──
            ctx.save();
            ctx.shadowColor = palette.secondary;
            ctx.shadowBlur = CONFIG.glowBlur * 0.6;
            ctx.fillStyle = withAlpha(palette.secondary, 0.35 + amp * 0.3);
            dot(ctx, -r * 0.42, r * 0.24, r * 0.08);
            dot(ctx, r * 0.42, r * 0.24, r * 0.08);
            ctx.restore();

            // ── Mouth ── Corners are anchored; the jaw (lower lip) drops far more than
            // the upper lip lifts, so the opening stays a wide oval and never balloons
            // into a circle. A dark cavity + teeth strip + tongue hint sell the speech.
            const mouthY = r * 0.42;
            const open = mouthOpen * mouthOpen * (3 - 2 * mouthOpen); // smoothstep easing
            const mw = r * 0.3 * (1 + 0.16 * open); // half-width, widens a touch when loud
            const openTop = r * 0.05 * open; // upper lip lifts a little
            const openBottom = r * (0.02 + 0.42 * open); // jaw drops a lot (height < width)
            const lipPath = () => {
                ctx.beginPath();
                ctx.moveTo(-mw, mouthY);
                ctx.quadraticCurveTo(0, mouthY - openTop - r * 0.015, mw, mouthY); // upper lip
                ctx.quadraticCurveTo(0, mouthY + openBottom, -mw, mouthY); // lower lip
                ctx.closePath();
            };
            ctx.save();
            ctx.shadowColor = palette.primary;
            ctx.shadowBlur = CONFIG.glowBlur * (0.7 + open);
            if (open < 0.05) {
                // relaxed closed smile
                ctx.strokeStyle = withAlpha(palette.primary, glowOn);
                ctx.lineWidth = Math.max(1.5, unit * 0.02);
                ctx.lineCap = "round";
                ctx.beginPath();
                ctx.moveTo(-mw, mouthY);
                ctx.quadraticCurveTo(0, mouthY + r * 0.13, mw, mouthY);
                ctx.stroke();
            } else {
                // dark inner cavity
                lipPath();
                ctx.fillStyle = withAlpha(palette.bg2, 0.94);
                ctx.fill();
                // teeth + tongue, clipped to the mouth opening
                ctx.save();
                lipPath();
                ctx.clip();
                const teethH = Math.min(openBottom * 0.55, r * 0.075);
                ctx.fillStyle = withAlpha(palette.ink, 0.82);
                roundedRect(ctx, -mw * 0.82, mouthY - openTop - teethH * 0.25, mw * 1.64, teethH, teethH * 0.45);
                ctx.fill();
                // Tongue — articulates while speaking: bobs up/down (time + audio),
                // sways slightly, and lifts toward the teeth like forming consonants.
                if (open > 0.16) {
                    const vis = Math.min(1, (open - 0.16) / 0.5);
                    const phase = now * CONFIG.tongueSpeed;
                    // lift: 0 = resting low in the mouth, 1 = raised toward the teeth
                    const lift = (0.5 + 0.5 * Math.sin(phase)) * (0.35 + 0.65 * Math.min(1, amp * 2));
                    const sway = Math.sin(phase * 0.6 + 1) * mw * 0.14 * vis;
                    const ty = mouthY + openBottom * (0.82 - 0.5 * lift);
                    const tw = mw * (0.52 + 0.1 * lift);
                    const th = Math.max(1, openBottom * (0.34 + 0.12 * lift) * vis);
                    ctx.save();
                    ctx.shadowColor = palette.secondary;
                    ctx.shadowBlur = CONFIG.glowBlur * 0.5 * vis;
                    ctx.fillStyle = withAlpha(palette.secondary, 0.4 + 0.25 * vis);
                    ctx.beginPath();
                    ctx.ellipse(sway, ty, tw, th, 0, 0, Math.PI * 2);
                    ctx.fill();
                    // center crease for a bit of dimension
                    ctx.strokeStyle = withAlpha(palette.bg2, 0.45 * vis);
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(sway, ty - th * 0.6);
                    ctx.lineTo(sway, ty + th * 0.55);
                    ctx.stroke();
                    ctx.restore();
                }
                ctx.restore();
                // glowing lip outline
                lipPath();
                ctx.strokeStyle = withAlpha(palette.primary, glowOn);
                ctx.lineWidth = Math.max(1.5, unit * 0.022);
                ctx.lineJoin = "round";
                ctx.stroke();
            }
            ctx.restore();

            ctx.restore(); // translate

            // ── Floating data pixels around the head ──
            ctx.save();
            ctx.fillStyle = withAlpha(palette.glow, 0.5 + amp * 0.4);
            for (let i = 0; i < 6; i++) {
                const a = now * 0.0004 + (i * Math.PI) / 3;
                const rad = r * (1.18 + 0.06 * Math.sin(now * 0.002 + i));
                const px = cx + Math.cos(a) * rad;
                const py = cy + Math.sin(a) * rad * 0.9;
                const sz = 2 + (i % 3);
                ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
            }
            ctx.restore();

            raf = requestAnimationFrame(draw);
        };

        raf = requestAnimationFrame(draw);

        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            themeObs.disconnect();
            // Only tear down an analyser we created ourselves — never the shared one.
            ownedAnalyser?.disconnect();
            ownedCtx?.close().catch(() => {});
        };
    }, [audioStream]);

    return (
        <div ref={wrapRef} className={`relative h-full w-full overflow-hidden rounded-lg ${className}`}>
            <canvas ref={canvasRef} className="h-full w-full" />
        </div>
    );
}

// ── Canvas helpers ───────────────────────────────────────────────────────────

function withAlpha(color: string, alpha: number): string {
    const c = color.trim();
    if (c.startsWith("#")) {
        let hex = c.slice(1);
        if (hex.length === 3)
            hex = hex
                .split("")
                .map(ch => ch + ch)
                .join("");
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    // rgb()/rgba() → wrap in rgba with our alpha
    const nums = c.match(/[\d.]+/g);
    if (nums && nums.length >= 3) return `rgba(${nums[0]}, ${nums[1]}, ${nums[2]}, ${alpha})`;
    return c;
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    roundedRectPath(ctx, x, y, w, h, r);
}

function drawEye(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, p: Palette, glow: number) {
    ctx.save();
    ctx.shadowColor = p.primary;
    ctx.shadowBlur = CONFIG.glowBlur * 0.8;
    // eye socket
    ctx.fillStyle = withAlpha(p.primary, 0.14);
    ctx.beginPath();
    ctx.ellipse(x, y, rx, Math.max(rx * 0.18, ry), 0, 0, Math.PI * 2);
    ctx.fill();
    if (ry > rx * 0.22) {
        // iris + pupil + highlight
        ctx.fillStyle = withAlpha(p.glow, glow);
        ctx.beginPath();
        ctx.ellipse(x, y, rx * 0.5, Math.min(ry, rx * 0.62), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = p.ink;
        dot(ctx, x + rx * 0.12, y - ry * 0.1, rx * 0.16);
    } else {
        // mostly closed → a bright lid line
        ctx.strokeStyle = withAlpha(p.primary, glow);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - rx, y);
        ctx.lineTo(x + rx, y);
        ctx.stroke();
    }
    ctx.restore();
}

function brow(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, flip = false) {
    const dir = flip ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x - rx * dir, y + rx * 0.2);
    ctx.quadraticCurveTo(x, y - rx * 0.3, x + rx * dir, y);
    ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
}
