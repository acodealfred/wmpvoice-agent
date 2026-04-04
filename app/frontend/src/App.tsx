import { useState, useRef, useEffect } from "react";
import { Mic, MicOff, Smile, Meh, Frown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import StatusMessage from "@/components/ui/status-message";
import { VideoPanel } from "@/components/ui/video-panel";
import { SentimentHistoryPanel } from "@/components/ui/sentiment-history-panel";

import useRealTime from "@/hooks/useRealtime";
import useAudioRecorder from "@/hooks/useAudioRecorder";
import useAudioPlayer from "@/hooks/useAudioPlayer";

import { SentimentUpdate, EmotionResult, SentimentHistoryItem } from "./types";

import logo from "./assets/logo.svg";

const TIME_FRAME_SECONDS = 5;

function App() {
    const [isRecording, setIsRecording] = useState(false);
    const [sentiment, setSentiment] = useState<SentimentUpdate | null>(null);
    const [lastEmotion, setLastEmotion] = useState<EmotionResult | null>(null);
    const [sentimentHistory, setSentimentHistory] = useState<SentimentHistoryItem[]>([]);
    const frameCounterRef = useRef(0);

    const { startSession, addUserAudio, inputAudioBufferClear } = useRealTime({
        onWebSocketOpen: () => console.log("WebSocket connection opened"),
        onWebSocketClose: () => console.log("WebSocket connection closed"),
        onWebSocketError: event => console.error("WebSocket error:", event),
        onReceivedError: message => console.error("error", message),
        onReceivedResponseAudioDelta: message => {
            isRecording && playAudio(message.delta);
        },
        onReceivedInputAudioBufferSpeechStarted: () => {
            stopAudioPlayer();
        },
        onReceivedSentimentUpdate: message => {
            setSentiment(message);
        },
    });

    const { reset: resetAudioPlayer, play: playAudio, stop: stopAudioPlayer } = useAudioPlayer();
    const { start: startAudioRecording, stop: stopAudioRecording } = useAudioRecorder({ onAudioRecorded: addUserAudio });

    const onToggleListening = async () => {
        if (!isRecording) {
            startSession();
            await startAudioRecording();
            resetAudioPlayer();

            setIsRecording(true);
        } else {
            await stopAudioRecording();
            stopAudioPlayer();
            inputAudioBufferClear();

            setIsRecording(false);
        }
    };

    const handleEmotionDetected = (emotion: EmotionResult) => {
        setLastEmotion(emotion);
    };

    useEffect(() => {
        if (!isRecording) {
            setSentimentHistory([]);
            frameCounterRef.current = 0;
            return;
        }

        const interval = setInterval(() => {
            frameCounterRef.current += 1;
            const newItem: SentimentHistoryItem = {
                id: `frame-${frameCounterRef.current}-${Date.now()}`,
                timestamp: Date.now(),
                timeFrameLabel: `${TIME_FRAME_SECONDS}s frame ${frameCounterRef.current}`,
                faceEmotion: lastEmotion?.emotion || "No face detected",
                faceEmotionConfidence: lastEmotion?.confidence || 0,
                voiceSentiment: sentiment?.sentiment || "neutral",
                voiceSentimentReason: sentiment?.reason
            };

            setSentimentHistory(prev => {
                const updated = [...prev, newItem];
                if (updated.length > 10) {
                    return updated.slice(-10);
                }
                return updated;
            });
        }, TIME_FRAME_SECONDS * 1000);

        return () => clearInterval(interval);
    }, [isRecording, lastEmotion, sentiment]);

    const { t } = useTranslation();

    return (
        <div className="flex min-h-screen flex-col bg-gray-100 text-gray-900">
            <div className="p-4 sm:absolute sm:left-4 sm:top-4">
                <img src={logo} alt="Azure logo" className="h-16 w-16" />
            </div>
            <main className="flex flex-grow flex-col items-center justify-center p-4">
                <div className="flex w-full max-w-6xl flex-wrap items-start justify-center gap-8">
                    <div className="flex-shrink-0">
                        <VideoPanel isRecording={isRecording} onEmotionDetected={handleEmotionDetected} />
                    </div>
                    <div className="flex flex-grow flex-col items-center justify-center">
                        <h1 className="mb-8 bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-4xl font-bold text-transparent md:text-7xl">
                            {t("app.title")}
                        </h1>
                        <div className="mb-4 flex flex-col items-center justify-center">
                            <Button
                                onClick={onToggleListening}
                                className={`h-12 w-60 ${isRecording ? "bg-red-600 hover:bg-red-700" : "bg-purple-500 hover:bg-purple-600"}`}
                                aria-label={isRecording ? t("app.stopRecording") : t("app.startRecording")}
                            >
                                {isRecording ? (
                                    <>
                                        <MicOff className="mr-2 h-4 w-4" />
                                        {t("app.stopConversation")}
                                    </>
                                ) : (
                                    <>
                                        <Mic className="mr-2 h-6 w-6" />
                                    </>
                                )}
                            </Button>
                            <StatusMessage isRecording={isRecording} />
                        </div>
                        {sentiment && (
                            <div className="mb-6 flex items-center gap-2 rounded-lg bg-white px-4 py-2 shadow-md">
                                <span className="text-sm font-medium text-gray-600">Sentiment:</span>
                                {sentiment.sentiment === "positive" && (
                                    <>
                                        <Smile className="h-5 w-5 text-green-500" />
                                        <span className="text-sm font-medium text-green-600">Positive</span>
                                    </>
                                )}
                                {sentiment.sentiment === "neutral" && (
                                    <>
                                        <Meh className="h-5 w-5 text-yellow-500" />
                                        <span className="text-sm font-medium text-yellow-600">Neutral</span>
                                    </>
                                )}
                                {sentiment.sentiment === "negative" && (
                                    <>
                                        <Frown className="h-5 w-5 text-red-500" />
                                        <span className="text-sm font-medium text-red-600">Negative</span>
                                    </>
                                )}
                                {sentiment.reason && (
                                    <span className="text-xs text-gray-500">- {sentiment.reason}</span>
                                )}
                            </div>
                        )}
                        <SentimentHistoryPanel 
                            history={sentimentHistory} 
                            timeFrameSeconds={TIME_FRAME_SECONDS} 
                        />
                    </div>
                </div>
            </main>

            <footer className="py-4 text-center">
                <p>{t("app.footer")}</p>
            </footer>
        </div>
    );
}

export default App;
