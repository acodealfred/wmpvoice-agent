import { useEffect, useState } from "react";
import { Video, VideoOff, Loader2, AlertTriangle } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";
import { useBiometrics } from "@/hooks/useBiometrics";
import { BiometricResult } from "@/types";
import { Button } from "@/components/ui/button";

interface VideoPanelProps {
  onEmotionDetected?: (emotion: EmotionResult) => void;
  onBiometricsDetected?: (biometrics: BiometricResult) => void;
  isRecording?: boolean;
  enableBiometrics?: boolean;
}

const ANALYSIS_DELAY_MS = 5000;

// Set to false to disable face biometrics analysis - can be overridden via enableBiometrics prop
const DEFAULT_BIOMETRICS_ENABLED = false;

const emotionIcons: Record<string, string> = {
  HAPPY: "😊",
  SAD: "😢",
  ANGRY: "😠",
  FEAR: "😨",
  SURPRISED: "😲",
  DISGUSTED: "🤢",
  NEUTRAL: "😐",
  MULTIPLE_FACES_DETECTED: "👥"
};

export function VideoPanel({ onEmotionDetected, onBiometricsDetected, isRecording = false, enableBiometrics = DEFAULT_BIOMETRICS_ENABLED }: VideoPanelProps) {
  const [analysisReady, setAnalysisReady] = useState(false);
  const [multipleFacesWarning, setMultipleFacesWarning] = useState(false);
  
  const {
    videoRef,
    canvasRef,
    isStreaming,
    currentEmotion,
    isAnalyzing,
    startVideo,
    stopVideo,
    startAnalysis,
    stopAnalysis
  } = useVideoCapture({ onEmotionDetected });

  const {
    isModelLoaded,
    currentBiometrics,
    isAnalyzing: isBiometricsAnalyzing,
    setVideoElement,
    startAnalysis: startBiometricsAnalysis,
    stopAnalysis: stopBiometricsAnalysis
  } = useBiometrics({ onBiometricsDetected });

  useEffect(() => {
    if (videoRef.current) {
      setVideoElement(videoRef.current);
    }
  }, [videoRef.current, setVideoElement]);

  useEffect(() => {
    if (isRecording && !isStreaming) {
      setAnalysisReady(false);
      setMultipleFacesWarning(false);
      startVideo().then(() => {
        setTimeout(() => {
          setAnalysisReady(true);
          startAnalysis();
          if (enableBiometrics) {
            startBiometricsAnalysis();
          }
        }, ANALYSIS_DELAY_MS);
      });
    } else if (!isRecording && isStreaming) {
      setAnalysisReady(false);
      stopAnalysis();
      stopBiometricsAnalysis();
      stopVideo();
    }
  }, [isRecording, isStreaming, startVideo, stopVideo, startAnalysis, stopAnalysis, startBiometricsAnalysis, stopBiometricsAnalysis, enableBiometrics]);

  useEffect(() => {
    if (currentEmotion) {
      setMultipleFacesWarning(currentEmotion.emotion === "multiple_faces_detected");
    }
  }, [currentEmotion]);

  const getEmotionEmoji = (emotion: string) => {
    return emotionIcons[emotion.toUpperCase()] || "😐";
  };

  const getHeadPoseLabel = (degrees: number): string => {
    if (degrees < -15) return "Turned Left";
    if (degrees > 15) return "Turned Right";
    if (degrees < -5) return "Slight Left";
    if (degrees > 5) return "Slight Right";
    return "Center";
  };

  const formatMetric = (value: number, decimals: number = 1): string => {
    return (value * 100).toFixed(decimals) + "%";
  };

  return (
    <div className="flex flex-col items-center rounded-lg bg-gray-900 p-4">
      <h2 className="mb-4 text-lg font-semibold text-white">Video & Biometrics Analysis</h2>
      
      <div className="relative mb-4 overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          className="h-60 w-80 object-cover"
          muted
          playsInline
        />
        <canvas ref={canvasRef} className="hidden" />
        
        {!isStreaming && (
          <div className="flex h-60 w-80 items-center justify-center bg-gray-800">
            <VideoOff className="h-12 w-12 text-gray-500" />
          </div>
        )}
      </div>

      <div className="mb-4 flex gap-2">
        {!isStreaming ? (
          <Button onClick={startVideo} size="sm" variant="secondary">
            <Video className="mr-2 h-4 w-4" />
            Start Video
          </Button>
        ) : (
          <Button onClick={stopVideo} size="sm" variant="destructive">
            <VideoOff className="mr-2 h-4 w-4" />
            Stop Video
          </Button>
        )}
      </div>

      {isStreaming && (
        <div className="w-full rounded-lg bg-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-300">Face & Biometrics</h3>
            {!isModelLoaded && (
              <span className="text-xs text-yellow-500">Loading model...</span>
            )}
          </div>
          
          {isStreaming && !analysisReady && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="mr-2 h-5 w-5 animate-spin text-yellow-500" />
              <span className="text-sm text-gray-400">Starting analysis in 5 seconds...</span>
            </div>
          )}
          
          {multipleFacesWarning && (
            <div className="mb-2 flex items-center justify-center rounded-lg bg-yellow-900/50 p-2">
              <AlertTriangle className="mr-2 h-4 w-4 text-yellow-500" />
              <span className="text-sm text-yellow-500">Only one face should be visible</span>
            </div>
          )}
          
          {analysisReady && isAnalyzing && !currentEmotion && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="mr-2 h-5 w-5 animate-spin text-purple-500" />
              <span className="text-sm text-gray-400">Analyzing face...</span>
            </div>
          )}
          
          {currentEmotion && (
            <div className="space-y-2">
              <div className="flex items-center justify-center">
                <span className="mr-2 text-4xl">{getEmotionEmoji(currentEmotion.emotion)}</span>
                <div>
                  <p className="text-lg font-bold text-white">
                    {currentEmotion.emotion.charAt(0) + currentEmotion.emotion.slice(1).toLowerCase()}
                  </p>
                  <p className="text-sm text-gray-400">
                    Confidence: {currentEmotion.confidence.toFixed(1)}%
                  </p>
                </div>
              </div>
              
              {currentEmotion.allEmotions && currentEmotion.allEmotions.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-xs text-gray-500">All Emotions:</p>
                  <div className="flex flex-wrap gap-1">
                    {currentEmotion.allEmotions
                      .sort((a, b) => b.confidence - a.confidence)
                      .slice(0, 5)
                      .map((emotion, idx) => (
                        <span
                          key={idx}
                          className="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300"
                        >
                          {emotion.type}: {emotion.confidence.toFixed(0)}%
                        </span>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
          
          {currentEmotion?.emotion === "No face detected" && (
            <p className="text-center text-sm text-yellow-500">No face detected</p>
          )}
          
          {currentBiometrics && currentBiometrics.faceDetected && (
            <div className="mt-4 pt-4 border-t border-gray-700">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium text-gray-300">Biometric Metrics</h4>
                {currentBiometrics.analysisDuration !== undefined && (
                  <span className="text-xs text-gray-500">
                    Running: {currentBiometrics.analysisDuration}s
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Head Pose</span>
                  <span className="text-white">
                    Pitch: {currentBiometrics.metrics.headPose.pitch.toFixed(1)}°
                  </span>
                  <span className="ml-2 text-gray-300">
                    ({getHeadPoseLabel(currentBiometrics.metrics.headPose.yaw)})
                  </span>
                </div>
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Blink Rate</span>
                  <span className="text-white">
                    {currentBiometrics.metrics.blinkRate.toFixed(1)} blinks/min
                  </span>
                </div>
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Blink Count</span>
                  <span className="text-white">
                    {currentBiometrics.metrics.blinkCount}
                  </span>
                </div>
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Eye Openness</span>
                  <span className="text-white">
                    {formatMetric(currentBiometrics.metrics.eyeOpenness)}
                  </span>
                </div>
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Mouth Openness</span>
                  <span className="text-white">
                    {formatMetric(currentBiometrics.metrics.mouthOpenness)}
                  </span>
                </div>
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Smile Intensity</span>
                  <span className="text-white">
                    {formatMetric(currentBiometrics.metrics.smileIntensity)}
                  </span>
                </div>
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Iris Position</span>
                  <span className="text-white">
                    X: {currentBiometrics.metrics.irisPosition.x.toFixed(2)}, 
                    Y: {currentBiometrics.metrics.irisPosition.y.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          )}
          
          {analysisReady && isBiometricsAnalyzing && !currentBiometrics && (
            <div className="mt-4 flex items-center justify-center py-2">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-500" />
              <span className="text-sm text-gray-400">Loading biometrics...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
