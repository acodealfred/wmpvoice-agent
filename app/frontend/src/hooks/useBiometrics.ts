import { useEffect, useRef, useState, useCallback } from "react";
import {
  FaceLandmarker,
  FilesetResolver,
  FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { BiometricResult, BiometricMetrics } from "@/types";

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

const calculateDistance = (
  p1: { x: number; y: number },
  p2: { x: number; y: number }
): number => {
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

const calculatePupilSize = (
  normalizedIrisSize: number,
  interocularDistance: number
): number => {
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
    console.log('[Biometrics] Baseline saved to storage:', data);
  } catch (error) {
    console.error('[Biometrics] Error saving baseline:', error);
  }
};

const loadBaselineFromFile = (): BaselineData | null => {
  try {
    const jsonStr = localStorage.getItem(BASELINE_FILE_KEY);
    if (jsonStr) {
      const data = JSON.parse(jsonStr) as BaselineData;
      console.log('[Biometrics] Baseline loaded from storage:', data);
      return data;
    }
  } catch (error) {
    console.error('[Biometrics] Error loading baseline:', error);
  }
  return null;
};

export function useBiometrics({
  onBiometricsDetected,
  analyzeInterval = 33,
  baselineDuration = DEFAULT_BASELINE_DURATION,
}: UseBiometricsProps = {}) {
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [currentBiometrics, setCurrentBiometrics] = useState<BiometricResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [baselineSessionStatus, setBaselineSessionStatus] = useState<'idle' | 'collecting' | 'completed'>('idle');
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

  const initializeModel = useCallback(async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );

      const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU",
        },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });

      faceLandmarkerRef.current = faceLandmarker;
      setIsModelLoaded(true);
    } catch (error) {
      console.error("Error initializing face landmarker:", error);
    }
  }, []);

  const startBaselineSession = useCallback(() => {
    if (baselineSessionStatus === 'collecting') return;
    
    clearBaseline();
    console.log('[Biometrics] Starting baseline session with duration:', baselineDuration, 'seconds');
    
    baselinePupilSizeSamplesRef.current = [];
    baselineBlinkRateSamplesRef.current = [];
    setBaselineProgress(0);
    setBaselineSessionStatus('collecting');
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
  }, [baselineDuration, baselineSessionStatus, isAnalyzing]);

  const completeBaselineSession = useCallback(() => {
    if (baselineTimerRef.current) {
      clearInterval(baselineTimerRef.current);
      baselineTimerRef.current = null;
    }
    
    const pupilSamples = baselinePupilSizeSamplesRef.current;
    const blinkSamples = baselineBlinkRateSamplesRef.current;
    
    const avgPupilSize = pupilSamples.length > 0 
      ? pupilSamples.reduce((a, b) => a + b, 0) / pupilSamples.length 
      : 0;
    
    const avgBlinkRate = blinkSamples.length > 0 
      ? blinkSamples.reduce((a, b) => a + b, 0) / blinkSamples.length 
      : 0;
    
    if (avgPupilSize > 0 && avgBlinkRate >= 0) {
      const newBaseline: BaselineData = {
        pupilSize: avgPupilSize,
        blinkRate: avgBlinkRate,
        timestamp: Date.now(),
      };
      
      baselineRateRef.current = avgBlinkRate;
      smoothedBlinkRateRef.current = avgBlinkRate;
      currentSmoothedBlinkRateRef.current = avgBlinkRate;
      setBaselineData(newBaseline);
      saveBaselineToFile(newBaseline);
    }
    
    setBaselineSessionStatus('completed');
    setBaselineProgress(100);
  }, []);

  const clearBaseline = useCallback(() => {
    try {
      localStorage.removeItem(BASELINE_FILE_KEY);
    } catch (error) {
      console.error('[Biometrics] Error clearing baseline:', error);
    }
    setBaselineData(null);
    setBaselineSessionStatus('idle');
    setBaselineProgress(0);
    baselinePupilSizeSamplesRef.current = [];
    baselineBlinkRateSamplesRef.current = [];
  }, []);

  const extractMetrics = useCallback(
    (result: FaceLandmarkerResult): BiometricMetrics | null => {
      const faceLandmarks = result.faceLandmarks?.[0] || [];
      if (faceLandmarks.length === 0) {
        return null;
      }

      let pitch = 0, roll = 0, yaw = 0;
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
      const shouldLog = logCounterRef.current % 60 === 0;
      
      if (shouldLog) {
        console.log('[Biometrics] EyeOpenness:', leftEAR.toFixed(3));
      }
      
      const isClosed = leftEAR < 0.1;
      
      if (shouldLog || leftEAR < 0.1) {
        console.log('[Biometrics] isClosed:', isClosed, '| isBlinkingRef:', isBlinkingRef.current, '| EyeOpenness:', leftEAR.toFixed(3));
      }
      
      if (isClosed && !isBlinkingRef.current) {
        isBlinkingRef.current = true;
        
        const lastBlink = blinkTimestampsRef.current.length > 0 
          ? currentTime - blinkTimestampsRef.current[blinkTimestampsRef.current.length - 1]
          : 0;
        
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

      if (baselineSessionStatus === 'collecting') {
        let interocularDistance = 0;
        if (faceLandmarks.length > 0) {
          const leftEyeLeft = faceLandmarks[362];
          const rightEyeRight = faceLandmarks[263];
          interocularDistance = calculateDistance(
            { x: leftEyeLeft.x, y: leftEyeLeft.y },
            { x: rightEyeRight.x, y: rightEyeRight.y }
          );
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
        const shape = blendshapes.find((b) => b.categoryName === name);
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
        interocularDistance = calculateDistance(
          { x: leftEyeLeft.x, y: leftEyeLeft.y },
          { x: rightEyeRight.x, y: rightEyeRight.y }
        );
      }

      const irisPosition = getIrisPosition(faceLandmarks);
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
        pupilSize: normalizedIrisSize,
        pupilSizeMm,
        pupilSizeChangePercent,
        blinkRateChangePercent,
        smoothedBlinkRate: blinkRate,
        baselineRateForChange,
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
        const elapsedSeconds = analysisStartTimeRef.current > 0 
          ? Math.floor((currentTime - analysisStartTimeRef.current) / 1000) 
          : 0;
        const biometricResult: BiometricResult = {
          metrics,
          timestamp: currentTime,
          faceDetected: true,
          analysisDuration: elapsedSeconds,
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
          pupilSize: 0,
          pupilSizeMm: 0,
          pupilSizeChangePercent: 0,
          blinkRateChangePercent: 0,
          smoothedBlinkRate: 0,
          baselineRateForChange: baselineRateRef.current,
        },
        timestamp: currentTime,
        faceDetected: false,
      });
    }
  }, [extractMetrics, onBiometricsDetected]);

  const startAnalysis = useCallback(() => {
    analysisStartTimeRef.current = Date.now();
    setIsAnalyzing(true);
  }, []);

  const stopAnalysis = useCallback(() => {
    setIsAnalyzing(false);
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
      setBaselineSessionStatus('completed');
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
  };
}
