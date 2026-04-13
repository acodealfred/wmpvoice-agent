import { useEffect, useState, useRef } from "react";
import { Video, VideoOff, Loader2, AlertTriangle, Play, RotateCcw } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";
import { useBiometrics } from "@/hooks/useBiometrics";
import { BiometricResult, StressResult } from "@/types";
import { Button } from "@/components/ui/button";

interface VideoPanelProps {
  onEmotionDetected?: (emotion: EmotionResult) => void;
  onBiometricsDetected?: (biometrics: BiometricResult) => void;
  onStressStateChanged?: (state: string) => void;
  onStopAnalysis?: () => void;
  isRecording?: boolean;
  enableBiometrics?: boolean;
  baselineDuration?: number;
  onBaselineComplete?: () => void;
}

const ANALYSIS_DELAY_MS = 5000;

const DEFAULT_BIOMETRICS_ENABLED = false;
const DEFAULT_BASELINE_DURATION = 10;

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

export function VideoPanel({ 
  onEmotionDetected, 
  onBiometricsDetected, 
  onStressStateChanged,
  onStopAnalysis,
  isRecording = false, 
  enableBiometrics = DEFAULT_BIOMETRICS_ENABLED,
  baselineDuration = DEFAULT_BASELINE_DURATION,
  onBaselineComplete,
}: VideoPanelProps) {
  const [analysisReady, setAnalysisReady] = useState(false);
  const [multipleFacesWarning, setMultipleFacesWarning] = useState(false);
  const [showBaselinePrompt, setShowBaselinePrompt] = useState(false);
  const [stressResult, setStressResult] = useState<StressResult | null>(null);
  const stressIntervalRef = useRef<number | null>(null);
  
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
    stopAnalysis: stopBiometricsAnalysis,
    baselineSessionStatus,
    baselineData,
    baselineProgress,
    startBaselineSession,
    clearBaseline,
  } = useBiometrics({ 
    onBiometricsDetected,
    baselineDuration,
  });

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

  useEffect(() => {
    if (enableBiometrics && isStreaming && baselineSessionStatus === 'idle') {
      setShowBaselinePrompt(true);
    }
  }, [enableBiometrics, isStreaming, baselineSessionStatus]);

  useEffect(() => {
    if (baselineSessionStatus === 'completed') {
      setShowBaselinePrompt(false);
      onBaselineComplete?.();
    }
  }, [baselineSessionStatus, onBaselineComplete]);

  const handleStartBaselineSession = async () => {
    await startVideo();
    startBaselineSession();
    startBiometricsAnalysis();
  };

  const handleProceedWithoutBaseline = () => {
    setShowBaselinePrompt(false);
  };

  const handleRerecordBaseline = () => {
    clearBaseline();
    setShowBaselinePrompt(true);
  };

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

  useEffect(() => {
    if (!isRecording || !currentBiometrics?.faceDetected || !enableBiometrics) {
      if (stressIntervalRef.current) {
        clearInterval(stressIntervalRef.current);
        stressIntervalRef.current = null;
      }
      if (onStopAnalysis) {
        onStopAnalysis();
      }
      return;
    }

    const fetchStressAnalysis = async () => {
      if (!currentBiometrics?.metrics?.blinkRate) return;
      
      const blinkRate = currentBiometrics.metrics.blinkRate;
      const baselineBlinkRate = baselineData?.blinkRate;
      
      console.log('[Stress UI] ★★★ Sending stress request:', { blink_rate: blinkRate, baseline_blink_rate: baselineBlinkRate, baselineData });
      
      try {
        const response = await fetch("/analyze-stress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            blink_rate: blinkRate,
            baseline_blink_rate: baselineBlinkRate
          }),
        });
        const data = await response.json();
        console.log('[Stress UI] ★★★ Received response:', data);
        if (data.state) {
          setStressResult(data);
          const newState = data.state;
          const previousState = stressResult?.state;
          console.log('[Stress UI] State check - newState:', newState, 'previousState:', previousState);
          // Only log - no API call needed, stress state is just for UI display
        }
      } catch (error) {
        console.error("Stress analysis error:", error);
      }
    };

    fetchStressAnalysis();
    stressIntervalRef.current = window.setInterval(fetchStressAnalysis, 5000);

    return () => {
      if (stressIntervalRef.current) {
        clearInterval(stressIntervalRef.current);
        stressIntervalRef.current = null;
      }
    };
  }, [isRecording, currentBiometrics, enableBiometrics, stressResult, onStressStateChanged]);

  const getStressColor = (state: string) => {
    switch (state) {
      case "stressed": return "text-red-400";
      case "relaxed": return "text-green-400";
      default: return "text-yellow-400";
    }
  };

  const getStressBgColor = (state: string) => {
    switch (state) {
      case "stressed": return "bg-red-900/30 border-red-700";
      case "relaxed": return "bg-green-900/30 border-green-700";
      default: return "bg-yellow-900/30 border-yellow-700";
    }
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

      {showBaselinePrompt && (
        <div className="mb-4 w-full rounded-lg bg-blue-900/50 p-4 border border-blue-700">
          <h3 className="text-lg font-semibold text-white mb-2">Baseline Measurement Required</h3>
          <p className="text-sm text-gray-300 mb-4">
            To measure biometric changes during conversation, we need to record a baseline measurement first.
            Please look at the camera for {baselineDuration} seconds while we record your baseline pupil size and blink rate.
          </p>
          
          {baselineSessionStatus === 'collecting' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-center">
                <Loader2 className="mr-2 h-6 w-6 animate-spin text-blue-400" />
                <span className="text-blue-300">Recording baseline...</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div 
                  className="bg-blue-500 h-2 rounded-full transition-all duration-100"
                  style={{ width: `${baselineProgress}%` }}
                />
              </div>
              <p className="text-center text-sm text-gray-400">
                {Math.round(baselineProgress / 100 * baselineDuration)} / {baselineDuration} seconds
              </p>
            </div>
          ) : baselineSessionStatus === 'completed' && baselineData ? (
            <div className="space-y-3">
              <div className="p-3 bg-green-900/30 rounded-lg border border-green-700">
                <p className="text-green-300 font-medium">Baseline Recorded!</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-gray-400">Pupil Size:</span>
                    <span className="ml-2 text-white">{baselineData.pupilSize.toFixed(2)} mm</span>
                  </div>
                  <div>
                    <span className="text-gray-400">Blink Rate:</span>
                    <span className="ml-2 text-white">{baselineData.blinkRate.toFixed(1)} blinks/min</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleRerecordBaseline} size="sm" variant="outline" className="flex-1">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Rerecord
                </Button>
                <Button onClick={handleProceedWithoutBaseline} size="sm" className="flex-1">
                  Proceed
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button onClick={handleStartBaselineSession} size="sm" className="flex-1">
                <Play className="mr-2 h-4 w-4" />
                Start Baseline ({baselineDuration}s)
              </Button>
              <Button onClick={handleProceedWithoutBaseline} size="sm" variant="outline">
                Skip
              </Button>
            </div>
          )}
        </div>
      )}

      {isStreaming && (
        <div className="w-full rounded-lg bg-gray-800 p-4 space-y-4">
          {baselineSessionStatus === 'completed' && baselineData && (
            <div className="rounded-lg bg-blue-900/30 p-3 border border-blue-700">
              <h4 className="text-sm font-semibold text-blue-300 mb-2">Baseline Values</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Baseline Pupil Size:</span>
                  <span className="text-white font-medium">{baselineData.pupilSize.toFixed(2)} mm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Baseline Blink Rate:</span>
                  <span className="text-white font-medium">{baselineData.blinkRate.toFixed(1)} blinks/min</span>
                </div>
              </div>
            </div>
          )}
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
                  <span className="block text-xs text-green-400">
                    Baseline: {baselineData?.blinkRate.toFixed(1) || '--'} blinks/min
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
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Pupil Size</span>
                  <span className="text-white">
                    {currentBiometrics.metrics.pupilSizeMm.toFixed(2)} mm
                  </span>
                  <span className="block text-xs text-green-400">
                    Baseline: {baselineData?.pupilSize.toFixed(2) || '--'} mm
                  </span>
                </div>
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Pupil Change</span>
                  <span className={`text-white ${currentBiometrics.metrics.pupilSizeChangePercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {currentBiometrics.metrics.pupilSizeChangePercent >= 0 ? '+' : ''}
                    {currentBiometrics.metrics.pupilSizeChangePercent.toFixed(1)}%
                  </span>
                </div>
                <div className="rounded bg-gray-700 p-2">
                  <span className="block text-gray-400">Blink Rate Change</span>
                  <span className={`text-white ${currentBiometrics.metrics.blinkRateChangePercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {currentBiometrics.metrics.blinkRateChangePercent >= 0 ? '+' : ''}
                    {currentBiometrics.metrics.blinkRateChangePercent.toFixed(1)}%
                  </span>
                </div>
              </div>
              
              {stressResult && (
                <div className={`mt-4 rounded-lg border p-3 ${getStressBgColor(stressResult.state)}`}>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold text-gray-300">Blink Rate Stress</h4>
                    <span className={`text-xs font-medium ${getStressColor(stressResult.state)}`}>
                      {stressResult.state.toUpperCase()}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="text-center">
                      <span className="block text-gray-400">State</span>
                      <span className={`font-medium ${getStressColor(stressResult.state)}`}>
                        {stressResult.state}
                      </span>
                    </div>
                    <div className="text-center">
                      <span className="block text-gray-400">Rate Change</span>
                      <span className={`font-medium ${
                        (stressResult.blink_rate_change_percent || 0) >= 0 ? 'text-red-400' : 'text-green-400'
                      }`}>
                        {(stressResult.blink_rate_change_percent || 0) >= 0 ? '+' : ''}
                        {stressResult.blink_rate_change_percent?.toFixed(1) || '0.0'}%
                      </span>
                    </div>
                    <div className="text-center">
                      <span className="block text-gray-400">Confidence</span>
                      <span className="text-white">
                        {(stressResult.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="text-center">
                      <span className="block text-gray-400">Trend</span>
                      <span className={`font-medium ${
                        stressResult.trend === 'increasing' ? 'text-red-400' :
                        stressResult.trend === 'decreasing' ? 'text-green-400' : 'text-yellow-400'
                      }`}>
                        {stressResult.trend}
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
      )}
    </div>
  );
}
