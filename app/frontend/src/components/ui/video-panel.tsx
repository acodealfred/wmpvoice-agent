import { useEffect } from "react";
import { Video, VideoOff } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";
import { Button } from "@/components/ui/button";

interface VideoPanelProps {
  isRecording?: boolean;
  onEmotionDetected?: (emotion: EmotionResult) => void;
}

export function VideoPanel({ 
  isRecording = false, 
  onEmotionDetected,
}: VideoPanelProps) {
  const {
    videoRef,
    canvasRef,
    isStreaming,
    startVideo,
    stopVideo,
    startAnalysis,
    stopAnalysis,
  } = useVideoCapture({ onEmotionDetected });

  useEffect(() => {
    if (isRecording && !isStreaming) {
      startVideo().then(() => {
        setTimeout(() => {
          startAnalysis();
        }, 500);
      });
    } else if (!isRecording && isStreaming) {
      stopAnalysis();
      stopVideo();
    }
  }, [isRecording, isStreaming, startVideo, stopVideo, startAnalysis, stopAnalysis]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          muted
          playsInline
        />
        <canvas ref={canvasRef} className="hidden" />
        
        {!isStreaming && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
            <VideoOff className="h-12 w-12 text-gray-500" />
          </div>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        {!isStreaming ? (
          <Button onClick={startVideo} size="sm" variant="secondary" className="flex-1">
            <Video className="mr-2 h-4 w-4" />
            Start Camera
          </Button>
        ) : (
          <Button onClick={stopVideo} size="sm" variant="destructive" className="flex-1">
            <VideoOff className="mr-2 h-4 w-4" />
            Stop Camera
          </Button>
        )}
      </div>
    </div>
  );
}
