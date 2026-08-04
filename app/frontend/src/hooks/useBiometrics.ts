import { useEffect, useRef, useState, useCallback } from "react";
import { FaceLandmarker, FilesetResolver, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { BiometricResult, BiometricMetrics } from "@/types";
import { gazeLabel } from "@/components/ui/gaze-indicator";

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
const BLINK_WINDOW_MS = 30000;
const BLINK_UPDATE_INTERVAL_MS = 5000;
const EMA_ALPHA = 0.3;

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

const computeGazeAxis = (irisCoord: number, cornerA: number, cornerB: number, sensitivity: number, flip = false): number => {
    const center = (cornerA + cornerB) / 2;
    const halfWidth = Math.abs(cornerB - cornerA) / 2;
    if (halfWidth === 0) return 0.5;
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

/** Horizontal gaze for one eye: raw iris x vs that eye's OWN slow-adapting baseline
 * (not corner-normalized — see the rationale comment above GAZE_V_SENSITIVITY). */
const computeHorizontalGaze = (irisRawX: number, baselineRef: { current: number | null }): number => {
    if (baselineRef.current === null) {
        baselineRef.current = irisRawX; // instant calibration on first frame
    }
    baselineRef.current = baselineRef.current * (1 - GAZE_BASELINE_ALPHA) + irisRawX * GAZE_BASELINE_ALPHA;
    return Math.max(0, Math.min(1, 0.5 + (irisRawX - baselineRef.current) * GAZE_H_AMPLIFICATION));
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

const calculateNormalizedEyeOpenness = (landmarks: { x: number; y: number }[]): number => {
    const leftUpper = landmarks[159];
    const leftLower = landmarks[145];
    const rightUpper = landmarks[386];
    const rightLower = landmarks[374];

    const leftOpen = Math.abs(leftUpper.y - leftLower.y);
    const rightOpen = Math.abs(rightUpper.y - rightLower.y);
    const avgOpen = (leftOpen + rightOpen) / 2;

    const eyeWidth = Math.abs(landmarks[33].x - landmarks[133].x);
    return avgOpen / eyeWidth;
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

export function useBiometrics({ onBiometricsDetected, analyzeInterval = 33, baselineDuration = DEFAULT_BASELINE_DURATION }: UseBiometricsProps = {}) {
    const [isModelLoaded, setIsModelLoaded] = useState(false);
    const [currentBiometrics, setCurrentBiometrics] = useState<BiometricResult | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [baselineSessionStatus, setBaselineSessionStatus] = useState<"idle" | "collecting" | "completed">("idle");
    const [baselineData, setBaselineData] = useState<BaselineData | null>(null);
    const [baselineProgress, setBaselineProgress] = useState(0);

    const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const lastFrameTimeRef = useRef<number>(0);
    const analysisStartTimeRef = useRef<number>(0);
    const blinkTimestampsRef = useRef<number[]>([]);
    const totalBlinkCountRef = useRef<number>(0);
    const isBlinkingRef = useRef<boolean>(false);
    const previousEARRef = useRef<number>(1);
    const intervalRef = useRef<number | null>(null);
    const logCounterRef = useRef<number>(0);
    const baselinePupilSizeSamplesRef = useRef<number[]>([]);
    const baselineBlinkRateSamplesRef = useRef<number[]>([]);
    const baselineStartTimeRef = useRef<number>(0);
    const baselineTimerRef = useRef<number | null>(null);
    const smoothedBlinkRateRef = useRef<number>(0);
    const baselineRateRef = useRef<number>(0);
    const lastBlinkRateUpdateRef = useRef<number>(0);
    const currentSmoothedBlinkRateRef = useRef<number>(0);
    // Adaptive gaze baselines: slow EMA of each eye's raw iris x position, tracked
    // independently per eye so one eye's drift/occlusion can't bias the other.
    // Initialised to null so the first detected position sets it instantly,
    // avoiding a cold-start bias toward 0.5.
    const leftGazeBaselineXRef = useRef<number | null>(null);
    const rightGazeBaselineXRef = useRef<number | null>(null);

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

    const startBaselineSession = useCallback(() => {
        // Always cancel any in-flight recording timer first so an explicit (re)start is
        // reliable — including recovering from a session that was stopped mid-recording,
        // which previously left the status stuck on "collecting" and made this a no-op.
        if (baselineTimerRef.current) {
            clearInterval(baselineTimerRef.current);
            baselineTimerRef.current = null;
        }

        clearBaseline();
        console.log("[Biometrics] Starting baseline session with duration:", baselineDuration, "seconds");

        baselinePupilSizeSamplesRef.current = [];
        baselineBlinkRateSamplesRef.current = [];
        setBaselineProgress(0);
        setBaselineSessionStatus("collecting");
        baselineStartTimeRef.current = Date.now();

        if (!isAnalyzing) {
            setIsAnalyzing(true);
        }

        const durationMs = baselineDuration * 1000;
        let elapsed = 0;

        baselineTimerRef.current = window.setInterval(() => {
            elapsed += 100;
            const progress = Math.min((elapsed / durationMs) * 100, 100);
            setBaselineProgress(progress);

            if (elapsed >= durationMs) {
                completeBaselineSession();
            }
        }, 100);
    }, [baselineDuration, isAnalyzing]);

    const completeBaselineSession = useCallback(() => {
        if (baselineTimerRef.current) {
            clearInterval(baselineTimerRef.current);
            baselineTimerRef.current = null;
        }

        const pupilSamples = baselinePupilSizeSamplesRef.current;
        const blinkSamples = baselineBlinkRateSamplesRef.current;

        const avgPupilSize = pupilSamples.length > 0 ? pupilSamples.reduce((a, b) => a + b, 0) / pupilSamples.length : 0;

        const avgBlinkRate = blinkSamples.length > 0 ? blinkSamples.reduce((a, b) => a + b, 0) / blinkSamples.length : 0;

        if (avgPupilSize > 0 && avgBlinkRate >= 0) {
            const newBaseline: BaselineData = {
                pupilSize: avgPupilSize,
                blinkRate: avgBlinkRate,
                timestamp: Date.now()
            };

            baselineRateRef.current = avgBlinkRate;
            smoothedBlinkRateRef.current = avgBlinkRate;
            currentSmoothedBlinkRateRef.current = avgBlinkRate;
            setBaselineData(newBaseline);
            saveBaselineToFile(newBaseline);
            console.log("[Biometrics] Baseline captured:", newBaseline, `(${pupilSamples.length} pupil samples)`);
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
        baselineBlinkRateSamplesRef.current = [];
    }, []);

    // Inject a baseline obtained elsewhere (e.g. fetched from the DB for a returning
    // user) so the 30s recording can be skipped. Mirrors completeBaselineSession's
    // ref wiring so downstream blink-change math uses it, and caches it locally.
    const setBaseline = useCallback((data: BaselineData) => {
        baselineRateRef.current = data.blinkRate;
        smoothedBlinkRateRef.current = data.blinkRate;
        currentSmoothedBlinkRateRef.current = data.blinkRate;
        setBaselineData(data);
        setBaselineSessionStatus("completed");
        setBaselineProgress(100);
        saveBaselineToFile(data);
    }, []);

    const extractMetrics = useCallback(
        (result: FaceLandmarkerResult): BiometricMetrics | null => {
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

            const leftEAR = calculateNormalizedEyeOpenness(faceLandmarks);
            const avgEyeOpenness = leftEAR;

            const currentTime = Date.now();

            logCounterRef.current++;
            const shouldLog = logCounterRef.current % 30 === 0;

            if (shouldLog) {
                console.log("[Biometrics] EyeOpenness:", leftEAR.toFixed(3));
            }

            const isClosed = leftEAR < 0.1;

            if (shouldLog || leftEAR < 0.1) {
                console.log("[Biometrics] isClosed:", isClosed, "| isBlinkingRef:", isBlinkingRef.current, "| EyeOpenness:", leftEAR.toFixed(3));
            }

            if (isClosed && !isBlinkingRef.current) {
                isBlinkingRef.current = true;

                const lastBlink = blinkTimestampsRef.current.length > 0 ? currentTime - blinkTimestampsRef.current[blinkTimestampsRef.current.length - 1] : 0;

                if (lastBlink === 0 || lastBlink > 250) {
                    blinkTimestampsRef.current.push(currentTime);
                    totalBlinkCountRef.current++;

                    while (blinkTimestampsRef.current.length > 0 && currentTime - blinkTimestampsRef.current[0] > BLINK_WINDOW_MS) {
                        blinkTimestampsRef.current.shift();
                    }
                }
            } else if (!isClosed && isBlinkingRef.current) {
                isBlinkingRef.current = false;
            }

            previousEARRef.current = leftEAR;

            const thirtySecondsAgo = currentTime - BLINK_WINDOW_MS;
            const blinksInWindow = blinkTimestampsRef.current.filter(t => t > thirtySecondsAgo).length;
            const rawBlinkRate = blinksInWindow * 2;

            if (currentTime - lastBlinkRateUpdateRef.current >= BLINK_UPDATE_INTERVAL_MS) {
                lastBlinkRateUpdateRef.current = currentTime;

                if (smoothedBlinkRateRef.current === 0) {
                    smoothedBlinkRateRef.current = rawBlinkRate;
                } else {
                    smoothedBlinkRateRef.current = EMA_ALPHA * rawBlinkRate + (1 - EMA_ALPHA) * smoothedBlinkRateRef.current;
                }
                currentSmoothedBlinkRateRef.current = smoothedBlinkRateRef.current;
            }

            const blinkRate = currentSmoothedBlinkRateRef.current;

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

                baselineBlinkRateSamplesRef.current.push(blinkRate);
            }

            const blendshapes = result.faceBlendshapes?.[0]?.categories || [];
            const getBlendshapeValue = (name: string): number => {
                const shape = blendshapes.find(b => b.categoryName === name);
                return shape?.score || 0;
            };

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
                false
            );
            const rightGazeY = computeGazeAxis(
                faceLandmarks[RIGHT_EYE_LANDMARKS.iris].y,
                faceLandmarks[RIGHT_EYE_LANDMARKS.upperLid].y,
                faceLandmarks[RIGHT_EYE_LANDMARKS.lowerLid].y,
                GAZE_V_SENSITIVITY,
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
            if (baselineRateForChange > 0 && blinkRate > 0) {
                blinkRateChangePercent = ((blinkRate - baselineRateForChange) / baselineRateForChange) * 100;
            }

            return {
                headPose: { pitch, roll, yaw },
                blinkRate: Math.min(blinkRate, 60),
                blinkCount: totalBlinkCountRef.current,
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

        const currentTime = performance.now();
        if (currentTime - lastFrameTimeRef.current < 33) return;
        lastFrameTimeRef.current = currentTime;

        const result = faceLandmarkerRef.current.detectForVideo(video, currentTime);

        if (result.faceLandmarks && result.faceLandmarks.length > 0) {
            const metrics = extractMetrics(result);

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
            setCurrentBiometrics({
                metrics: {
                    headPose: { pitch: 0, roll: 0, yaw: 0 },
                    blinkRate: 0,
                    blinkCount: totalBlinkCountRef.current,
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
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        if (baselineTimerRef.current) {
            clearInterval(baselineTimerRef.current);
            baselineTimerRef.current = null;
        }
        blinkTimestampsRef.current = [];
        isBlinkingRef.current = false;
        previousEARRef.current = 1;
        totalBlinkCountRef.current = 0;
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
        clearBaseline,
        setBaseline
    };
}
