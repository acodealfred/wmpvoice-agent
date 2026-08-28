import { useEffect } from "react";
import { VideoOff } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";

interface VideoPanelProps {
    isRecording?: boolean;
    expanded?: boolean;
    onEmotionDetected?: (emotion: EmotionResult) => void;
    onVideoReady?: (video: HTMLVideoElement) => void;
    /** Fires with the live MediaStream (or null once stopped) so a second, independent
     * <video> elsewhere — e.g. the Recovery Window's own camera panel — can mirror the
     * same feed without requesting a second getUserMedia capture. */
    onStreamReady?: (stream: MediaStream | null) => void;
}

export function VideoPanel({ isRecording = false, expanded = false, onEmotionDetected, onVideoReady, onStreamReady }: VideoPanelProps) {
    const { videoRef, canvasRef, isStreaming, stream, startVideo, stopVideo, startAnalysis, stopAnalysis } = useVideoCapture({ onEmotionDetected });

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

    useEffect(() => {
        onStreamReady?.(stream);
    }, [stream, onStreamReady]);

    return (
        <div className="flex flex-col">
            <div
                className={`relative mx-auto aspect-video w-full overflow-hidden rounded-lg bg-[color:var(--ciq-card)] transition-[max-width] duration-300 ${expanded ? "max-w-none" : "max-w-xl"}`}
            >
                <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
                <canvas ref={canvasRef} className="hidden" />

                {!isStreaming && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[color:var(--ciq-card-2)]">
                        <VideoOff className="h-12 w-12 text-[color:var(--ciq-text-muted)]" />
                    </div>
                )}
            </div>
        </div>
    );
}
