import { useEffect, useState } from "react";
import { Video, VideoOff, Loader2, AlertTriangle } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";
import { Button } from "@/components/ui/button";

interface VideoPanelProps {
  onEmotionDetected?: (emotion: EmotionResult) => void;
  isRecording?: boolean;
}

const ANALYSIS_DELAY_MS = 5000;

const emotionIcons: Record<string, string> = {
  HAPPY: "😊",
  SAD: "😢",
  ANGRY: "😠",
  FEAR: "😨",
  DISGUSTED: "🤢",
  SURPRISED: "😲",
  CALM: "😌",
  CONFUSED: "😕"
};

export function VideoPanel({ onEmotionDetected, isRecording = false }: VideoPanelProps) {
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

  useEffect(() => {
    if (isRecording && !isStreaming) {
      setAnalysisReady(false);
      setMultipleFacesWarning(false);
      startVideo().then(() => {
        setTimeout(() => {
          setAnalysisReady(true);
          startAnalysis();
        }, ANALYSIS_DELAY_MS);
      });
    } else if (!isRecording && isStreaming) {
      setAnalysisReady(false);
      stopAnalysis();
      stopVideo();
    }
  }, [isRecording, isStreaming, startVideo, stopVideo, startAnalysis, stopAnalysis]);

  useEffect(() => {
    if (currentEmotion) {
      setMultipleFacesWarning(currentEmotion.emotion === "multiple_faces_detected");
    }
  }, [currentEmotion]);

  const getEmotionEmoji = (emotion: string) => {
    return emotionIcons[emotion.toUpperCase()] || "😐";
  };

  return (
    <div className="flex flex-col items-center rounded-lg bg-gray-900 p-4">
      <h2 className="mb-4 text-lg font-semibold text-white">Video & Emotion Analysis</h2>
      
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
        <div className="w-full rounded-lg bg-gray-800 p-4">
          <h3 className="mb-2 text-sm font-medium text-gray-300">Emotion Analysis</h3>
          
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
              <span className="text-sm text-gray-400">Analyzing...</span>
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
        </div>
      )}
    </div>
  );
}
