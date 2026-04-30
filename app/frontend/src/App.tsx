import { useState, useRef, useEffect, useCallback } from "react";
import { Mic, MicOff, Smile, Meh, Frown, ClipboardList } from "lucide-react";
import { useTranslation } from "react-i18next";

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
    const [enableBiometrics, setEnableBiometrics] = useState(true);
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
                console.log("[App] Survey completed, stopping biometric analysis");
                setEnableBiometrics(false);
                setTimeout(() => {
                    console.log("[App] Setting showDetailedReport to true");
                    setShowDetailedReport(true);
                }, 2000);
            }
        }
    });

    const handleBiometricsUpdate = useCallback(
        async (biometrics: BiometricResult) => {
            if (!enableBiometrics) return;

            const faceEmotion = lastEmotion?.emotion;
            const blinkChange = biometrics.metrics.blinkRateChangePercent;

            const emotionToSend =
                faceEmotion && !faceEmotion.includes("No face") && !faceEmotion.includes("multiple") && faceEmotion !== "UNKNOWN" ? faceEmotion : "NEUTRAL";

            const blinkToSend = blinkChange !== undefined && blinkChange !== 0 ? blinkChange : 0;

            console.log("[App] ★ Sending biometrics update:", {
                sentiment: sentiment?.sentiment || "neutral",
                blink_rate_change_percent: blinkToSend,
                face_emotion: emotionToSend,
                rawEmotion: lastEmotion?.emotion,
                rawBlinkChange: blinkChange
            });

            try {
                await fetch("/biometrics", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        sentiment: sentiment?.sentiment || "neutral",
                        blink_rate_change_percent: blinkToSend,
                        face_emotion: emotionToSend
                    })
                });
            } catch (err) {
                console.error("Failed to update biometrics:", err);
            }
        },
        [sentiment, lastEmotion, enableBiometrics]
    );

    const handleStopBiometricsAnalysis = useCallback(async () => {
        if (!enableBiometrics) return;
        try {
            await fetch("/clear-stress", {
                method: "POST",
                headers: { "Content-Type": "application/json" }
            });
        } catch (err) {
            console.error("Failed to clear stress state:", err);
        }
    }, [enableBiometrics]);

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
        <div className="flex min-h-screen flex-col bg-gradient-to-br from-slate-950 via-slate-900 to-slate-900 text-gray-100">
            <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-slate-800 bg-slate-950/80 px-6 backdrop-blur-md">
                <div className="flex items-center gap-3">
                    <img src={logo} alt="CIQ logo" className="h-10 w-10" />
                    <div>
                        <h1 className="text-lg font-bold tracking-tight text-white">CIQ Voice Agent</h1>
                        <p className="text-xs text-slate-400">Burnout Assessment Platform</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {enableSentiment && (
                        <div className="flex items-center gap-1 rounded-full bg-green-900/50 px-3 py-1.5 text-xs font-medium text-green-400 ring-1 ring-green-800/50">
                            <Smile className="h-3.5 w-3.5" />
                            Sentiment
                        </div>
                    )}
                    {enableSurvey && (
                        <div className="flex items-center gap-1 rounded-full bg-purple-900/50 px-3 py-1.5 text-xs font-medium text-purple-400 ring-1 ring-purple-800/50">
                            <ClipboardList className="h-3.5 w-3.5" />
                            Survey
                        </div>
                    )}
                    {!isRecording && <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-400">Ready</span>}
                </div>
            </header>

            <main className="flex flex-1 overflow-hidden p-4">
                <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-4">
                    <section className="rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl shadow-black/20">
                        <div className="flex h-full flex-col">
                            <div className="border-b border-slate-800 bg-slate-900/50 px-5 py-3">
                                <div className="flex items-center gap-2">
                                    <div className="h-2 w-2 rounded-full bg-green-500/70 ring-2 ring-green-500/20"></div>
                                    <h2 className="text-sm font-semibold text-slate-200">Camera Feed</h2>
                                    <span className="ml-auto text-xs text-slate-500">LIVE</span>
                                </div>
                            </div>
                            <div className="flex-1 p-4">
                                <VideoPanel
                                    isRecording={isRecording}
                                    onEmotionDetected={handleEmotionDetected}
                                    enableBiometrics={enableBiometrics}
                                    onStressStateChanged={() => {}}
                                    onBiometricsDetected={handleBiometricsUpdate}
                                    onStopAnalysis={handleStopBiometricsAnalysis}
                                />
                            </div>
                        </div>
                    </section>

                    <section className="rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl shadow-black/20">
                        <div className="flex h-full flex-col">
                            <div className="border-b border-slate-800 bg-slate-900/50 px-5 py-3">
                                <h2 className="text-sm font-semibold text-slate-200">Face Emotion & Biometrics</h2>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                <div className="mb-4 rounded-xl bg-slate-800/50 p-4">
                                    <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Current Emotion</h3>
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800 text-4xl">
                                                {lastEmotion ? (
                                                    <span>
                                                        {lastEmotion.emotion === "HAPPY"
                                                            ? "😊"
                                                            : lastEmotion.emotion === "SAD"
                                                              ? "😢"
                                                              : lastEmotion.emotion === "ANGRY"
                                                                ? "😠"
                                                                : lastEmotion.emotion === "FEAR"
                                                                  ? "😨"
                                                                  : lastEmotion.emotion === "SURPRISED"
                                                                    ? "😲"
                                                                    : lastEmotion.emotion === "DISGUSTED"
                                                                      ? "🤢"
                                                                      : lastEmotion.emotion === "NEUTRAL"
                                                                        ? "😐"
                                                                        : "😐"}
                                                    </span>
                                                ) : (
                                                    <span className="text-slate-500">-</span>
                                                )}
                                            </div>
                                            <div>
                                                <p className="text-lg font-semibold text-slate-200">
                                                    {lastEmotion
                                                        ? lastEmotion.emotion.charAt(0) + lastEmotion.emotion.slice(1).toLowerCase()
                                                        : "No face detected"}
                                                </p>
                                                <p className="text-xs text-slate-500">Confidence: {lastEmotion ? lastEmotion.confidence.toFixed(0) : 0}%</p>
                                            </div>
                                        </div>
                                        {isRecording && <div className="h-3 w-3 animate-pulse rounded-full bg-green-500/70 ring-2 ring-green-500/20"></div>}
                                    </div>
                                </div>

                                {isRecording && (
                                    <div className="rounded-xl bg-slate-800/50 p-4">
                                        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Biometric Metrics</h3>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="rounded-lg bg-slate-800/30 p-3">
                                                <p className="text-xs text-slate-500">Blink Rate</p>
                                                <p className="text-lg font-semibold text-slate-200" id="blink-rate">
                                                    --
                                                </p>
                                            </div>
                                            <div className="rounded-lg bg-slate-800/30 p-3">
                                                <p className="text-xs text-slate-500">Eye Openness</p>
                                                <p className="text-lg font-semibold text-slate-200" id="eye-openness">
                                                    --
                                                </p>
                                            </div>
                                            <div className="rounded-lg bg-slate-800/30 p-3">
                                                <p className="text-xs text-slate-500">Smile</p>
                                                <p className="text-lg font-semibold text-slate-200" id="smile-intensity">
                                                    --
                                                </p>
                                            </div>
                                            <div className="rounded-lg bg-slate-800/30 p-3">
                                                <p className="text-xs text-slate-500">Head Pose</p>
                                                <p className="text-lg font-semibold text-slate-200" id="head-pose">
                                                    --
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {sentiment && (
                                    <div className="mt-4 rounded-xl bg-gradient-to-r from-slate-800/50 to-slate-700/30 p-4">
                                        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Voice Sentiment</h3>
                                        <div className="flex items-center gap-3">
                                            {sentiment.sentiment === "positive" && (
                                                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-500/20">
                                                    <Smile className="h-5 w-5 text-green-400" />
                                                </div>
                                            )}
                                            {sentiment.sentiment === "neutral" && (
                                                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-yellow-500/20">
                                                    <Meh className="h-5 w-5 text-yellow-400" />
                                                </div>
                                            )}
                                            {sentiment.sentiment === "negative" && (
                                                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/20">
                                                    <Frown className="h-5 w-5 text-red-400" />
                                                </div>
                                            )}
                                            <div>
                                                <p className="text-sm font-semibold capitalize text-slate-200">{sentiment.sentiment}</p>
                                                <p className="text-xs text-slate-400">{sentiment.reason}</p>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>

                    <section className="rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl shadow-black/20">
                        <div className="flex h-full flex-col">
                            <div className="border-b border-slate-800 bg-slate-900/50 px-5 py-3">
                                <div className="flex items-center gap-2">
                                    <h2 className="text-sm font-semibold text-slate-200">Survey Assessment</h2>
                                    {surveyTotal > 0 && (
                                        <span className="ml-auto rounded-full bg-purple-500/20 px-2 py-0.5 text-xs text-purple-400">
                                            {surveyCompleted} / {surveyTotal}
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                {surveyTotal > 0 && (
                                    <>
                                        <div className="mb-4">
                                            <div className="mb-2 flex justify-between text-xs text-slate-400">
                                                <span>Assessment Progress</span>
                                                <span>{Math.round((surveyCompleted / surveyTotal) * 100)}%</span>
                                            </div>
                                            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                                                <div
                                                    className="h-full rounded-full bg-gradient-to-r from-purple-600 to-pink-500 transition-all duration-500"
                                                    style={{ width: `${(surveyCompleted / surveyTotal) * 100}%` }}
                                                />
                                            </div>
                                        </div>

                                        {surveyQuestions.length > 0 && (
                                            <div className="mb-4 rounded-xl bg-slate-800/50 p-4">
                                                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Current Question</p>
                                                <p className="text-sm text-slate-200">{surveyQuestions[surveyQuestions.length - 1].text}</p>
                                                <div className="mt-3">
                                                    <span className="text-xs text-slate-500">Score: </span>
                                                    <span className="text-lg font-semibold text-purple-400">
                                                        {surveyQuestions[surveyQuestions.length - 1].score}/5
                                                    </span>
                                                </div>
                                            </div>
                                        )}

                                        {surveyOptions.length > 0 && (
                                            <div className="mb-4">
                                                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Available Options</p>
                                                <div className="grid grid-cols-2 gap-2">
                                                    {surveyOptions.map(opt => (
                                                        <div key={opt.value} className="rounded-lg bg-slate-800/30 p-2 text-center">
                                                            <p className="text-xs text-slate-400">{opt.label}</p>
                                                            <p className="text-lg font-semibold text-slate-200">{opt.value}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        <div>
                                            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Response History</p>
                                            <div className="space-y-2">
                                                {surveyQuestions.map(q => (
                                                    <div key={q.id} className="flex items-center justify-between rounded-lg bg-slate-800/30 px-3 py-2">
                                                        <span className="text-xs text-slate-400">{q.id}</span>
                                                        <span className="text-sm font-semibold text-slate-200">{q.score}/5</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                )}

                                {!surveyTotal && (
                                    <div className="flex h-full flex-col items-center justify-center text-center">
                                        <ClipboardList className="mb-3 h-12 w-12 text-slate-600" />
                                        <p className="text-sm text-slate-500">No active survey</p>
                                        <p className="text-xs text-slate-600">Begin conversation to start assessment</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>

                    <section className="rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl shadow-black/20">
                        <div className="flex h-full flex-col">
                            {((showOnboarding && !isRecording) || initialGreeting) && (
                                <div className="border-b border-slate-800 bg-slate-800/30 px-5 py-4">
                                    {initialGreeting && (
                                        <div className="mb-3 rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3">
                                            <p className="text-sm font-medium text-green-400">{initialGreeting}</p>
                                        </div>
                                    )}
                                    {showOnboarding && !isRecording && (
                                        <div>
                                            <h3 className="mb-3 text-sm font-semibold text-slate-200">Getting Started</h3>
                                            <ol className="space-y-2 text-sm">
                                                <li className="flex items-start gap-3">
                                                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-xs font-semibold text-purple-400">
                                                        1
                                                    </span>
                                                    <span className="text-slate-400">{t("onboarding.step1")}</span>
                                                </li>
                                                <li className="flex items-start gap-3">
                                                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-xs font-semibold text-purple-400">
                                                        2
                                                    </span>
                                                    <span className="text-slate-400">{t("onboarding.step2")}</span>
                                                </li>
                                                <li className="flex items-start gap-3">
                                                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-xs font-semibold text-purple-400">
                                                        3
                                                    </span>
                                                    <span className="text-slate-400">{t("onboarding.step3")}</span>
                                                </li>
                                                <li className="flex items-start gap-3">
                                                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-xs font-semibold text-purple-400">
                                                        4
                                                    </span>
                                                    <span className="text-slate-400">{t("onboarding.step4")}</span>
                                                </li>
                                            </ol>

                                            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-800/50 p-3">
                                                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Limitations</p>
                                                <ul className="space-y-1 text-xs text-slate-500">
                                                    <li>• Not optimized for mobile/tablet</li>
                                                    <li>• Interface may appear busy</li>
                                                    <li>• Responses may be inaccurate</li>
                                                    <li>• Agent may go off-topic</li>
                                                    <li>• Survey questions may be skipped</li>
                                                </ul>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            <div className="flex-1 overflow-y-auto p-4">
                                <div className="mb-4 flex justify-center">
                                    <button
                                        onClick={onToggleListening}
                                        className={`group relative flex h-16 w-full max-w-xs items-center justify-center gap-3 rounded-xl px-8 text-lg font-semibold transition-all duration-300 ${
                                            isRecording
                                                ? "bg-gradient-to-r from-red-600 to-red-500 shadow-lg shadow-red-500/20 hover:from-red-500 hover:to-red-400"
                                                : "animate-pulse-glow bg-gradient-to-r from-purple-600 to-pink-600 shadow-lg shadow-purple-500/20 hover:from-purple-500 hover:to-pink-500"
                                        }`}
                                        aria-label={isRecording ? t("app.stopRecording") : t("app.startRecording")}
                                    >
                                        {isRecording ? (
                                            <>
                                                <MicOff className="h-5 w-5" />
                                                {t("app.stopConversation")}
                                            </>
                                        ) : (
                                            <>
                                                <Mic className="h-6 w-6" />
                                                Click to Start
                                            </>
                                        )}
                                        {isRecording && (
                                            <span className="absolute -right-2 -top-2 flex h-5 w-5">
                                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75"></span>
                                                <span className="relative inline-flex h-5 w-5 rounded-full bg-red-500"></span>
                                            </span>
                                        )}
                                    </button>
                                </div>

                                <StatusMessage isRecording={isRecording} />

                                {sentiment && (
                                    <div className="mb-4 rounded-xl bg-slate-800/50 p-4">
                                        <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Current Sentiment</h3>
                                        <div className="flex items-center gap-3">
                                            {sentiment.sentiment === "positive" && (
                                                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-500/20">
                                                    <Smile className="h-5 w-5 text-green-400" />
                                                </div>
                                            )}
                                            {sentiment.sentiment === "neutral" && (
                                                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-yellow-500/20">
                                                    <Meh className="h-5 w-5 text-yellow-400" />
                                                </div>
                                            )}
                                            {sentiment.sentiment === "negative" && (
                                                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/20">
                                                    <Frown className="h-5 w-5 text-red-400" />
                                                </div>
                                            )}
                                            <div>
                                                <p className="text-sm font-semibold capitalize text-slate-200">{sentiment.sentiment}</p>
                                                <p className="text-xs text-slate-500">{sentiment.reason}</p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {surveyTotal > 0 && (
                                    <div className="mb-4 rounded-xl bg-slate-800/50 p-4">
                                        <div className="mb-2 flex items-center justify-between">
                                            <h3 className="text-xs font-medium uppercase tracking-wider text-slate-500">Burnout Assessment</h3>
                                            <span className="text-xs text-purple-400">
                                                {surveyCompleted} / {surveyTotal}
                                            </span>
                                        </div>
                                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                                            <div
                                                className="h-full rounded-full bg-gradient-to-r from-purple-600 to-pink-500 transition-all duration-500"
                                                style={{ width: `${(surveyCompleted / surveyTotal) * 100}%` }}
                                            />
                                        </div>
                                        {surveyQuestions.length > 0 && (
                                            <p className="mt-2 text-xs text-slate-400">
                                                Current score: <span className="text-slate-200">{surveyQuestions[surveyQuestions.length - 1].score}/5</span>
                                            </p>
                                        )}
                                    </div>
                                )}

                                {showDetailedReport && biometricSnapshots.length > 0 && (
                                    <div className="mb-4">
                                        <DetailedReport
                                            snapshots={biometricSnapshots}
                                            totalScore={biometricSnapshots.reduce((sum, s) => sum + s.score, 0)}
                                            onClose={() => setShowDetailedReport(false)}
                                            onAgentSpeaking={text => console.log("[App] Agent speaking:", text)}
                                        />
                                    </div>
                                )}

                                <div>
                                    <SentimentHistoryPanel history={sentimentHistory} timeFrameSeconds={TIME_FRAME_SECONDS} />
                                </div>
                            </div>

                            <div className="border-t border-slate-800 bg-slate-900/50 px-5 py-3">
                                <p className="text-center text-xs text-slate-500">{t("app.footer")}</p>
                            </div>
                        </div>
                    </section>
                </div>
            </main>
        </div>
    );
}

export default App;
