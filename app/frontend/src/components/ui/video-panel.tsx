import { useEffect, forwardRef, useImperativeHandle } from "react";
import { VideoOff } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";

interface VideoPanelProps {
    isRecording?: boolean;
    onEmotionDetected?: (emotion: EmotionResult) => void;
}

export interface VideoPanelRef {
    isStreaming: boolean;
    startVideo: () => Promise<void>;
    stopVideo: () => void;
}

export const VideoPanel = forwardRef<VideoPanelRef, VideoPanelProps>(({ isRecording = false, onEmotionDetected }, ref) => {
    const { videoRef, canvasRef, isStreaming, startVideo, stopVideo, startAnalysis, stopAnalysis } = useVideoCapture({ onEmotionDetected });

    useImperativeHandle(ref, () => ({
        isStreaming,
        startVideo,
        stopVideo
    }));

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
                <video ref={videoRef} className="h-full w-full object-contain" muted playsInline />
                <canvas ref={canvasRef} className="hidden" />

                {!isStreaming && (
                    <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                        <VideoOff className="h-12 w-12 text-gray-500" />
                    </div>
                )}
            </div>
        </div>
    );
});
