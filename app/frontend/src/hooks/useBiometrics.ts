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
}

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

const calculatePupilSize = (landmarks: { x: number; y: number }[]): number => {
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
  
  const normalizedPupilSize = avgIrisDiameter / avgEyeWidth;
  
  return normalizedPupilSize;
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

export function useBiometrics({
  onBiometricsDetected,
  analyzeInterval = 33, // ~30 FPS for better blink detection
}: UseBiometricsProps = {}) {
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [currentBiometrics, setCurrentBiometrics] = useState<BiometricResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

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
  const baselinePupilSizeRef = useRef<number>(0);
  const baselineSetRef = useRef<boolean>(false);

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
        
        console.log('[Biometrics] Eye closed - checking debounce. lastBlink:', lastBlink);
        
        if (lastBlink === 0 || lastBlink > 250) {
          blinkTimestampsRef.current.push(currentTime);
          totalBlinkCountRef.current++;
          
          while (blinkTimestampsRef.current.length > 0 && currentTime - blinkTimestampsRef.current[0] > 60000) {
            blinkTimestampsRef.current.shift();
          }
          
          console.log('[Biometrics] BLINK RECORDED! EyeOpenness:', leftEAR.toFixed(3), '| TotalBlinks:', totalBlinkCountRef.current);
        } else {
          console.log('[Biometrics] Blink debounced (too soon):', lastBlink, 'ms');
        }
      } else if (!isClosed && isBlinkingRef.current) {
        isBlinkingRef.current = false;
      }
      
      previousEARRef.current = leftEAR;

      const oneMinuteAgo = currentTime - 60000;
      const recentBlinks = blinkTimestampsRef.current.filter(t => t > oneMinuteAgo).length;
      const blinkRate = recentBlinks;

      if (shouldLog) {
        console.log('[Biometrics] BlinkRate:', blinkRate, 'blinks/min | RecentBlinks:', recentBlinks, '| EyeOpenness:', leftEAR.toFixed(3));
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
      const pupilSize = calculatePupilSize(faceLandmarks);
      
      const AVERAGE_EYE_WIDTH_MM = 30;
      const pupilSizeMm = pupilSize * AVERAGE_EYE_WIDTH_MM;
      
      if (!baselineSetRef.current && pupilSize > 0) {
        baselinePupilSizeRef.current = pupilSize;
        baselineSetRef.current = true;
      }
      
      let pupilSizeChangePercent = 0;
      if (baselinePupilSizeRef.current > 0 && pupilSize > 0) {
        pupilSizeChangePercent = ((pupilSize - baselinePupilSizeRef.current) / baselinePupilSizeRef.current) * 100;
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
        pupilSize,
        pupilSizeMm,
        pupilSizeChangePercent,
      };
    },
    []
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
    blinkTimestampsRef.current = [];
    isBlinkingRef.current = false;
    previousEARRef.current = 1;
    totalBlinkCountRef.current = 0;
    analysisStartTimeRef.current = 0;
    logCounterRef.current = 0;
    baselinePupilSizeRef.current = 0;
    baselineSetRef.current = false;
  }, []);

  const setVideoElement = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
  }, []);

  useEffect(() => {
    initializeModel();

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
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
  };
}
