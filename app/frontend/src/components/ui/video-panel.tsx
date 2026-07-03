import { useEffect } from "react";
import { VideoOff } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";

interface VideoPanelProps {
    isRecording?: boolean;
    expanded?: boolean;
    onEmotionDetected?: (emotion: EmotionResult) => void;
    onVideoReady?: (video: HTMLVideoElement) => void;
}

export function VideoPanel({ isRecording = false, expanded = false, onEmotionDetected, onVideoReady }: VideoPanelProps) {
    const { videoRef, canvasRef, isStreaming, startVideo, stopVideo, startAnalysis, stopAnalysis } = useVideoCapture({ onEmotionDetected });

    useEffect(() => {
        if (isRecording && !isStreaming) {
            startVideo().then(() => {
                if (videoRef.current) {
                    console.log("[VideoPanel] Camera ready, passing video element to biometrics hook");
                    onVideoReady?.(videoRef.current);
                }
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
        <div className="flex flex-col">
            <div
                className={`relative mx-auto aspect-video w-full overflow-hidden rounded-lg bg-[#0d1a14] transition-[max-width] duration-300 ${expanded ? "max-w-none" : "max-w-xl"}`}
            >
                <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                <canvas ref={canvasRef} className="hidden" />

                {!isStreaming && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#1a2520]">
                        <VideoOff className="h-12 w-12 text-slate-400" />
                    </div>
                )}
            </div>
        </div>
    );
}
