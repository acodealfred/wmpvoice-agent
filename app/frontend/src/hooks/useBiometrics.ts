import { useEffect, useRef, useState, useCallback } from "react";
import { FaceLandmarker, FilesetResolver, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { BiometricResult, BiometricMetrics } from "@/types";
import { gazeLabel } from "@/components/ui/gaze-indicator";
import { BlinkDetector, BlinkTotals, computeEAR, isPoseUsable, rateBetween } from "@/lib/blink";

interface UseBiometricsProps {
    onBiometricsDetected?: (biometrics: BiometricResult) => void;
    analyzeInterval?: number;
    baselineDuration?: number;
}

interface BaselineData {
    pupilSize: number;
    blinkRate: number;
    timestamp: number;
}

const BASELINE_FILE_KEY = "voicerag_biometric_baseline";
const DEFAULT_BASELINE_DURATION = 30;
// Baseline blink rate: skip the first seconds while the participant settles, and
// require enough face-visible time for the count to mean anything.
const BASELINE_BLINK_SETTLE_MS = 10_000;
const BASELINE_MIN_VALID_MS = 20_000;

const calculateDistance = (p1: { x: number; y: number }, p2: { x: number; y: number }): number => {
    return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

const getIrisPosition = (landmarks: { x: number; y: number }[]): { x: number; y: number } => {
    const leftIris = landmarks[468];
    const leftEyeLeft = landmarks[362];
    const leftEyeRight = landmarks[263];

    const eyeWidth = calculateDistance(leftEyeLeft, leftEyeRight);
    const irisOffset = (leftIris.x - leftEyeLeft.x) / eyeWidth;

    const upperEye = landmarks[386];
    const lowerEye = landmarks[374];
    const eyeHeight = calculateDistance(upperEye, lowerEye);
    const verticalOffset = (leftIris.y - lowerEye.y) / eyeHeight;

    return { x: irisOffset, y: -verticalOffset };
};

// The iris only moves ~10-20% of eye width in any direction, so raw normalized
// position is always near 0.5. Compute deviation from the geometric center of
// the eye and amplify to produce a visible 0–1 gaze signal.
// Binocular: BOTH eyes are tracked independently (see extractMetrics's leftGaze/
// rightGaze). MediaPipe's iris/eyelid landmark sets for the two eyes are mirror
// images of each other (inner/outer corner order flips left-vs-right), but that
// does NOT require a left/right sign flip for either gaze axis here:
//  - Horizontal is computed against each eye's OWN adaptive baseline (not the eye
//    corners), and the two eyeballs move conjugately (same angular direction) for
//    the vast majority of natural gaze — so raw iris x for both eyes shifts the
//    same image-space direction for the same real gaze move.
//  - Vertical uses each eye's own upper/lower eyelid landmarks, and "upper lid has
//    smaller y than lower lid" holds identically for both eyes (only the horizontal
//    axis mirrors between eyes, not the vertical one).
// The `flip` param below exists for exactly this kind of correction, in case a real
// session ever shows the two eyes disagreeing on direction.
const GAZE_V_SENSITIVITY = 6.0;
// How slowly each eye's "normal open" half-height reference adapts — fast enough
// to follow the participant settling into the camera over a few seconds, slow
// enough that a single blink (a handful of frames) can't drag it down.
const EYE_OPEN_BASELINE_ALPHA = 0.02;
// Below this fraction of an eye's own normal open half-height, treat the frame
// as "too closed to trust" rather than computing a ratio against it.
const EYE_NEAR_CLOSED_RATIO = 0.35;

/**
 * `openBaselineRef` tracks this eye's own typical (non-blinking) vertical
 * half-height, scale-invariant across face sizes/distances from the camera —
 * unlike a fixed threshold, which would need retuning per user. `halfWidth`
 * recomputes fresh every frame from whatever the eyelids are doing *right now*,
 * with no temporal smoothing; as an eye blinks or squints it shrinks toward
 * zero, and dividing by a near-zero denominator (amplified further by
 * `sensitivity`) turns ordinary landmark jitter into a saturated Up/Down
 * reading. Because the two eyes' eyelid landmarks are measured independently
 * frame-to-frame, this alone was enough to make them frequently disagree
 * during totally normal blinking — not a real gaze direction difference, just
 * noise amplified by a shrinking denominator on each eye separately. Holding
 * the neutral center while an eye is mostly closed removes that noise source.
 */
const computeGazeAxis = (
    irisCoord: number,
    cornerA: number,
    cornerB: number,
    sensitivity: number,
    openBaselineRef: { current: number | null },
    flip = false
): number => {
    const center = (cornerA + cornerB) / 2;
    const halfWidth = Math.abs(cornerB - cornerA) / 2;

    if (openBaselineRef.current === null) {
        openBaselineRef.current = halfWidth; // instant calibration on first frame
    } else if (halfWidth > openBaselineRef.current * 0.5) {
        // Only adapt on frames that look genuinely open, so blink frames (small
        // halfWidth) can't drag the "normal open" reference down toward zero.
        openBaselineRef.current = openBaselineRef.current * (1 - EYE_OPEN_BASELINE_ALPHA) + halfWidth * EYE_OPEN_BASELINE_ALPHA;
    }

    if (halfWidth === 0 || halfWidth < openBaselineRef.current * EYE_NEAR_CLOSED_RATIO) return 0.5;

    const deviation = ((irisCoord - center) / halfWidth) * sensitivity;
    const v = 0.5 + (flip ? -deviation : deviation) * 0.5;
    return Math.max(0, Math.min(1, v));
};

// Vertical gaze uses each eye's own upper/lower eyelid landmarks via computeGazeAxis.
// Horizontal gaze uses each eye's raw iris.x with its own adaptive baseline, computed
// inside extractMetrics via computeHorizontalGaze — see that function for details.

// MediaPipe iris/eyelid landmark indices — one set per eye (subject's own left/right,
// per MediaPipe's canonical face-mesh numbering, not the viewer's left/right).
const LEFT_EYE_LANDMARKS = { iris: 468, upperLid: 386, lowerLid: 374 };
const RIGHT_EYE_LANDMARKS = { iris: 473, upperLid: 159, lowerLid: 145 };

const GAZE_H_AMPLIFICATION = 35; // a 0.01 (1%) deviation from baseline -> ±0.35 output swing
const GAZE_BASELINE_ALPHA = 0.001; // α≈0.001 → ~30s to adapt 25%; stable for held gaze

/**
 * Horizontal gaze for one eye: raw iris x vs that eye's OWN slow-adapting baseline
 * (not corner-normalized — see the rationale comment above GAZE_V_SENSITIVITY).
 *
 * The sign is flipped from the raw MediaPipe coordinate on purpose. `irisRawX`
 * comes from the camera's actual (unmirrored) frame, where — exactly like an
 * ordinary photograph, not a mirror — the subject looking to their own right
 * moves the iris toward a SMALLER x. But `video-panel.tsx` displays that same
 * feed CSS-mirrored (`scale-x-[-1]`, the standard selfie view), and that's the
 * only view of themselves the participant ever sees. Without this flip, a real
 * rightward glance was reported (and rendered in GazeIndicator) as "Left" —
 * backwards from both the mirrored video on screen and how anyone would
 * describe their own gaze direction.
 */
const computeHorizontalGaze = (irisRawX: number, baselineRef: { current: number | null }): number => {
    if (baselineRef.current === null) {
        baselineRef.current = irisRawX; // instant calibration on first frame
    }
    baselineRef.current = baselineRef.current * (1 - GAZE_BASELINE_ALPHA) + irisRawX * GAZE_BASELINE_ALPHA;
    return Math.max(0, Math.min(1, 0.5 - (irisRawX - baselineRef.current) * GAZE_H_AMPLIFICATION));
};

const calculateIrisSize = (landmarks: { x: number; y: number }[]): number => {
    const leftIrisLeft = landmarks[469];
    const leftIrisRight = landmarks[471];
    const leftIrisTop = landmarks[470];
    const leftIrisBottom = landmarks[472];

    const rightIrisLeft = landmarks[474];
    const rightIrisRight = landmarks[476];
    const rightIrisTop = landmarks[475];
    const rightIrisBottom = landmarks[477];

    const leftEyeLeft = landmarks[362];
    const leftEyeRight = landmarks[263];
    const rightEyeLeft = landmarks[133];
    const rightEyeRight = landmarks[33];

    const leftEyeWidth = calculateDistance(leftEyeLeft, leftEyeRight);
    const rightEyeWidth = calculateDistance(rightEyeLeft, rightEyeRight);
    const avgEyeWidth = (leftEyeWidth + rightEyeWidth) / 2;

    const leftIrisHorizontal = calculateDistance(leftIrisLeft, leftIrisRight);
    const leftIrisVertical = calculateDistance(leftIrisTop, leftIrisBottom);
    const leftIrisDiameter = (leftIrisHorizontal + leftIrisVertical) / 2;

    const rightIrisHorizontal = calculateDistance(rightIrisLeft, rightIrisRight);
    const rightIrisVertical = calculateDistance(rightIrisTop, rightIrisBottom);
    const rightIrisDiameter = (rightIrisHorizontal + rightIrisVertical) / 2;

    const avgIrisDiameter = (leftIrisDiameter + rightIrisDiameter) / 2;

    const normalizedIrisSize = avgIrisDiameter / avgEyeWidth;

    return normalizedIrisSize;
};

const calculatePupilSize = (normalizedIrisSize: number, interocularDistance: number): number => {
    const AVG_PUPIL_TO_IRIS_RATIO = 0.35;
    const EYE_WIDTH_MM = 30;

    if (interocularDistance <= 0) {
        return 0;
    }

    const mmPerUnit = EYE_WIDTH_MM / (interocularDistance * 10);
    const irisDiameterMm = normalizedIrisSize * mmPerUnit;
    const pupilDiameterMm = irisDiameterMm * AVG_PUPIL_TO_IRIS_RATIO;

    return pupilDiameterMm;
};

const saveBaselineToFile = (data: BaselineData): void => {
    try {
        const jsonStr = JSON.stringify(data);
        localStorage.setItem(BASELINE_FILE_KEY, jsonStr);
        console.log("[Biometrics] Baseline saved to storage:", data);
    } catch (error) {
        console.error("[Biometrics] Error saving baseline:", error);
    }
};

const loadBaselineFromFile = (): BaselineData | null => {
    try {
        const jsonStr = localStorage.getItem(BASELINE_FILE_KEY);
        if (jsonStr) {
            const data = JSON.parse(jsonStr) as BaselineData;
            console.log("[Biometrics] Baseline loaded from storage:", data);
            return data;
        }
    } catch (error) {
        console.error("[Biometrics] Error loading baseline:", error);
    }
    return null;
};

export function useBiometrics({ onBiometricsDetected, analyzeInterval = 15, baselineDuration = DEFAULT_BASELINE_DURATION }: UseBiometricsProps = {}) {
    const [isModelLoaded, setIsModelLoaded] = useState(false);
    const [currentBiometrics, setCurrentBiometrics] = useState<BiometricResult | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [baselineSessionStatus, setBaselineSessionStatus] = useState<"idle" | "collecting" | "completed">("idle");
    const [baselineData, setBaselineData] = useState<BaselineData | null>(null);
    const [baselineProgress, setBaselineProgress] = useState(0);

    const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const lastFrameTimeRef = useRef<number>(0);
    const lastVideoTimeRef = useRef<number>(-1);
    const analysisStartTimeRef = useRef<number>(0);
    const blinkDetectorRef = useRef<BlinkDetector>(new BlinkDetector());
    const intervalRef = useRef<number | null>(null);
    const logCounterRef = useRef<number>(0);
    const baselinePupilSizeSamplesRef = useRef<number[]>([]);
    // Detector totals at the start of the eyes-open baseline, and again once the
    // settle period has passed — the baseline rate is counted between these and the end.
    const baselineBlinkStartRef = useRef<BlinkTotals | null>(null);
    const baselineBlinkSettledRef = useRef<BlinkTotals | null>(null);
    const baselineStartTimeRef = useRef<number>(0);
    const baselineTimerRef = useRef<number | null>(null);
    const baselineRateRef = useRef<number>(0);
    // Adaptive gaze baselines: slow EMA of each eye's raw iris x position, tracked
    // independently per eye so one eye's drift/occlusion can't bias the other.
    // Initialised to null so the first detected position sets it instantly,
    // avoiding a cold-start bias toward 0.5.
    const leftGazeBaselineXRef = useRef<number | null>(null);
    const rightGazeBaselineXRef = useRef<number | null>(null);
    // Per-eye "normal open" vertical half-height reference for computeGazeAxis —
    // see its doc comment for why this exists (blink-frame noise rejection).
    const leftGazeOpenYRef = useRef<number | null>(null);
    const rightGazeOpenYRef = useRef<number | null>(null);

    const initializeModel = useCallback(async () => {
        try {
            const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm");

            const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
                    delegate: "GPU"
                },
                outputFaceBlendshapes: true,
                outputFacialTransformationMatrixes: true,
                runningMode: "VIDEO",
                numFaces: 1
            });

            faceLandmarkerRef.current = faceLandmarker;
            setIsModelLoaded(true);
        } catch (error) {
            console.error("Error initializing face landmarker:", error);
        }
    }, []);

    // `durationSec` overrides the hook's default (the baseline protocol records camera
    // biometrics over the whole eyes-open phase rather than the default 30s).
    const startBaselineSession = useCallback(
        (durationSec?: number) => {
            // Always cancel any in-flight recording timer first so an explicit (re)start is
            // reliable — including recovering from a session that was stopped mid-recording,
            // which previously left the status stuck on "collecting" and made this a no-op.
            if (baselineTimerRef.current) {
                clearInterval(baselineTimerRef.current);
                baselineTimerRef.current = null;
            }

            clearBaseline();
            const seconds = durationSec ?? baselineDuration;
            console.log("[Biometrics] Starting baseline session with duration:", seconds, "seconds");

            baselinePupilSizeSamplesRef.current = [];
            baselineBlinkStartRef.current = blinkDetectorRef.current.totals();
            baselineBlinkSettledRef.current = null;
            setBaselineProgress(0);
            setBaselineSessionStatus("collecting");
            baselineStartTimeRef.current = Date.now();

            if (!isAnalyzing) {
                setIsAnalyzing(true);
            }

            const durationMs = seconds * 1000;
            let elapsed = 0;

            baselineTimerRef.current = window.setInterval(() => {
                elapsed += 100;
                const progress = Math.min((elapsed / durationMs) * 100, 100);
                setBaselineProgress(progress);

                if (elapsed >= durationMs) {
                    completeBaselineSession();
                }
            }, 100);
        },
        [baselineDuration, isAnalyzing]
    );

    // Returns the captured baseline (or null when there were no usable samples) so a
    // caller that ends the recording itself — the baseline protocol at the end of the
    // eyes-open phase — gets the result synchronously instead of via state.
    const completeBaselineSession = useCallback((): BaselineData | null => {
        if (baselineTimerRef.current) {
            clearInterval(baselineTimerRef.current);
            baselineTimerRef.current = null;
        }

        const pupilSamples = baselinePupilSizeSamplesRef.current;

        const avgPupilSize = pupilSamples.length > 0 ? pupilSamples.reduce((a, b) => a + b, 0) / pupilSamples.length : 0;

        // Blinks counted over the recording's face-visible time (after the settle period
        // when there's enough of it), rather than an average of a lagging live rate.
        const endTotals = blinkDetectorRef.current.totals();
        const startTotals = baselineBlinkStartRef.current;
        const settledTotals = baselineBlinkSettledRef.current;
        const avgBlinkRate =
            (settledTotals && rateBetween(settledTotals, endTotals, BASELINE_MIN_VALID_MS)) ??
            (startTotals && rateBetween(startTotals, endTotals, BASELINE_MIN_VALID_MS)) ??
            0;
        if (avgBlinkRate === 0) {
            console.warn("[Biometrics] Baseline blink rate unavailable — too little face-visible time or no blinks detected", { startTotals, endTotals });
        }

        if (avgPupilSize > 0 && avgBlinkRate >= 0) {
            const newBaseline: BaselineData = {
                pupilSize: avgPupilSize,
                blinkRate: avgBlinkRate,
                timestamp: Date.now()
            };

            baselineRateRef.current = avgBlinkRate;
            setBaselineData(newBaseline);
            saveBaselineToFile(newBaseline);
            console.log("[Biometrics] Baseline captured:", newBaseline, `(${pupilSamples.length} pupil samples)`);
            setBaselineSessionStatus("completed");
            setBaselineProgress(100);
            return newBaseline;
        } else {
            // No usable samples (e.g. face not detected / out of frame for the full 30s).
            // Leave baselineData null so the card falls back to a re-recordable state.
            console.warn(
                "[Biometrics] Baseline capture produced no usable data — face not detected? " +
                    `pupilSamples=${pupilSamples.length}, avgPupil=${avgPupilSize.toFixed(2)}, avgBlink=${avgBlinkRate.toFixed(2)}`
            );
        }

        setBaselineSessionStatus("completed");
        setBaselineProgress(100);
        return null;
    }, []);

    const clearBaseline = useCallback(() => {
        try {
            localStorage.removeItem(BASELINE_FILE_KEY);
        } catch (error) {
            console.error("[Biometrics] Error clearing baseline:", error);
        }
        setBaselineData(null);
        setBaselineSessionStatus("idle");
        setBaselineProgress(0);
        baselinePupilSizeSamplesRef.current = [];
        baselineBlinkStartRef.current = null;
        baselineBlinkSettledRef.current = null;
    }, []);

    // Inject a baseline obtained elsewhere (e.g. fetched from the DB for a returning
    // user) so the 30s recording can be skipped. Mirrors completeBaselineSession's
    // ref wiring so downstream blink-change math uses it, and caches it locally.
    const setBaseline = useCallback((data: BaselineData) => {
        baselineRateRef.current = data.blinkRate;
        setBaselineData(data);
        setBaselineSessionStatus("completed");
        setBaselineProgress(100);
        saveBaselineToFile(data);
    }, []);

    const extractMetrics = useCallback(
        (result: FaceLandmarkerResult, frameTime: number, frameWidth: number, frameHeight: number): BiometricMetrics | null => {
            const faceLandmarks = result.faceLandmarks?.[0] || [];
            if (faceLandmarks.length === 0) {
                return null;
            }

            let pitch = 0,
                roll = 0,
                yaw = 0;
            if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length > 0) {
                const matrix = result.facialTransformationMatrixes[0].data;
                pitch = Math.atan2(-matrix[6], matrix[10]) * (180 / Math.PI);
                roll = Math.atan2(matrix[4], matrix[0]) * (180 / Math.PI);
                yaw = Math.atan2(matrix[2], Math.sqrt(matrix[0] * matrix[0] + matrix[2] * matrix[2])) * (180 / Math.PI);
            }

            const blendshapes = result.faceBlendshapes?.[0]?.categories || [];
            const getBlendshapeValue = (name: string): number => {
                const shape = blendshapes.find(b => b.categoryName === name);
                return shape?.score || 0;
            };

            const ear = computeEAR(faceLandmarks, frameWidth, frameHeight);
            const avgEyeOpenness = ear;
            const blinkDetector = blinkDetectorRef.current;
            const blinked = blinkDetector.update({
                t: frameTime,
                ear,
                blinkScore: Math.max(getBlendshapeValue("eyeBlinkLeft"), getBlendshapeValue("eyeBlinkRight")),
                usable: isPoseUsable(pitch, yaw)
            });

            logCounterRef.current++;
            const shouldLog = logCounterRef.current % 30 === 0;
            if (blinked || shouldLog) {
                console.log("[Biometrics] EAR:", ear.toFixed(3), "| blink:", blinked, "| totals:", blinkDetector.totals());
            }

            // null until there's enough face-visible time in the window for a real rate.
            const liveBlinkRate = blinkDetector.rate(frameTime);
            const blinkRateReady = liveBlinkRate !== null;
            const blinkRate = liveBlinkRate ?? 0;

            if (baselineSessionStatus === "collecting" && !baselineBlinkSettledRef.current && Date.now() - baselineStartTimeRef.current >= BASELINE_BLINK_SETTLE_MS) {
                baselineBlinkSettledRef.current = blinkDetector.totals();
            }

            if (baselineSessionStatus === "collecting") {
                let interocularDistance = 0;
                if (faceLandmarks.length > 0) {
                    const leftEyeLeft = faceLandmarks[362];
                    const rightEyeRight = faceLandmarks[263];
                    interocularDistance = calculateDistance({ x: leftEyeLeft.x, y: leftEyeLeft.y }, { x: rightEyeRight.x, y: rightEyeRight.y });
                }

                const normalizedIrisSize = calculateIrisSize(faceLandmarks);
                const pupilSize = calculatePupilSize(normalizedIrisSize, interocularDistance);

                if (pupilSize > 0) {
                    baselinePupilSizeSamplesRef.current.push(pupilSize);
                }
            }

            const leftMouthOpen = getBlendshapeValue("mouthShrugUpper");
            const rightMouthOpen = getBlendshapeValue("mouthShrugLower");
            const mouthOpenness = (leftMouthOpen + rightMouthOpen) / 2;

            const smileLeft = getBlendshapeValue("mouthSmileLeft");
            const smileRight = getBlendshapeValue("mouthSmileRight");
            const smileIntensity = (smileLeft + smileRight) / 2;

            let interocularDistance = 0;
            if (faceLandmarks.length > 0) {
                const leftEyeLeft = faceLandmarks[362];
                const rightEyeRight = faceLandmarks[263];
                interocularDistance = calculateDistance({ x: leftEyeLeft.x, y: leftEyeLeft.y }, { x: rightEyeRight.x, y: rightEyeRight.y });
            }

            const irisPosition = getIrisPosition(faceLandmarks);

            // --- Binocular gaze: left and right eye computed independently ---
            // See the comment above GAZE_V_SENSITIVITY for why neither axis needs a
            // left/right sign flip between the two eyes.
            const leftIrisRawX = faceLandmarks[LEFT_EYE_LANDMARKS.iris].x;
            const rightIrisRawX = faceLandmarks[RIGHT_EYE_LANDMARKS.iris].x;
            const leftGazeX = computeHorizontalGaze(leftIrisRawX, leftGazeBaselineXRef);
            const rightGazeX = computeHorizontalGaze(rightIrisRawX, rightGazeBaselineXRef);

            const leftGazeY = computeGazeAxis(
                faceLandmarks[LEFT_EYE_LANDMARKS.iris].y,
                faceLandmarks[LEFT_EYE_LANDMARKS.upperLid].y,
                faceLandmarks[LEFT_EYE_LANDMARKS.lowerLid].y,
                GAZE_V_SENSITIVITY,
                leftGazeOpenYRef,
                false
            );
            const rightGazeY = computeGazeAxis(
                faceLandmarks[RIGHT_EYE_LANDMARKS.iris].y,
                faceLandmarks[RIGHT_EYE_LANDMARKS.upperLid].y,
                faceLandmarks[RIGHT_EYE_LANDMARKS.lowerLid].y,
                GAZE_V_SENSITIVITY,
                rightGazeOpenYRef,
                false
            );

            const leftGaze = { x: leftGazeX, y: leftGazeY, label: gazeLabel({ x: leftGazeX, y: leftGazeY }) };
            const rightGaze = { x: rightGazeX, y: rightGazeY, label: gazeLabel({ x: rightGazeX, y: rightGazeY }) };

            if (shouldLog) {
                console.log(
                    "[Gaze] L irisX:", leftIrisRawX.toFixed(4),
                    "baseline:", (leftGazeBaselineXRef.current ?? 0).toFixed(4),
                    "out:", leftGazeX.toFixed(3), leftGazeY.toFixed(3), leftGaze.label,
                    "| R irisX:", rightIrisRawX.toFixed(4),
                    "baseline:", (rightGazeBaselineXRef.current ?? 0).toFixed(4),
                    "out:", rightGazeX.toFixed(3), rightGazeY.toFixed(3), rightGaze.label
                );
            }
            const normalizedIrisSize = calculateIrisSize(faceLandmarks);
            const pupilSize = calculatePupilSize(normalizedIrisSize, interocularDistance);
            const pupilSizeMm = pupilSize;

            let pupilSizeChangePercent = 0;
            if (baselineData && baselineData.pupilSize > 0 && pupilSize > 0) {
                pupilSizeChangePercent = ((pupilSize - baselineData.pupilSize) / baselineData.pupilSize) * 100;
            }

            let blinkRateChangePercent = 0;
            const baselineRateForChange = baselineRateRef.current > 0 ? baselineRateRef.current : baselineData?.blinkRate || 0;
            if (baselineRateForChange > 0 && blinkRateReady) {
                blinkRateChangePercent = ((blinkRate - baselineRateForChange) / baselineRateForChange) * 100;
            }

            return {
                headPose: { pitch, roll, yaw },
                blinkRate,
                blinkRateReady,
                blinkCount: blinkDetector.totals().blinks,
                blinkValidMs: blinkDetector.totals().validMs,
                eyeOpenness: avgEyeOpenness,
                mouthOpenness,
                smileIntensity,
                faceWidth: interocularDistance * 3,
                faceHeight: interocularDistance * 4,
                interocularDistance,
                irisPosition,
                leftGaze,
                rightGaze,
                pupilSize: normalizedIrisSize,
                pupilSizeMm,
                pupilSizeChangePercent,
                blinkRateChangePercent,
                smoothedBlinkRate: blinkRate,
                baselineRateForChange
            };
        },
        [baselineData, baselineSessionStatus]
    );

    const analyzeFrame = useCallback(() => {
        if (!faceLandmarkerRef.current || !videoRef.current) return;

        const video = videoRef.current;
        if (video.readyState < 2) return;

        // Process every NEW camera frame exactly once. (A fixed 33 ms guard on top of a
        // 33 ms timer silently skipped ~every other frame on timer jitter, halving the
        // effective fps and missing short blinks.)
        if (video.currentTime === lastVideoTimeRef.current) return;
        lastVideoTimeRef.current = video.currentTime;

        let currentTime = performance.now();
        if (currentTime <= lastFrameTimeRef.current) currentTime = lastFrameTimeRef.current + 1; // detectForVideo needs increasing timestamps
        lastFrameTimeRef.current = currentTime;

        const result = faceLandmarkerRef.current.detectForVideo(video, currentTime);

        if (result.faceLandmarks && result.faceLandmarks.length > 0) {
            const metrics = extractMetrics(result, currentTime, video.videoWidth, video.videoHeight);

            if (metrics) {
                const elapsedSeconds = analysisStartTimeRef.current > 0 ? Math.floor((currentTime - analysisStartTimeRef.current) / 1000) : 0;
                const biometricResult: BiometricResult = {
                    metrics,
                    timestamp: currentTime,
                    faceDetected: true,
                    analysisDuration: elapsedSeconds
                };

                setCurrentBiometrics(biometricResult);
                onBiometricsDetected?.(biometricResult);
            }
        } else {
            // No face: this time is excluded from the blink-rate time base.
            blinkDetectorRef.current.markUnusable(currentTime);
            setCurrentBiometrics({
                metrics: {
                    headPose: { pitch: 0, roll: 0, yaw: 0 },
                    blinkRate: 0,
                    blinkRateReady: false,
                    blinkCount: blinkDetectorRef.current.totals().blinks,
                    blinkValidMs: blinkDetectorRef.current.totals().validMs,
                    eyeOpenness: 0,
                    mouthOpenness: 0,
                    smileIntensity: 0,
                    faceWidth: 0,
                    faceHeight: 0,
                    interocularDistance: 0,
                    irisPosition: { x: 0, y: 0 },
                    leftGaze: { x: 0.5, y: 0.5, label: "Center" },
                    rightGaze: { x: 0.5, y: 0.5, label: "Center" },
                    pupilSize: 0,
                    pupilSizeMm: 0,
                    pupilSizeChangePercent: 0,
                    blinkRateChangePercent: 0,
                    smoothedBlinkRate: 0,
                    baselineRateForChange: baselineRateRef.current
                },
                timestamp: currentTime,
                faceDetected: false
            });
        }
    }, [extractMetrics, onBiometricsDetected]);

    const startAnalysis = useCallback(() => {
        analysisStartTimeRef.current = Date.now();
        setIsAnalyzing(true);
    }, []);

    const stopAnalysis = useCallback(() => {
        setIsAnalyzing(false);
        leftGazeBaselineXRef.current = null; // reset so next session recalibrates
        rightGazeBaselineXRef.current = null;
        leftGazeOpenYRef.current = null;
        rightGazeOpenYRef.current = null;
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        if (baselineTimerRef.current) {
            clearInterval(baselineTimerRef.current);
            baselineTimerRef.current = null;
        }
        blinkDetectorRef.current.reset();
        lastVideoTimeRef.current = -1;
        analysisStartTimeRef.current = 0;
        logCounterRef.current = 0;
    }, []);

    const setVideoElement = useCallback((video: HTMLVideoElement | null) => {
        videoRef.current = video;
    }, []);

    useEffect(() => {
        initializeModel();

        const savedBaseline = loadBaselineFromFile();
        if (savedBaseline) {
            setBaselineData(savedBaseline);
            setBaselineSessionStatus("completed");
        }

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
            if (baselineTimerRef.current) {
                clearInterval(baselineTimerRef.current);
            }
            if (faceLandmarkerRef.current) {
                faceLandmarkerRef.current.close();
            }
        };
    }, [initializeModel]);

    useEffect(() => {
        if (isAnalyzing && isModelLoaded) {
            intervalRef.current = window.setInterval(analyzeFrame, analyzeInterval);
        }

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, [isAnalyzing, isModelLoaded, analyzeFrame, analyzeInterval]);

    return {
        isModelLoaded,
        currentBiometrics,
        isAnalyzing,
        setVideoElement,
        startAnalysis,
        stopAnalysis,
        baselineSessionStatus,
        baselineData,
        baselineProgress,
        startBaselineSession,
        completeBaselineSession,
        clearBaseline,
        setBaseline
    };
}
