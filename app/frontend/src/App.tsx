import { useState, useRef, useEffect } from "react";
import { Mic, MicOff, Smile, Meh, Frown, ClipboardList } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import StatusMessage from "@/components/ui/status-message";
import { VideoPanel } from "@/components/ui/video-panel";
import { SentimentHistoryPanel } from "@/components/ui/sentiment-history-panel";

import useRealTime from "@/hooks/useRealtime";
import useAudioRecorder from "@/hooks/useAudioRecorder";
import useAudioPlayer from "@/hooks/useAudioPlayer";

import { SentimentUpdate, EmotionResult, SentimentHistoryItem, SurveyQuestion } from "./types";

import logo from "./assets/logo.svg";

const TIME_FRAME_SECONDS = 5;

function App() {
    const [isRecording, setIsRecording] = useState(false);
    const [sentiment, setSentiment] = useState<SentimentUpdate | null>(null);
    const [lastEmotion, setLastEmotion] = useState<EmotionResult | null>(null);
    const [sentimentHistory, setSentimentHistory] = useState<SentimentHistoryItem[]>([]);
    const [surveyQuestions, setSurveyQuestions] = useState<SurveyQuestion[]>([]);
    const [surveyTotal, setSurveyTotal] = useState(0);
    const [surveyCompleted, setSurveyCompleted] = useState(0);
    const [enableSentiment, setEnableSentiment] = useState(false);
    const [enableSurvey, setEnableSurvey] = useState(false);
    const frameCounterRef = useRef(0);

    useEffect(() => {
        fetch('/config')
            .then(res => res.json())
            .then(data => {
                setEnableSentiment(data.enableSentimentAnalysis);
                setEnableSurvey(data.enableSurveyMode);
            })
            .catch(err => console.error('Failed to fetch config:', err));
    }, []);

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
        onReceivedSurveyUpdate: message => {
            setSurveyQuestions(prev => [...prev, { id: message.question_id, text: message.question_id, score: message.score }]);
            setSurveyCompleted(message.completed);
            setSurveyTotal(message.total);
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
                        <div className="mb-4 flex gap-3">
                            {enableSentiment && (
                                <div className="flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700">
                                    <Smile className="h-3 w-3" />
                                    Sentiment
                                </div>
                            )}
                            {enableSurvey && (
                                <div className="flex items-center gap-1 rounded-full bg-purple-100 px-3 py-1 text-xs font-medium text-purple-700">
                                    <ClipboardList className="h-3 w-3" />
                                    Survey
                                </div>
                            )}
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
                        {surveyTotal > 0 && (
                            <div className="mb-6 w-full max-w-md rounded-lg bg-white p-4 shadow-md">
                                <h3 className="mb-3 text-lg font-semibold text-gray-700">Burnout Assessment</h3>
                                <div className="mb-2 flex justify-between text-sm text-gray-600">
                                    <span>Progress: {surveyCompleted} / {surveyTotal}</span>
                                    <span>{surveyQuestions.length > 0 ? `Current: ${surveyQuestions[surveyQuestions.length - 1].score}/5` : ''}</span>
                                </div>
                                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                                    <div 
                                        className="h-full bg-purple-500 transition-all duration-300" 
                                        style={{ width: `${(surveyCompleted / surveyTotal) * 100}%` }}
                                    />
                                </div>
                                {surveyQuestions.length > 0 && (
                                    <div className="mt-3 text-xs text-gray-500">
                                        <span>Responses: </span>
                                        {surveyQuestions.map((q) => (
                                            <span key={q.id} className="mr-2">{q.id}:{q.score}</span>
                                        ))}
                                    </div>
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
