import { useState, useRef, useEffect, useCallback } from "react";
import { Mic, MicOff, Smile, Meh, Frown, ClipboardList, Play, Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { VideoPanel } from "@/components/ui/video-panel";
import { SentimentHistoryPanel } from "@/components/ui/sentiment-history-panel";
import { DetailedReport } from "@/components/ui/detailed-report";
import { Button } from "@/components/ui/button";

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
    const [multipleFacesWarning, setMultipleFacesWarning] = useState(false);
    const frameCounterRef = useRef(0);

    // Biometrics state
    const [currentBiometrics, setCurrentBiometrics] = useState<BiometricResult | null>(null);
    const [baselineSessionStatus, setBaselineSessionStatus] = useState<"idle" | "collecting" | "completed">("idle");
    const [baselineData, setBaselineData] = useState<{ pupilSize: number; blinkRate: number; timestamp: number } | null>(null);
    const [baselineProgress, setBaselineProgress] = useState(0);
    const [stressResult, setStressResult] = useState<{ state: string; confidence: number; blink_rate_change_percent?: number; trend: string } | null>(null);

    useEffect(() => {
        fetch("/config")
            .then(res => res.json())
            .then(data => {
                setEnableSentiment(data.enableSentimentAnalysis);
                setEnableSurvey(data.enableSurveyMode);
            })
            .catch(err => console.error("Failed to fetch config:", err));
    }, []);

    // Load baseline from localStorage on mount
    useEffect(() => {
        try {
            const savedBaseline = localStorage.getItem("voicerag_biometric_baseline");
            if (savedBaseline) {
                const data = JSON.parse(savedBaseline);
                setBaselineData(data);
                setBaselineSessionStatus("completed");
            }
        } catch (error) {
            console.error("Error loading baseline:", error);
        }
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

            console.log("[App] Sending biometrics update:", {
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

    const handleEmotionDetected = (emotion: EmotionResult) => {
        setLastEmotion(emotion);
        setMultipleFacesWarning(emotion.emotion === "multiple_faces_detected");
    };

    // Stress analysis effect
    useEffect(() => {
        if (!isRecording || !currentBiometrics?.faceDetected || !enableBiometrics) {
            return;
        }

        const fetchStressAnalysis = async () => {
            if (!currentBiometrics?.metrics?.blinkRate) return;

            const blinkRate = currentBiometrics.metrics.blinkRate;
            const baselineBlinkRate = baselineData?.blinkRate;

            try {
                const response = await fetch("/analyze-stress", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        blink_rate: blinkRate,
                        baseline_blink_rate: baselineBlinkRate
                    })
                });
                const data = await response.json();
                if (data.state) {
                    setStressResult(data);
                }
            } catch (error) {
                console.error("Stress analysis error:", error);
            }
        };

        fetchStressAnalysis();
        const intervalId = setInterval(fetchStressAnalysis, 5000);

        return () => clearInterval(intervalId);
    }, [isRecording, currentBiometrics, enableBiometrics, baselineData]);

    // Capture biometrics from video (simplified - in real app would use biometrics hook)
    // For demo, we'll simulate biometrics when recording and camera is active
    useEffect(() => {
        let intervalId: number | null = null;

        if (isRecording && baselineSessionStatus === "completed" && enableBiometrics) {
            intervalId = window.setInterval(() => {
                // Generate mock biometric data
                const mockBiometrics: BiometricResult = {
                    metrics: {
                        headPose: { pitch: 0, roll: 0, yaw: 0 },
                        blinkRate: Math.random() * 20 + 10,
                        blinkCount: Math.floor(Math.random() * 10),
                        eyeOpenness: Math.random() * 0.3 + 0.5,
                        mouthOpenness: Math.random() * 0.2,
                        smileIntensity: Math.random() * 0.5,
                        faceWidth: 100,
                        faceHeight: 120,
                        interocularDistance: 6.5,
                        irisPosition: { x: 0.5, y: 0.5 },
                        pupilSize: Math.random() * 0.1 + 0.4,
                        pupilSizeMm: Math.random() * 2 + 3,
                        pupilSizeChangePercent: (Math.random() - 0.5) * 10,
                        blinkRateChangePercent: (Math.random() - 0.5) * 15,
                        smoothedBlinkRate: Math.random() * 20 + 10,
                        baselineRateForChange: baselineData?.blinkRate || 0
                    },
                    timestamp: Date.now(),
                    faceDetected: true,
                    analysisDuration: Math.floor(Date.now() / 1000)
                };
                setCurrentBiometrics(mockBiometrics);
                handleBiometricsUpdate(mockBiometrics);
            }, 3000);
        }

        return () => {
            if (intervalId) clearInterval(intervalId);
        };
    }, [isRecording, baselineSessionStatus, enableBiometrics, baselineData, handleBiometricsUpdate]);

    // Baseline session effect
    useEffect(() => {
        if (isRecording && enableBiometrics && baselineSessionStatus === "idle") {
            // Automatically start baseline when recording starts
            setBaselineSessionStatus("collecting");
            setBaselineProgress(0);

            const durationMs = 30 * 1000;
            let elapsed = 0;

            const timer = setInterval(() => {
                elapsed += 100;
                const progress = Math.min((elapsed / durationMs) * 100, 100);
                setBaselineProgress(progress);

                if (elapsed >= durationMs) {
                    clearInterval(timer);
                    const newBaseline = {
                        pupilSize: Math.random() * 1 + 3,
                        blinkRate: Math.random() * 10 + 15,
                        timestamp: Date.now()
                    };
                    setBaselineData(newBaseline);
                    setBaselineSessionStatus("completed");
                    try {
                        localStorage.setItem("voicerag_biometric_baseline", JSON.stringify(newBaseline));
                    } catch (error) {
                        console.error("Error saving baseline:", error);
                    }
                }
            }, 100);
        }
    }, [isRecording, enableBiometrics, baselineSessionStatus]);

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

    const handleStartBaselineSession = useCallback(() => {
        setBaselineSessionStatus("collecting");
        setBaselineProgress(0);
    }, []);

    const handleProceedWithoutBaseline = useCallback(() => {
        setBaselineSessionStatus("completed");
        setBaselineData({ pupilSize: 0, blinkRate: 0, timestamp: Date.now() });
    }, []);

    const handleRerecordBaseline = useCallback(() => {
        try {
            localStorage.removeItem("voicerag_biometric_baseline");
        } catch (error) {
            console.error("Error clearing baseline:", error);
        }
        setBaselineData(null);
        setBaselineSessionStatus("idle");
    }, []);

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

    const getEmotionEmoji = (emotion: string) => {
        const emotionIcons: Record<string, string> = {
            HAPPY: "😊",
            SAD: "😢",
            ANGRY: "😠",
            FEAR: "😨",
            SURPRISED: "😲",
            DISGUSTED: "🤢",
            NEUTRAL: "😐",
            MULTIPLE_FACES_DETECTED: "👥"
        };
        return emotionIcons[emotion.toUpperCase()] || "😐";
    };

    const getHeadPoseLabel = (degrees: number): string => {
        if (degrees < -15) return "Turned Left";
        if (degrees > 15) return "Turned Right";
        if (degrees < -5) return "Slight Left";
        if (degrees > 5) return "Slight Right";
        return "Center";
    };

    const formatMetric = (value: number, decimals: number = 1): string => {
        return (value * 100).toFixed(decimals) + "%";
    };

    const getStressColor = (state: string) => {
        switch (state) {
            case "stressed":
                return "text-red-400";
            case "relaxed":
                return "text-green-400";
            default:
                return "text-yellow-400";
        }
    };

    const getStressBgColor = (state: string) => {
        switch (state) {
            case "stressed":
                return "bg-red-900/30 border-red-700";
            case "relaxed":
                return "bg-green-900/30 border-green-700";
            default:
                return "bg-yellow-900/30 border-yellow-700";
        }
    };

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
                <div className="grid h-full w-full grid-cols-2 grid-rows-3 gap-4">
                    {/* Camera Feed Panel - Top Left */}
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
                                <VideoPanel isRecording={isRecording} onEmotionDetected={handleEmotionDetected} />
                            </div>
                            <div className="border-t border-slate-800 bg-slate-900/50 px-5 py-3">
                                <div className="flex justify-center">
                                    <Button
                                        onClick={onToggleListening}
                                        className={`group relative flex h-12 items-center justify-center gap-3 rounded-xl px-8 text-lg font-semibold transition-all duration-300 ${
                                            isRecording
                                                ? "bg-gradient-to-r from-red-600 to-red-500 shadow-lg shadow-red-500/20 hover:from-red-500 hover:to-red-400"
                                                : "bg-gradient-to-r from-purple-600 to-pink-600 shadow-lg shadow-purple-500/20 hover:from-purple-500 hover:to-pink-500"
                                        }`}
                                    >
                                        {isRecording ? (
                                            <>
                                                <MicOff className="h-5 w-5" />
                                                {t("app.stopConversation")}
                                            </>
                                        ) : (
                                            <>
                                                <Mic className="h-6 w-6" />
                                                {t("app.startRecording") || "Start Conversation"}
                                            </>
                                        )}
                                        {isRecording && (
                                            <span className="absolute -right-2 -top-2 flex h-5 w-5">
                                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75"></span>
                                                <span className="relative inline-flex h-5 w-5 rounded-full bg-red-500"></span>
                                            </span>
                                        )}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Face Emotion & Sentiment Panel - Top Right */}
                    <section className="rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl shadow-black/20">
                        <div className="flex h-full flex-col">
                            <div className="border-b border-slate-800 bg-slate-900/50 px-5 py-3">
                                <h2 className="text-sm font-semibold text-slate-200">Face Emotion & Sentiment</h2>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                {/* Current Emotion & Voice Sentiment - Side by Side */}
                                <div className="grid grid-cols-2 gap-2">
                                    {/* Current Emotion */}
                                    <div className="rounded bg-slate-800/50 px-2 py-1.5">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 shrink-0">
                                                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800 text-xl">
                                                    {lastEmotion ? <span>{getEmotionEmoji(lastEmotion.emotion)}</span> : <span className="text-slate-500">-</span>}
                                                </div>
                                                <div>
                                                    <p className="text-xs font-semibold text-slate-200 truncate max-w-20">
                                                        {lastEmotion
                                                            ? lastEmotion.emotion.charAt(0) + lastEmotion.emotion.slice(1).toLowerCase()
                                                            : "No face"}
                                                    </p>
                                                    <p className="text-[9px] text-slate-500">Conf: {lastEmotion ? lastEmotion.confidence.toFixed(0) : 0}%</p>
                                                </div>
                                            </div>
                                            {isRecording && <div className="h-2 w-2 animate-pulse rounded-full bg-green-500/70 ring-1 ring-green-500/20 shrink-0"></div>}
                                        </div>
                                    </div>

                                    {/* Voice Sentiment */}
                                    {sentiment && (
                                        <div className="rounded bg-gradient-to-r from-slate-800/50 to-slate-700/30 px-2 py-1.5">
                                            <div className="flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2 shrink-0">
                                                    {sentiment.sentiment === "positive" && (
                                                        <div className="flex h-7 w-7 items-center justify-center rounded bg-green-500/20">
                                                            <Smile className="h-3.5 w-3.5 text-green-400" />
                                                        </div>
                                                    )}
                                                    {sentiment.sentiment === "neutral" && (
                                                        <div className="flex h-7 w-7 items-center justify-center rounded bg-yellow-500/20">
                                                            <Meh className="h-3.5 w-3.5 text-yellow-400" />
                                                        </div>
                                                    )}
                                                    {sentiment.sentiment === "negative" && (
                                                        <div className="flex h-7 w-7 items-center justify-center rounded bg-red-500/20">
                                                            <Frown className="h-3.5 w-3.5 text-red-400" />
                                                        </div>
                                                    )}
                                                    <div>
                                                        <p className="text-[10px] font-semibold capitalize text-slate-200">{sentiment.sentiment}</p>
                                                        <p className="text-[9px] text-slate-500 truncate max-w-24">{sentiment.reason}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Baseline Prompt UI */}
                                {isRecording && baselineSessionStatus === "idle" && enableBiometrics && (
                                    <div className="mb-4 rounded-lg border border-blue-700 bg-blue-900/50 p-4">
                                        <h3 className="text-md mb-2 font-semibold text-white">Baseline Measurement Required</h3>
                                        <p className="mb-4 text-sm text-gray-300">
                                            To measure biometric changes during conversation, we need to record a baseline measurement first. Please look at the
                                            camera for 30 seconds while we record your baseline pupil size and blink rate.
                                        </p>
                                        <div className="flex gap-2">
                                            <Button onClick={handleStartBaselineSession} size="sm" className="flex-1">
                                                <Play className="mr-2 h-4 w-4" />
                                                Start Baseline (30s)
                                            </Button>
                                            <Button onClick={handleProceedWithoutBaseline} size="sm" variant="outline">
                                                Skip
                                            </Button>
                                        </div>
                                    </div>
                                )}

                                {/* Baseline Recording Progress */}
                                {baselineSessionStatus === "collecting" && (
                                    <div className="mb-4 rounded-lg border border-blue-700 bg-blue-900/50 p-4">
                                        <div className="mb-3 flex items-center justify-center">
                                            <Loader2 className="mr-2 h-6 w-6 animate-spin text-blue-400" />
                                            <span className="text-blue-300">Recording baseline...</span>
                                        </div>
                                        <div className="h-2 w-full rounded-full bg-gray-700">
                                            <div
                                                className="h-2 rounded-full bg-blue-500 transition-all duration-100"
                                                style={{ width: `${baselineProgress}%` }}
                                            />
                                        </div>
                                        <p className="mt-2 text-center text-sm text-gray-400">{Math.round((baselineProgress / 100) * 30)} / 30 seconds</p>
                                    </div>
                                )}

                                {/* Baseline Completed */}
                                {baselineSessionStatus === "completed" && baselineData && (
                                    <div className="mb-3 rounded-lg border border-green-700 bg-green-900/30 p-2">
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs font-medium text-green-300">Baseline Recorded</p>
                                            <Button onClick={handleRerecordBaseline} size="sm" variant="outline" className="h-6 px-2 text-[10px]">
                                                <RotateCcw className="mr-1 h-3 w-3" />
                                                Rerecord
                                            </Button>
                                        </div>
                                        <div className="mt-1 flex items-center gap-3 text-[10px]">
                                            <div className="flex items-center gap-1">
                                                <span className="text-gray-400">Pupil:</span>
                                                <span className="text-white">{baselineData.pupilSize.toFixed(1)} mm</span>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-gray-400">Blink:</span>
                                                <span className="text-white">{baselineData.blinkRate.toFixed(1)}/min</span>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Biometric Metrics */}
                                {currentBiometrics && currentBiometrics.faceDetected && isRecording && (
                                    <div className="rounded bg-slate-800/50 px-1.5 py-1">
                                        <h3 className="mb-1 text-[9px] font-medium uppercase tracking-wider text-slate-500">Biometric Metrics</h3>
                                        <div className="flex gap-1 overflow-x-auto">
                                            {/* Blink Rate - Blue */}
                                            <div className="flex shrink-0 items-center gap-1.5 rounded bg-blue-900/20 px-1.5 py-1">
                                                <div className="h-1.5 w-1.5 rounded-full bg-blue-400"></div>
                                                <div>
                                                    <p className="text-[8px] text-blue-300">Blink</p>
                                                    <p className="text-[9px] font-semibold text-blue-200">
                                                        {currentBiometrics.metrics.blinkRate.toFixed(0)}/min
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Eye Openness - Cyan */}
                                            <div className="flex shrink-0 items-center gap-1.5 rounded bg-cyan-900/20 px-1.5 py-1">
                                                <div className="h-1.5 w-1.5 rounded-full bg-cyan-400"></div>
                                                <div>
                                                    <p className="text-[8px] text-cyan-300">Eye</p>
                                                    <p className="text-[9px] font-semibold text-cyan-200">
                                                        {formatMetric(currentBiometrics.metrics.eyeOpenness)}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Smile - Pink */}
                                            <div className="flex shrink-0 items-center gap-1.5 rounded bg-pink-900/20 px-1.5 py-1">
                                                <div className="h-1.5 w-1.5 rounded-full bg-pink-400"></div>
                                                <div>
                                                    <p className="text-[8px] text-pink-300">Smile</p>
                                                    <p className="text-[9px] font-semibold text-pink-200">
                                                        {formatMetric(currentBiometrics.metrics.smileIntensity)}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Head Pose - Amber */}
                                            <div className="flex shrink-0 items-center gap-1.5 rounded bg-amber-900/20 px-1.5 py-1">
                                                <div className="h-1.5 w-1.5 rounded-full bg-amber-400"></div>
                                                <div>
                                                    <p className="text-[8px] text-amber-300">Pose</p>
                                                    <p className="text-[9px] font-semibold text-amber-200 truncate max-w-12">
                                                        {getHeadPoseLabel(currentBiometrics.metrics.headPose.yaw)}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Pupil Size - Purple */}
                                            <div className="flex shrink-0 items-center gap-1.5 rounded bg-purple-900/20 px-1.5 py-1">
                                                <div className="h-1.5 w-1.5 rounded-full bg-purple-400"></div>
                                                <div>
                                                    <p className="text-[8px] text-purple-300">Pupil</p>
                                                    <p className="text-[9px] font-semibold text-purple-200">
                                                        {currentBiometrics.metrics.pupilSizeMm.toFixed(1)}mm
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Blink Rate Change - Conditional */}
                                            <div className={`flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 ${
                                                currentBiometrics.metrics.blinkRateChangePercent >= 0
                                                    ? "bg-red-900/20"
                                                    : "bg-green-900/20"
                                            }`}>
                                                <div className={`h-1.5 w-1.5 rounded-full ${
                                                    currentBiometrics.metrics.blinkRateChangePercent >= 0
                                                        ? "bg-red-400"
                                                        : "bg-green-400"
                                                }`}></div>
                                                <div>
                                                    <p className={`text-[8px] ${
                                                        currentBiometrics.metrics.blinkRateChangePercent >= 0
                                                            ? "text-red-300"
                                                            : "text-green-300"
                                                    }`}>Change</p>
                                                    <p className={`text-[9px] font-semibold ${
                                                        currentBiometrics.metrics.blinkRateChangePercent >= 0
                                                            ? "text-red-200"
                                                            : "text-green-200"
                                                    }`}>
                                                        {currentBiometrics.metrics.blinkRateChangePercent >= 0 ? "+" : ""}
                                                        {currentBiometrics.metrics.blinkRateChangePercent.toFixed(0)}%
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Stress Analysis */}
                                {stressResult && isRecording && (
                                    <div className={`mt-3 rounded-lg border p-2 ${getStressBgColor(stressResult.state)}`}>
                                        <div className="flex items-center justify-between">
                                            <h4 className="text-xs font-semibold text-gray-300">Blink Rate Stress</h4>
                                            <span className={`text-[10px] font-medium ${getStressColor(stressResult.state)}`}>
                                                {stressResult.state.toUpperCase()}
                                            </span>
                                        </div>
                                        <div className="mt-1 flex items-center gap-3 text-[10px]">
                                            <div className="flex items-center gap-1">
                                                <span className="text-gray-400">State:</span>
                                                <span className={`font-medium ${getStressColor(stressResult.state)}`}>{stressResult.state}</span>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-gray-400">Change:</span>
                                                <span className={`font-medium ${(stressResult.blink_rate_change_percent || 0) >= 0 ? "text-red-400" : "text-green-400"}`}>
                                                    {(stressResult.blink_rate_change_percent || 0) >= 0 ? "+" : ""}{stressResult.blink_rate_change_percent?.toFixed(1) || "0.0"}%
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-gray-400">Conf:</span>
                                                <span className="text-white">{(stressResult.confidence * 100).toFixed(0)}%</span>
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <span className="text-gray-400">Trend:</span>
                                                <span className={`font-medium ${
                                                    stressResult.trend === "increasing"
                                                        ? "text-red-400"
                                                        : stressResult.trend === "decreasing"
                                                        ? "text-green-400"
                                                        : "text-yellow-400"
                                                }`}>
                                                    {stressResult.trend}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Sentiment History Panel */}
                                <div className="mt-4">
                                    <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Sentiment History</h3>
                                    <SentimentHistoryPanel history={sentimentHistory} timeFrameSeconds={TIME_FRAME_SECONDS} />
                                </div>

                                {/* Multiple Faces Warning */}
                                {multipleFacesWarning && isRecording && (
                                    <div className="mt-4 flex items-center justify-center rounded-lg bg-yellow-900/50 p-3">
                                        <AlertTriangle className="mr-2 h-5 w-5 text-yellow-500" />
                                        <span className="text-sm text-yellow-500">Only one face should be visible</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* Survey Assessment Panel - Rectangle (spans 2 columns, row 2) */}
                    <section className="col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl shadow-black/20">
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

                    {/* Final Results Panel - Burnout Assessment (spans 2 columns, row 3) */}
                    <section className="col-span-2 rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl shadow-black/20">
                        <div className="flex h-full flex-col">
                            <div className="border-b border-slate-800 bg-slate-900/50 px-5 py-3">
                                <h2 className="text-sm font-semibold text-slate-200">Final Results - Burnout Assessment</h2>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                {surveyTotal > 0 ? (
                                    <>
                                        <div className="mb-4">
                                            <div className="mb-2 flex justify-between text-xs text-slate-400">
                                                <span>Overall Assessment Progress</span>
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
                                            <div className="mb-4">
                                                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Assessment Summary</h3>
                                                <div className="grid grid-cols-2 gap-3">
                                                    <div className="rounded-lg bg-slate-800/30 p-3">
                                                        <p className="text-xs text-slate-500">Total Questions</p>
                                                        <p className="text-2xl font-semibold text-slate-200">{surveyTotal}</p>
                                                    </div>
                                                    <div className="rounded-lg bg-slate-800/30 p-3">
                                                        <p className="text-xs text-slate-500">Completed</p>
                                                        <p className="text-2xl font-semibold text-purple-400">{surveyCompleted}</p>
                                                    </div>
                                                    <div className="rounded-lg bg-slate-800/30 p-3">
                                                        <p className="text-xs text-slate-500">Current Score</p>
                                                        <p className="text-2xl font-semibold text-slate-200">
                                                            {surveyQuestions[surveyQuestions.length - 1].score}/5
                                                        </p>
                                                    </div>
                                                    <div className="rounded-lg bg-slate-800/30 p-3">
                                                        <p className="text-xs text-slate-500">Average Score</p>
                                                        <p className="text-2xl font-semibold text-slate-200">
                                                            {surveyQuestions.length > 0
                                                                ? (surveyQuestions.reduce((sum, q) => sum + q.score, 0) / surveyQuestions.length).toFixed(1)
                                                                : "0.0"}
                                                            /5
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {showDetailedReport && biometricSnapshots.length > 0 && (
                                            <div className="mt-4">
                                                <DetailedReport
                                                    snapshots={biometricSnapshots}
                                                    totalScore={biometricSnapshots.reduce((sum, s) => sum + s.score, 0)}
                                                    onClose={() => setShowDetailedReport(false)}
                                                    onAgentSpeaking={text => console.log("[App] Agent speaking:", text)}
                                                />
                                            </div>
                                        )}

                                        {!showDetailedReport && (
                                            <div className="mt-4 text-center text-sm text-slate-500">
                                                Complete the survey to view detailed burnout assessment results
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="flex h-full flex-col items-center justify-center text-center">
                                        <ClipboardList className="mb-3 h-12 w-12 text-slate-600" />
                                        <p className="text-sm text-slate-500">No assessment data</p>
                                        <p className="text-xs text-slate-600">Begin conversation to start the survey assessment</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                </div>
            </main>
        </div>
    );
}

export default App;
