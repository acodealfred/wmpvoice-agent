// Blink detection + blink-rate math, kept free of React/MediaPipe so it can be unit-tested.
//
// Accuracy notes (why it looks like this):
//  - Openness is the standard 6-point Eye Aspect Ratio per eye, computed in PIXEL space
//    (MediaPipe landmarks are normalised separately on x and y, so a 16:9 frame would
//    otherwise distort vertical-vs-horizontal distances) — invariant to head roll and
//    camera distance.
//  - "Closed" is relative to this person's own open-eye EAR (eye shapes differ a lot), OR
//    MediaPipe's eyeBlink blendshape. Separate close/reopen levels (hysteresis) stop
//    jitter around one threshold from producing multiple blinks.
//  - A closure only counts as a blink if it lasts 40–500 ms. Longer = deliberate closure
//    or looking down, not a blink.
//  - Frames with no face / extreme head pose, and gaps from dropped frames, are excluded
//    from the time base instead of being counted as "no blinks".
//  - Rate = blinks / valid seconds (not "count in window × 2"), so it's correct before
//    the window has filled and while the face is intermittently lost.

export type Point = { x: number; y: number };

// Canonical MediaPipe FaceMesh 6-point EAR indices: [p1, p2, p3, p4, p5, p6] —
// p1/p4 are the eye corners, p2/p6 and p3/p5 the upper/lower lid pairs.
const RIGHT_EYE_EAR = [33, 160, 158, 133, 153, 144];
const LEFT_EYE_EAR = [362, 385, 387, 263, 373, 380];

const CLOSE_RATIO = 0.6; // closed when EAR < 60% of this person's open EAR
const REOPEN_RATIO = 0.8; // reopened when EAR > 80% of it
// eyeBlink blendshape: closed when it rises this far above the person's own resting
// score (some faces sit at 0.3–0.5 with eyes open), with an absolute floor.
const BLENDSHAPE_CLOSE_MIN = 0.5;
const BLENDSHAPE_CLOSE_RISE = 0.3;
const BLENDSHAPE_REOPEN_MIN = 0.35;
const BLENDSHAPE_REOPEN_RISE = 0.15;
const MIN_BLINK_MS = 40;
const MAX_BLINK_MS = 500;
const MIN_BLINK_GAP_MS = 150;
const STUCK_CLOSED_MS = 2_000;
// Longer gaps between processed frames mean frames were dropped (tab throttled, camera
// stall) — that time can't be vouched for, so it isn't counted.
const MAX_FRAME_GAP_MS = 250;
const MAX_ABS_YAW_DEG = 35;
const MAX_ABS_PITCH_DEG = 35;
const OPEN_LEVEL_ALPHA_WARMUP = 0.2;
const OPEN_LEVEL_ALPHA = 0.02;
const WARMUP_FRAMES = 30;

export const RATE_WINDOW_MS = 60_000;
export const MIN_VALID_MS_FOR_RATE = 15_000;

const dist = (a: Point, b: Point, w: number, h: number): number => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);

const eyeAspectRatio = (lm: Point[], idx: number[], w: number, h: number): number => {
    const [p1, p2, p3, p4, p5, p6] = idx.map(i => lm[i]);
    const width = dist(p1, p4, w, h);
    if (width === 0) return 0;
    return (dist(p2, p6, w, h) + dist(p3, p5, w, h)) / (2 * width);
};

/** Mean 6-point EAR of both eyes. `width`/`height` are the video frame's pixel size. */
export const computeEAR = (landmarks: Point[], width: number, height: number): number => {
    const w = width > 0 ? width : 1;
    const h = height > 0 ? height : 1;
    return (eyeAspectRatio(landmarks, LEFT_EYE_EAR, w, h) + eyeAspectRatio(landmarks, RIGHT_EYE_EAR, w, h)) / 2;
};

export const isPoseUsable = (pitchDeg: number, yawDeg: number): boolean => Math.abs(pitchDeg) <= MAX_ABS_PITCH_DEG && Math.abs(yawDeg) <= MAX_ABS_YAW_DEG;

export interface BlinkFrame {
    t: number; // ms, monotonic
    ear: number;
    blinkScore: number; // max(eyeBlinkLeft, eyeBlinkRight) blendshape, 0 if unavailable
    usable: boolean; // face found and head pose within range
}

export interface BlinkTotals {
    blinks: number;
    validMs: number;
}

export class BlinkDetector {
    private openLevel: number | null = null;
    private restBlinkScore = 0;
    private openFrames = 0;
    private closedSince: number | null = null;
    private lastT: number | null = null;
    private lastBlinkT = -Infinity;
    private totalBlinks = 0;
    private totalValidMs = 0;
    // Per-second buckets for the trailing-window rate: second -> [blinks, validMs].
    private buckets = new Map<number, [number, number]>();

