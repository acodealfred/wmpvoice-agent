import { useEffect } from "react";
import { Video, VideoOff } from "lucide-react";
import { useVideoCapture, EmotionResult } from "@/hooks/useVideoCapture";
import { Button } from "@/components/ui/button";
import { SurveyOption, SurveyQuestion } from "@/types";

interface VideoPanelProps {
    isRecording?: boolean;
    onEmotionDetected?: (emotion: EmotionResult) => void;
    surveyQuestions?: SurveyQuestion[];
    surveyTotal?: number;
    surveyCompleted?: number;
    surveyOptions?: SurveyOption[];
}

export function VideoPanel({ isRecording = false, onEmotionDetected, surveyQuestions, surveyTotal, surveyCompleted, surveyOptions }: VideoPanelProps) {
    const { videoRef, canvasRef, isStreaming, startVideo, stopVideo, startAnalysis, stopAnalysis } = useVideoCapture({ onEmotionDetected });

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

                {isStreaming && (
                    <div className="absolute bottom-2 left-0 right-0 rounded-lg bg-gray-800/50 p-4 text-sm text-white backdrop-blur-md">
                        <div className="space-y-2">
                            <div className="font-medium">Survey Assessment</div>
                            {surveyTotal && surveyTotal > 0 && surveyQuestions && surveyQuestions.length > 0 ? (
                                <>
                                    <div className="text-xs text-slate-400">
                                        Progress: {surveyCompleted ?? 0}/{surveyTotal}
                                    </div>
                                    <div className="text-xs">{surveyQuestions[surveyQuestions.length - 1].text}</div>
                                    {surveyOptions && surveyOptions.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-2">
                                            {surveyOptions.map(opt => (
                                                <button key={opt.value} className="rounded bg-gray-700 px-2 py-0.5 text-xs hover:bg-gray-600">
                                                    {opt.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <div className="mt-2">
                                        <div className="h-1 w-full overflow-hidden rounded-full bg-gray-700">
                                            <div
                                                className="h-full bg-purple-500 transition-all duration-300"
                                                style={{ width: `${((surveyCompleted ?? 0) / surveyTotal) * 100}%` }}
                                            ></div>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div className="text-xs text-slate-400">No active survey</div>
                            )}
                        </div>
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
