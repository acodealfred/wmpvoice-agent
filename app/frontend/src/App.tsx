import { useState, useRef, useEffect, useCallback } from "react";
import { Mic, MicOff, Smile, Meh, Frown, ClipboardList } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import StatusMessage from "@/components/ui/status-message";
import { VideoPanel } from "@/components/ui/video-panel";
import { SentimentHistoryPanel } from "@/components/ui/sentiment-history-panel";
import { DetailedReport } from "@/components/ui/detailed-report";

import useRealTime from "@/hooks/useRealtime";
import useAudioRecorder from "@/hooks/useAudioRecorder";
import useAudioPlayer from "@/hooks/useAudioPlayer";

import { SentimentUpdate, EmotionResult, SentimentHistoryItem, SurveyQuestion, SurveyOption, BiometricSnapshot, BiometricResult } from "./types";

import logo from "./assets/logo.png";

const TIME_FRAME_SECONDS = 5;

function App() {
    const [isRecording, setIsRecording] = useState(false);
    const [sentiment, setSentiment] = useState<SentimentUpdate | null>(null);
    const [lastEmotion, setLastEmotion] = useState<EmotionResult | null>(null);
    const [sentimentHistory, setSentimentHistory] = useState<SentimentHistoryItem[]>([]);
    const [surveyQuestions, setSurveyQuestions] = useState<SurveyQuestion[]>([]);
    const [surveyTotal, setSurveyTotal] = useState(0);
    const [surveyCompleted, setSurveyCompleted] = useState(0);
    const [surveyOptions, setSurveyOptions] = useState<SurveyOption[]>([]);
    const [biometricSnapshots, setBiometricSnapshots] = useState<BiometricSnapshot[]>([]);
    const [showDetailedReport, setShowDetailedReport] = useState(false);
    const [enableSentiment, setEnableSentiment] = useState(false);
    const [enableSurvey, setEnableSurvey] = useState(false);
    const [showOnboarding, setShowOnboarding] = useState(true);
    const [initialGreeting, setInitialGreeting] = useState<string | null>(null);
    const frameCounterRef = useRef(0);

    useEffect(() => {
        fetch("/config")
            .then(res => res.json())
            .then(data => {
                setEnableSentiment(data.enableSentimentAnalysis);
                setEnableSurvey(data.enableSurveyMode);
            })
            .catch(err => console.error("Failed to fetch config:", err));
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
            setSurveyQuestions(prev => [...prev, { id: message.question_id, text: message.question_text || message.question_id, score: message.score }]);
            setSurveyCompleted(message.completed);
            setSurveyTotal(message.total);
            if (message.options) {
                setSurveyOptions(message.options);
            }
        },
        onReceivedSurveyBiometricUpdate: message => {
            console.log("[App] Received survey biometric update:", message);
            setBiometricSnapshots(prev => {
                console.log("[App] Previous snapshots:", prev);
                const updated = [...prev, message.snapshot];
                console.log("[App] Updated snapshots:", updated);
                return updated;
            });
            setSurveyCompleted(message.completed);
            setSurveyTotal(message.total);
            if (message.completed === message.total) {
                console.log("[App] Survey completed, showing report in 2s");
                setTimeout(() => {
                    console.log("[App] Setting showDetailedReport to true");
                    setShowDetailedReport(true);
                }, 2000);
            }
        }
    });

    const handleBiometricsUpdate = useCallback(async (biometrics: BiometricResult) => {
        try {
            await fetch("/biometrics", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sentiment: sentiment?.sentiment || "neutral",
                    blink_rate_change_percent: biometrics.metrics.blinkRateChangePercent || 0,
                    face_emotion: lastEmotion?.emotion || "NEUTRAL"
                })
            });
        } catch (err) {
            console.error("Failed to update biometrics:", err);
        }
    }, [sentiment, lastEmotion]);

    const { reset: resetAudioPlayer, play: playAudio, stop: stopAudioPlayer } = useAudioPlayer();
    const { start: startAudioRecording, stop: stopAudioRecording } = useAudioRecorder({ onAudioRecorded: addUserAudio });

    const onToggleListening = async () => {
        if (!isRecording) {
            startSession();
            await startAudioRecording();
            resetAudioPlayer();

            setShowOnboarding(false);
            setIsRecording(true);

            setInitialGreeting("Hi, Who are you?");
            setTimeout(() => setInitialGreeting(null), 3000);
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
                        <VideoPanel 
                            isRecording={isRecording} 
                            onEmotionDetected={handleEmotionDetected} 
                            enableBiometrics={true} 
                            onStressStateChanged={() => {}}
                            onBiometricsDetected={handleBiometricsUpdate}
                        />
                    </div>
                    <div className="flex flex-grow flex-col items-center justify-center">
                        <h1 className="mb-8 bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-4xl font-bold text-transparent md:text-7xl">
                            {t("app.title")}
                        </h1>
                        <div className="mb-4 flex flex-col items-center justify-center">
                            {showOnboarding && !isRecording && (
                                <div className="animate-fade-in mb-4 w-80 rounded-lg border border-purple-200 bg-purple-100 p-4 shadow-md">
                                    <h3 className="mb-2 font-semibold text-purple-800">{t("onboarding.title") || "How to use"}</h3>
                                    <ol className="space-y-1 text-sm text-purple-700">
                                        <li>1. {t("onboarding.step1") || "Click the microphone button"}</li>
                                        <li>2. {t("onboarding.step2") || "Camera will turn on automatically"}</li>
                                        <li>3. {t("onboarding.step3") || "Wait 5 seconds for face analysis to start"}</li>
                                        <li>4. {t("onboarding.step4") || "Make sure only one face is visible"}</li>
                                        <li>5. {t("onboarding.step5") || 'Say "Hi, Who are you?" to start'}</li>
                                    </ol>
                                    <div className="mt-3 border-t border-purple-200 pt-3">
                                        <h4 className="mb-1 font-semibold text-red-800">{t("onboarding.limitationsTitle") || "Limitations"}</h4>
                                        <div className="space-y-1 text-sm text-red-700">
                                            <p>• {t("onboarding.limitation1") || "Not optimized for mobile/tablet — use a desktop browser"}</p>
                                            <p>
                                                •{" "}
                                                {t("onboarding.limitation2") ||
                                                    "The interface displays all processing steps, which may make the results page appear cluttered"}
                                            </p>
                                            <p>• {t("onboarding.limitation3") || "Responses may occasionally be inaccurate"}</p>
                                            <p>• {t("onboarding.limitation4") || "The agent may go off-topic — you can guide it back"}</p>
                                            <p>• {t("onboarding.limitation5") || "Some survey questions may be skipped"}</p>
                                            <p>• {t("onboarding.limitation6") || "Detailed burnout report — Not implemented"}</p>
                                            <p>• {t("onboarding.limitation7") || "Post-survey consultant — Not implemented"}</p>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {initialGreeting && (
                                <div className="animate-fade-in mb-4 rounded-lg border border-green-200 bg-green-100 px-4 py-2 shadow-md">
                                    <p className="text-sm font-medium text-green-800">{initialGreeting}</p>
                                </div>
                            )}
                            <Button
                                onClick={onToggleListening}
                                className={`h-12 w-60 ${isRecording ? "bg-red-600 hover:bg-red-700" : "animate-pulse-glow bg-purple-500 hover:bg-purple-600"}`}
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
                                {sentiment.reason && <span className="text-xs text-gray-500">- {sentiment.reason}</span>}
                            </div>
                        )}
                        {surveyTotal > 0 && (
                            <div className="mb-6 w-full max-w-md rounded-lg bg-white p-4 shadow-md">
                                <h3 className="mb-3 text-lg font-semibold text-gray-700">Burnout Assessment - Demostration Purpose Only</h3>
                                <div className="mb-2 flex justify-between text-sm text-gray-600">
                                    <span>
                                        Progress: {surveyCompleted} / {surveyTotal}
                                    </span>
                                    <span>{surveyQuestions.length > 0 ? `Current: ${surveyQuestions[surveyQuestions.length - 1].score}/5` : ""}</span>
                                </div>
                                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                                    <div
                                        className="h-full bg-purple-500 transition-all duration-300"
                                        style={{ width: `${(surveyCompleted / surveyTotal) * 100}%` }}
                                    />
                                </div>
                                {surveyQuestions.length > 0 && (
                                    <>
                                        <div className="mt-3 text-sm text-gray-700 italic">
                                            <span className="font-medium">Current question: </span>
                                            {surveyQuestions[surveyQuestions.length - 1].text}
                                        </div>
                                        {surveyOptions.length > 0 && (
                                            <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-600">
                                                <span className="font-medium">Options:</span>
                                                {surveyOptions.map(opt => (
                                                    <span key={opt.value} className="rounded bg-gray-100 px-2 py-1">
                                                        {opt.value}={opt.label}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        <div className="mt-2 text-xs text-gray-500">
                                            <span>Responses: </span>
                                            {surveyQuestions.map(q => (
                                                <span key={q.id} className="mr-2">
                                                    {q.id}:{q.score}
                                                </span>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                        
                        {showDetailedReport && biometricSnapshots.length > 0 && (
                            <div className="mb-6 flex justify-center">
                                <DetailedReport 
                                    snapshots={biometricSnapshots} 
                                    totalScore={biometricSnapshots.reduce((sum, s) => sum + s.score, 0)}
                                    onClose={() => setShowDetailedReport(false)}
                                />
                            </div>
                        )}
                        
                        <SentimentHistoryPanel history={sentimentHistory} timeFrameSeconds={TIME_FRAME_SECONDS} />
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
