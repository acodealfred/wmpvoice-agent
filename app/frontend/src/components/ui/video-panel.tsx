import { useEffect } from "react";
import { VideoOff } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";
import { SurveyOption, SurveyQuestion } from "@/types";

interface VideoPanelProps {
    isRecording?: boolean;
    expanded?: boolean;
    onEmotionDetected?: (emotion: EmotionResult) => void;
    onVideoReady?: (video: HTMLVideoElement) => void;
    surveyQuestions?: SurveyQuestion[];
    surveyTotal?: number;
    surveyCompleted?: number;
    surveyOptions?: SurveyOption[];
}

export function VideoPanel({
    isRecording = false,
    expanded = false,
    onEmotionDetected,
    onVideoReady,
    surveyQuestions,
    surveyTotal,
    surveyCompleted,
    surveyOptions
}: VideoPanelProps) {
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

                {isStreaming && (
                    <div className="absolute bottom-2 left-0 right-0 rounded-lg bg-[#1a2520]/80 p-4 text-sm text-white backdrop-blur-md">
                        <div className="space-y-2">
                            <div className="font-medium">Survey Assessment</div>
                            {surveyTotal && surveyTotal > 0 && surveyQuestions && surveyQuestions.length > 0 ? (
                                <>
                                    <div className="text-xs text-slate-300">
                                        Progress: {surveyCompleted ?? 0}/{surveyTotal}
                                    </div>
                                    <div className="text-xs">{surveyQuestions[surveyQuestions.length - 1].text}</div>
                                    {surveyOptions && surveyOptions.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-2">
                                            {surveyOptions.map(opt => (
                                                <span key={opt.value} className="rounded bg-white/15 px-2 py-0.5 text-xs">
                                                    {opt.label}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    <div className="mt-2">
                                        <div className="h-1 w-full overflow-hidden rounded-full bg-[#2a3830]">
                                            <div
                                                className="h-full bg-purple-500 transition-all duration-300"
                                                style={{ width: `${((surveyCompleted ?? 0) / surveyTotal) * 100}%` }}
                                            ></div>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div className="text-xs text-slate-300">No active survey</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