    /** Feed one processed frame. Returns true when a blink was counted on this frame. */
    update(frame: BlinkFrame): boolean {
        const gap = this.lastT === null ? null : frame.t - this.lastT;
        this.lastT = frame.t;

        if (!frame.usable || gap === null || gap <= 0 || gap > MAX_FRAME_GAP_MS) {
            // Can't vouch for this stretch — abandon any in-progress closure too, since
            // its true duration is unknown.
            this.closedSince = null;
            if (frame.usable) this.trackOpenLevel(frame.ear, frame.blinkScore);
            return false;
        }

        this.addValidTime(frame.t, gap);

        const open = this.openLevel ?? frame.ear;
        const blinkClose = Math.max(BLENDSHAPE_CLOSE_MIN, this.restBlinkScore + BLENDSHAPE_CLOSE_RISE);
        const blinkReopen = Math.max(BLENDSHAPE_REOPEN_MIN, this.restBlinkScore + BLENDSHAPE_REOPEN_RISE);
        let counted = false;

        if (this.closedSince === null) {
            const closed = frame.ear < open * CLOSE_RATIO || frame.blinkScore > blinkClose;
            if (closed) {
                this.closedSince = frame.t;
            } else {
                this.trackOpenLevel(frame.ear, frame.blinkScore);
            }
        } else if (frame.t - this.closedSince > STUCK_CLOSED_MS) {
            // "Closed" for far longer than any blink: either the open level was learned
            // off an unusually wide-eyed moment or the user's resting openness changed
            // (posture, looking at a lower screen). Re-learn it rather than stay stuck.
            this.closedSince = null;
            this.openLevel = null;
            this.openFrames = 0;
            this.trackOpenLevel(frame.ear, frame.blinkScore);
        } else {
            const reopened = frame.ear > open * REOPEN_RATIO && frame.blinkScore < blinkReopen;
            if (reopened) {
                const duration = frame.t - this.closedSince;
                if (duration >= MIN_BLINK_MS && duration <= MAX_BLINK_MS && this.closedSince - this.lastBlinkT >= MIN_BLINK_GAP_MS) {
                    this.lastBlinkT = this.closedSince;
                    this.totalBlinks++;
                    this.bucket(this.closedSince)[0]++;
                    counted = true;
                }
                this.closedSince = null;
                this.trackOpenLevel(frame.ear, frame.blinkScore);
            }
        }
        return counted;
    }

    /** A frame with no face — its time is excluded from the rate. */
    markUnusable(t: number): void {
        this.update({ t, ear: 0, blinkScore: 0, usable: false });
    }

    /** Blinks per minute over the trailing window, or null if too little valid time. */
    rate(now: number): number | null {
        const fromSec = Math.floor((now - RATE_WINDOW_MS) / 1000);
        let blinks = 0;
        let validMs = 0;
        for (const [sec, [b, v]] of this.buckets) {
            if (sec < fromSec) {
                this.buckets.delete(sec);
                continue;
            }
            blinks += b;
            validMs += v;
        }
        if (validMs < MIN_VALID_MS_FOR_RATE) return null;
        return (blinks / validMs) * 60_000;
    }

    /** Cumulative totals since the last reset (used for baseline + per-question windows). */
    totals(): BlinkTotals {
        return { blinks: this.totalBlinks, validMs: this.totalValidMs };
    }

    reset(): void {
        this.openLevel = null;
        this.restBlinkScore = 0;
        this.openFrames = 0;
        this.closedSince = null;
        this.lastT = null;
        this.lastBlinkT = -Infinity;
        this.totalBlinks = 0;
        this.totalValidMs = 0;
        this.buckets.clear();
    }

    private trackOpenLevel(ear: number, blinkScore: number): void {
        if (ear <= 0) return;
        if (this.openLevel === null) {
            this.openLevel = ear;
            this.restBlinkScore = blinkScore;
        } else {
            const alpha = this.openFrames < WARMUP_FRAMES ? OPEN_LEVEL_ALPHA_WARMUP : OPEN_LEVEL_ALPHA;
            this.openLevel = this.openLevel * (1 - alpha) + ear * alpha;
            this.restBlinkScore = this.restBlinkScore * (1 - alpha) + blinkScore * alpha;
        }
        this.openFrames++;
    }

    private addValidTime(t: number, ms: number): void {
        this.totalValidMs += ms;
        this.bucket(t)[1] += ms;
    }

    private bucket(t: number): [number, number] {
        const sec = Math.floor(t / 1000);
        let b = this.buckets.get(sec);
        if (!b) {
            b = [0, 0];
            this.buckets.set(sec, b);
        }
        return b;
    }
}

/** Blinks per minute between two cumulative snapshots, or null if too little valid time. */
export const rateBetween = (from: BlinkTotals, to: BlinkTotals, minValidMs: number): number | null => {
    const validMs = to.validMs - from.validMs;
    if (validMs < minValidMs) return null;
    return ((to.blinks - from.blinks) / validMs) * 60_000;
};
