import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { Mic, MicOff, Smile, Meh, Frown, ClipboardList, Play, Loader2, RotateCcw, Sun, Moon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { LoginScreen } from "@/components/ui/login-screen";
import { VideoPanel } from "@/components/ui/video-panel";
import { GazeIndicator, gazeLabel } from "@/components/ui/gaze-indicator";
import { ErrorBoundary } from "@/components/ui/error-boundary";
// Lazy-loaded so Recharts (heavy) is code-split out of the initial bundle and
// only fetched when a completed survey opens the report.
const DetailedReport = lazy(() => import("@/components/ui/detailed-report").then(m => ({ default: m.DetailedReport })));
import { AdminPanel } from "@/components/ui/admin-panel";
import { TestGenerator } from "@/components/ui/test-generator";
import { UserHistory } from "@/components/ui/user-history";
import { Button } from "@/components/ui/button";
import { apiFetch, setAuthExpiredHandler } from "@/lib/api";

import useRealTime from "@/hooks/useRealtime";
import useAudioRecorder from "@/hooks/useAudioRecorder";
import useAudioPlayer from "@/hooks/useAudioPlayer";
import { useBiometrics } from "@/hooks/useBiometrics";

import { SentimentUpdate, SurveyQuestion, SurveyOption, BiometricSnapshot, BiometricResult, SurveyTypeConfig, AuthUser, AuthState } from "./types";

import logo from "./assets/logo.png";

function App() {
    const [theme, setTheme] = useState<"light" | "dark">(() => {
        const saved = localStorage.getItem("ciq-theme");
        return saved === "dark" ? "dark" : "light";
    });
    const [authState, setAuthState] = useState<AuthState>("checking");
    const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
    // Session ID starts as a local UUID and is replaced with the server-issued one on login
    const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
    // Identifies a single survey run. A fresh id is minted for every new assessment so
    // each survey is persisted as its own history record instead of overwriting the last.
    const [surveyRunId, setSurveyRunId] = useState<string>(() => crypto.randomUUID());
    const [activeTab, setActiveTab] = useState<"assessment" | "admin" | "test" | "history">("assessment");
    const [isRecording, setIsRecording] = useState(false);
    const [sentiment, setSentiment] = useState<SentimentUpdate | null>(null);
    const [surveyQuestions, setSurveyQuestions] = useState<SurveyQuestion[]>([]);
    const [surveyTotal, setSurveyTotal] = useState(0);
    const [surveyCompleted, setSurveyCompleted] = useState(0);
    const [surveyOptions, setSurveyOptions] = useState<SurveyOption[]>([]);
    const [biometricSnapshots, setBiometricSnapshots] = useState<BiometricSnapshot[]>([]);
    const [showDetailedReport, setShowDetailedReport] = useState(false);
    // True once a survey has been fully answered. Gates the "start fresh" reset so a
    // new assessment only begins after completion — an in-progress survey resumes instead.
    const [assessmentComplete, setAssessmentComplete] = useState(false);
    const [enableSentiment, setEnableSentiment] = useState(false);
    const [enableSurvey, setEnableSurvey] = useState(false);
    const [surveyTypeConfig, setSurveyTypeConfig] = useState<SurveyTypeConfig | null>(null);
    const [enableBiometrics, setEnableBiometrics] = useState(true);
    const [isReasonExpanded, setIsReasonExpanded] = useState(false);

    const [stressResult, setStressResult] = useState<{ state: string; confidence: number; blink_rate_change_percent?: number; trend: string } | null>(null);

    // Real biometrics from MediaPipe face landmarker
    const {
        currentBiometrics,
        baselineSessionStatus,
        baselineData,
        baselineProgress,
        setVideoElement,
        startAnalysis: startBiometricAnalysis,
        stopAnalysis: stopBiometricAnalysis,
        startBaselineSession,
        clearBaseline
    } = useBiometrics();

    // Apply the active theme to <html> (drives the CSS theme tokens) and persist it.
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        // Also toggle the shadcn `.dark` class so Button/Card primitives follow the theme.
        document.documentElement.classList.toggle("dark", theme === "dark");
        localStorage.setItem("ciq-theme", theme);
    }, [theme]);

    // Check existing session cookie on mount
    useEffect(() => {
        fetch("/me", { credentials: "same-origin" })
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(data => {
                setCurrentUser({ user_id: data.user_id, name: "", session_id: data.session_id });
                setSessionId(data.session_id);
                setAuthState("authenticated");
            })
            .catch(() => setAuthState("unauthenticated"));
    }, []);

    // When any authenticated call returns 401 (e.g. the container was redeployed
    // and the ephemeral session store was wiped), drop back to the login screen
    // instead of leaving the UI looking signed-in with a dead "Session expired".
    useEffect(() => {
        setAuthExpiredHandler(() => {
            setShowDetailedReport(false);
            setIsRecording(false);
            setAuthState("unauthenticated");
        });
        return () => setAuthExpiredHandler(null);
    }, []);

    const handleLogin = useCallback((user: AuthUser) => {
        setCurrentUser(user);
        setSessionId(user.session_id);
        setAuthState("authenticated");
    }, []);

    const handleLogout = useCallback(async () => {
        await fetch("/logout", { method: "POST", credentials: "same-origin" });
        setActiveTab("assessment");
        setAuthState("unauthenticated");
        setCurrentUser(null);
        setSessionId(crypto.randomUUID());
    }, []);

    useEffect(() => {
        if (authState !== "authenticated") return;
        apiFetch("/config")
            .then(res => res.json())
            .then(data => {
                setEnableSentiment(data.enableSentimentAnalysis);
                setEnableSurvey(data.enableSurveyMode);
                setSurveyTypeConfig({
                    surveyTypeOverridden: data.surveyTypeOverridden ?? false,
                    activeSurveyType: data.activeSurveyType ?? "TEST",
                    availableSurveyTypes: data.availableSurveyTypes ?? ["TEST", "BATFULL", "CBTFULL"],
                });
            })
            .catch(err => console.error("Failed to fetch config:", err));
    }, [authState]);

    const handleSurveyTypeChange = useCallback(async (type: string) => {
        try {
            const res = await apiFetch("/survey-type", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ surveyType: type }),
            });
            if (res.ok) {
                const data = await res.json();
                setSurveyTypeConfig(prev => prev ? { ...prev, activeSurveyType: data.activeSurveyType } : prev);
            }
        } catch (err) {
            console.error("Failed to set survey type:", err);
        }
    }, []);

    // Baseline is loaded from localStorage by useBiometrics hook itself

    const { startSession, refreshSession, addUserAudio, inputAudioBufferClear } = useRealTime({
        sessionId,
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
            setBiometricSnapshots(prev => {
                // Deduplicate: if this questionId is already recorded, keep the existing entry.
                // This guards against the agent firing record_survey_response twice for the same question.
                const alreadyRecorded = prev.some(s => s.questionId === message.snapshot.questionId);
                if (alreadyRecorded) {
                    console.warn("[App] Duplicate snapshot for", message.snapshot.questionId, "— ignoring");
                    return prev;
                }
                return [...prev, message.snapshot];
            });
            setSurveyCompleted(message.completed);
            setSurveyTotal(message.total);
            if (message.completed === message.total) {
                setEnableBiometrics(false);
                setAssessmentComplete(true);
                setTimeout(() => setShowDetailedReport(true), 2000);
            }
        }
    });

    const handleBiometricsUpdate = useCallback(
        async (biometrics: BiometricResult) => {
            if (!enableBiometrics) return;

            const blinkChange = biometrics.metrics.blinkRateChangePercent;
            const blinkToSend = blinkChange !== undefined && blinkChange !== 0 ? blinkChange : 0;

            // Pupil dilation as mm change vs the calibrated baseline (CIQ thresholds use mm).
            const pupilMm = biometrics.metrics.pupilSizeMm;
            const basePupil = baselineData?.pupilSize ?? 0;
            const pupilMmChange = basePupil > 0 && pupilMm > 0 ? pupilMm - basePupil : 0;

            try {
                await apiFetch("/biometrics", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        session_id: sessionId,
                        sentiment: sentiment?.sentiment || "neutral",
                        blink_rate_change_percent: blinkToSend,
                        pupil_mm_change: pupilMmChange,
                        face_emotion: "NEUTRAL",
                        gaze_position: gazeLabel(biometrics.metrics.gaze)
                    })
                });
            } catch (err) {
                console.error("Failed to update biometrics:", err);
            }
        },
        [sentiment, enableBiometrics, sessionId, baselineData]
    );

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
                const response = await apiFetch("/analyze-stress", {
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

    // Forward real biometrics to backend whenever the hook produces a new result
    useEffect(() => {
        if (currentBiometrics?.faceDetected && enableBiometrics) {
            handleBiometricsUpdate(currentBiometrics);
        }
    }, [currentBiometrics, enableBiometrics, handleBiometricsUpdate]);

    // Start/stop MediaPipe analysis with recording
    useEffect(() => {
        if (isRecording && enableBiometrics) {
            startBiometricAnalysis();
        } else {
            stopBiometricAnalysis();
        }
    }, [isRecording, enableBiometrics, startBiometricAnalysis, stopBiometricAnalysis]);

    // Auto-start baseline when recording begins
    useEffect(() => {
        if (isRecording && enableBiometrics && baselineSessionStatus === "idle") {
            startBaselineSession();
        }
    }, [isRecording, enableBiometrics, baselineSessionStatus, startBaselineSession]);

    const { reset: resetAudioPlayer, play: playAudio, stop: stopAudioPlayer } = useAudioPlayer();
    const { start: startAudioRecording, stop: stopAudioRecording } = useAudioRecorder({ onAudioRecorded: addUserAudio });

    // Clear all per-assessment UI state so a new run starts from a clean slate.
    // Crucially re-enables biometrics, which is switched off when a survey completes.
    const resetAssessmentState = useCallback(() => {
        setBiometricSnapshots([]);
        setSurveyQuestions([]);
        setSurveyCompleted(0);
        setSurveyTotal(0);
        setSurveyOptions([]);
        setShowDetailedReport(false);
        setSentiment(null);
        setStressResult(null);
        setEnableBiometrics(true);
        // Each fresh assessment is a new persisted survey record.
        setSurveyRunId(crypto.randomUUID());
    }, []);

    const onToggleListening = async () => {
        if (!isRecording) {
            // Only begin a brand-new assessment when the previous survey actually
            // COMPLETED. We fully reset the SAME backend session (clears survey_results,
            // conversation_state and the reconnect counter) and await it before
            // reconnecting the agent. Resetting server-side on the same session_id is
            // deterministic — unlike swapping the id and racing a WebSocket reconnect.
            // A survey still in progress (mic toggled off mid-way) is left untouched so
            // it resumes.
            if (assessmentComplete) {
                try {
                    await apiFetch("/clear-conversation", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ session_id: sessionId })
                    });
                } catch (err) {
                    console.error("Failed to reset session for new assessment:", err);
                }
                resetAssessmentState();
                setAssessmentComplete(false);
            }

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
        startBaselineSession();
    }, [startBaselineSession]);

    const handleProceedWithoutBaseline = useCallback(() => {
        // Skip baseline — hook treats missing baseline as "completed with no reference"
        startBaselineSession();
    }, [startBaselineSession]);

    const handleRerecordBaseline = useCallback(() => {
        clearBaseline();
    }, [clearBaseline]);

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
                return "text-[color:var(--ciq-accent-red)]";
            case "relaxed":
                return "text-[color:var(--ciq-accent-green)]";
            default:
                return "text-[color:var(--ciq-accent-amber)]";
        }
    };

    const getStressBgColor = (state: string) => {
        switch (state) {
            case "stressed":
                return "bg-[rgba(255,50,50,0.08)] border-[rgba(255,50,50,0.25)]";
            case "relaxed":
                return "bg-[rgba(64,212,136,0.08)] border-[rgba(64,212,136,0.25)]";
            default:
                return "bg-[rgba(228,180,109,0.08)] border-[rgba(228,180,109,0.25)]";
        }
    };

    const { t } = useTranslation();

    if (authState === "checking") {
        return (
            <div className="flex min-h-screen items-center justify-center ciq-page">
                <p className="text-sm text-[color:var(--ciq-text-60)]">Loading…</p>
            </div>
        );
    }

    if (authState === "unauthenticated") {
        return <LoginScreen onLogin={handleLogin} />;
    }

    return (
        <div className="flex min-h-screen flex-col ciq-page text-[color:var(--ciq-text-strong)]">
            {/* ── Floating pill header ── */}
            <div className="sticky top-0 z-40 px-5 pb-2 pt-4">
                <div className="flex items-center justify-between rounded-[40px] border border-[color:var(--ciq-border)] bg-[color:var(--ciq-header-bg)] px-6 py-3 shadow-[0_30px_100px_rgba(0,0,0,0.42),inset_0_1px_1px_rgba(255,255,255,0.22)] saturate-150 backdrop-blur-[34px]">
                    <div className="flex items-center gap-3">
                        <img src={logo} alt="CIQ logo" className="ciq-logo h-10 w-10" />
                        <div>
                            <h1 className="text-lg font-bold tracking-tight text-[color:var(--ciq-text-strong)]">CIQ Voice Agent</h1>
                            <p className="text-xs text-[color:var(--ciq-text-46)]">Burnout Assessment Platform</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {enableSentiment && (
                            <div className="flex items-center gap-1.5 rounded-full bg-[color:var(--ciq-tile-strong)] px-3 py-1.5 text-xs font-medium text-[color:var(--ciq-accent-green)]">
                                <Smile className="h-3.5 w-3.5" />
                                Sentiment
                            </div>
                        )}
                        {enableSurvey && (
                            <div className="flex items-center gap-1.5 rounded-full bg-[color:var(--ciq-tile-strong)] px-3 py-1.5 text-xs font-medium text-[color:var(--ciq-accent-purple)]">
                                <ClipboardList className="h-3.5 w-3.5" />
                                Survey
                            </div>
                        )}
                        {!isRecording && <span className="rounded-full bg-[color:var(--ciq-tile-strong)] px-3 py-1.5 text-xs font-medium text-[color:var(--ciq-text-68)]">Ready</span>}
                        <button
                            onClick={() => setTheme(prev => (prev === "light" ? "dark" : "light"))}
                            aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
                            title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--ciq-tile-strong)] text-[color:var(--ciq-text-68)] transition-colors hover:bg-[color:var(--ciq-hover)]"
                        >
                            {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                        </button>
                        <div className="flex items-center gap-2 border-l border-[color:var(--ciq-divider)] pl-3">
                            <span className="text-xs text-[color:var(--ciq-text-60)]">{currentUser?.name}</span>
                            <button
                                onClick={handleLogout}
                                className="rounded-full bg-[color:var(--ciq-tile-strong)] px-3 py-1.5 text-xs font-medium text-[color:var(--ciq-text-68)] transition-colors hover:bg-[color:var(--ciq-hover)]"
                            >
                                Sign Out
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Tab Bar ── */}
            <div className="flex items-center gap-2 px-5 py-3">
                <button
                    onClick={() => setActiveTab("assessment")}
                    className={`transition-all ${
                        activeTab === "assessment"
                            ? "rounded-full border border-black/[0.20] bg-white/80 px-8 py-2 text-sm font-semibold text-[#1a1a1a] shadow-[0_18px_46px_rgba(0,0,0,0.10),inset_0_1px_1px_rgba(255,255,255,0.80)]"
                            : "px-6 py-2 text-sm font-medium text-[color:var(--ciq-text-60)] hover:text-[color:var(--ciq-text-86)]"
                    }`}
                >
                    Assessment
                </button>
                <button
                    onClick={() => setActiveTab("admin")}
                    className={`transition-all ${
                        activeTab === "admin"
                            ? "rounded-full border border-black/[0.20] bg-white/80 px-8 py-2 text-sm font-semibold text-[#1a1a1a] shadow-[0_18px_46px_rgba(0,0,0,0.10),inset_0_1px_1px_rgba(255,255,255,0.80)]"
                            : "px-6 py-2 text-sm font-medium text-[color:var(--ciq-text-60)] hover:text-[color:var(--ciq-text-86)]"
                    }`}
                >
                    Admin
                </button>
                <button
                    onClick={() => setActiveTab("test")}
                    className={`transition-all ${
                        activeTab === "test"
                            ? "rounded-full border border-black/[0.20] bg-white/80 px-8 py-2 text-sm font-semibold text-[#1a1a1a] shadow-[0_18px_46px_rgba(0,0,0,0.10),inset_0_1px_1px_rgba(255,255,255,0.80)]"
                            : "px-6 py-2 text-sm font-medium text-[color:var(--ciq-text-60)] hover:text-[color:var(--ciq-text-86)]"
                    }`}
                >
                    Test Generator
                </button>
                <button
                    onClick={() => setActiveTab("history")}
                    className={`transition-all ${
                        activeTab === "history"
                            ? "rounded-full border border-black/[0.20] bg-white/80 px-8 py-2 text-sm font-semibold text-[#1a1a1a] shadow-[0_18px_46px_rgba(0,0,0,0.10),inset_0_1px_1px_rgba(255,255,255,0.80)]"
                            : "px-6 py-2 text-sm font-medium text-[color:var(--ciq-text-60)] hover:text-[color:var(--ciq-text-86)]"
                    }`}
                >
                    History
                </button>
            </div>

            {/* ── Admin Panel ── */}
            {activeTab === "admin" && (
                <div className="flex-1 overflow-y-auto">
                    <AdminPanel />
                </div>
            )}

            {/* ── Test Generator ── */}
            {activeTab === "test" && (
                <div className="flex-1 overflow-y-auto">
                    <TestGenerator />
                </div>
            )}

            {/* ── User History ── */}
            {activeTab === "history" && (
                <div className="flex-1 overflow-y-auto">
                    <UserHistory />
                </div>
            )}

            {/* ── Assessment Panel ── */}
            {activeTab === "assessment" && (
                <main className="flex flex-1 overflow-hidden p-4">
                    <div className="grid h-full w-full grid-cols-2 grid-rows-3 gap-4">
                        {/* Camera Feed Panel - Top Left */}
                        <section className="ciq-glass-card">
                            <div className="flex h-full flex-col">
                                <div className="border-[color:var(--ciq-divider)] border-b px-5 py-3">
                                    <div className="flex items-center gap-2">
                                        <div className="h-2 w-2 rounded-full bg-green-500 ring-2 ring-green-500/30"></div>
                                        <h2 className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">Camera Feed</h2>
                                        <span className="ml-auto rounded-full bg-[color:var(--ciq-tile-strong)] px-2 py-0.5 text-[10px] font-semibold tracking-widest text-[color:var(--ciq-text-60)]">
                                            LIVE
                                        </span>
                                    </div>
                                </div>
                                <div className="flex-1 p-4">
                                    <VideoPanel
                                        isRecording={isRecording}
                                        surveyQuestions={surveyQuestions}
                                        surveyTotal={surveyTotal}
                                        surveyCompleted={surveyCompleted}
                                        surveyOptions={surveyOptions}
                                        onVideoReady={setVideoElement}
                                    />
                                </div>
                                <div className="border-[color:var(--ciq-divider)] border-t px-5 py-4">
                                    <div className="flex flex-col gap-2">
                                        {enableSurvey && surveyTypeConfig && (
                                            <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3">
                                                <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[color:var(--ciq-text-60)]">Survey Type</p>
                                                {surveyTypeConfig.surveyTypeOverridden ? (
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs text-[color:var(--ciq-text-strong)]">{surveyTypeConfig.activeSurveyType}</span>
                                                        <span className="text-[9px] text-[color:var(--ciq-text-40)]">(locked by deployment)</span>
                                                    </div>
                                                ) : (
                                                    <div className="flex gap-2">
                                                        {surveyTypeConfig.availableSurveyTypes.map(type => (
                                                            <button
                                                                key={type}
                                                                onClick={() => handleSurveyTypeChange(type)}
                                                                disabled={isRecording}
                                                                className={`rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                                                                    surveyTypeConfig.activeSurveyType === type
                                                                        ? "bg-[#5ee5a1] text-[#0d1a14]"
                                                                        : "bg-[color:var(--ciq-tile-strong)] text-[color:var(--ciq-text-68)] hover:bg-[color:var(--ciq-hover)]"
                                                                }`}
                                                            >
                                                                {type}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <Button
                                            onClick={onToggleListening}
                                            className={`group relative flex h-11 w-full items-center justify-center gap-2.5 rounded-xl text-sm font-semibold transition-all duration-300 ${
                                                isRecording
                                                    ? "border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] text-[color:var(--ciq-text-68)] hover:bg-[color:var(--ciq-hover)]"
                                                    : "bg-gradient-to-r from-purple-600 to-pink-600 shadow-lg shadow-purple-500/20 hover:from-purple-500 hover:to-pink-500"
                                            }`}
                                        >
                                            {isRecording ? (
                                                <>
                                                    <MicOff className="h-4 w-4" />
                                                    {t("app.stopConversation")}
                                                </>
                                            ) : (
                                                <>
                                                    <Mic className="h-4 w-4" />
                                                    {t("app.startRecording") || "Start Conversation"}
                                                </>
                                            )}
                                        </Button>
                                        {/* Always reserve this row's height so toggling the
                                            badge never reflows the flex-1 video above it. */}
                                        {isRecording ? (
                                            <div className="flex h-10 items-center justify-center gap-2 rounded-xl border border-[rgba(25,122,75,0.40)] bg-[rgba(25,122,75,0.20)] text-sm font-medium text-[color:var(--ciq-accent-green)]">
                                                <Mic className="h-4 w-4 animate-pulse" />
                                                Conversation Active
                                            </div>
                                        ) : (
                                            <div className="h-10" aria-hidden="true" />
                                        )}
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Face Emotion & Sentiment Panel - Top Right */}
                        <section className="ciq-glass-card">
                            <div className="flex h-full flex-col">
                                <div className="border-b border-[color:var(--ciq-divider)] px-5 py-3">
                                    <h2 className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">Voice Sentiment</h2>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4">
                                    <div className="grid grid-cols-1 gap-2">
                                        {/* Voice Sentiment */}
                                        {sentiment && (
                                            <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] px-3 py-2">
                                                <div className="flex items-start justify-between gap-2">
                                                    <div className="flex shrink-0 items-center gap-2">
                                                        {sentiment.sentiment === "positive" && (
                                                            <div className="flex h-7 w-7 items-center justify-center rounded bg-green-500/20">
                                                                <Smile className="h-3.5 w-3.5 text-[color:var(--ciq-accent-green)]" />
                                                            </div>
                                                        )}
                                                        {sentiment.sentiment === "neutral" && (
                                                            <div className="flex h-7 w-7 items-center justify-center rounded bg-yellow-500/20">
                                                                <Meh className="h-3.5 w-3.5 text-[color:var(--ciq-accent-amber)]" />
                                                            </div>
                                                        )}
                                                        {sentiment.sentiment === "negative" && (
                                                            <div className="flex h-7 w-7 items-center justify-center rounded bg-red-500/20">
                                                                <Frown className="h-3.5 w-3.5 text-[color:var(--ciq-accent-red)]" />
                                                            </div>
                                                        )}
                                                        <div>
                                                            <p className="text-[10px] font-semibold capitalize text-[color:var(--ciq-text-strong)]">{sentiment.sentiment}</p>
                                                            <button
                                                                onClick={() => setIsReasonExpanded(!isReasonExpanded)}
                                                                className="mt-1 cursor-pointer text-[9px] text-[color:var(--ciq-text-60)] hover:text-[color:var(--ciq-text-86)] focus:outline-none"
                                                            >
                                                                {isReasonExpanded ? "Show less" : "Show reason"}
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                                {sentiment.reason && isReasonExpanded && (
                                                    <div className="mt-2 rounded-lg bg-[color:var(--ciq-tile)] p-2">
                                                        <p className="text-[10px] leading-relaxed text-[color:var(--ciq-text-86)]">{sentiment.reason}</p>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Baseline Prompt UI */}
                                    {isRecording && baselineSessionStatus === "idle" && enableBiometrics && (
                                        <div className="mb-4 rounded-lg border border-[rgba(116,212,255,0.25)] bg-[rgba(116,212,255,0.06)] p-4">
                                            <h3 className="text-md mb-2 font-semibold text-[color:var(--ciq-text-strong)]">Baseline Measurement Required</h3>
                                            <p className="mb-4 text-sm text-[color:var(--ciq-text-strong)]">
                                                To measure biometric changes during conversation, we need to record a baseline measurement first. Please look at
                                                the camera for 30 seconds while we record your baseline pupil size and blink rate.
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
                                        <div className="mb-4 rounded-lg border border-[rgba(116,212,255,0.25)] bg-[rgba(116,212,255,0.06)] p-4">
                                            <div className="mb-3 flex items-center justify-center">
                                                <Loader2 className="mr-2 h-6 w-6 animate-spin text-[color:var(--ciq-accent-blue)]" />
                                                <span className="text-[color:var(--ciq-accent-blue)]">Recording baseline...</span>
                                            </div>
                                            <div className="h-2 w-full rounded-full bg-[#2a3830]">
                                                <div
                                                    className="h-2 rounded-full bg-blue-500 transition-all duration-100"
                                                    style={{ width: `${baselineProgress}%` }}
                                                />
                                            </div>
                                            <p className="mt-2 text-center text-sm text-[color:var(--ciq-text-68)]">
                                                {Math.round((baselineProgress / 100) * 30)} / 30 seconds
                                            </p>
                                        </div>
                                    )}

                                    {/* Baseline Completed */}
                                    {baselineSessionStatus === "completed" && baselineData && (
                                        <div className="mb-3 rounded-lg border border-[rgba(64,212,136,0.25)] bg-[rgba(64,212,136,0.06)] p-2">
                                            <div className="flex items-center justify-between">
                                                <p className="text-xs font-medium text-[color:var(--ciq-accent-green)]">Baseline Recorded</p>
                                                <Button onClick={handleRerecordBaseline} size="sm" variant="outline" className="h-6 px-2 text-[10px]">
                                                    <RotateCcw className="mr-1 h-3 w-3" />
                                                    Rerecord
                                                </Button>
                                            </div>
                                            <div className="mt-1 flex items-center gap-3 text-[10px]">
                                                <div className="flex items-center gap-1">
                                                    <span className="text-[color:var(--ciq-text-68)]">Pupil:</span>
                                                    <span className="text-[color:var(--ciq-text-strong)]">{baselineData.pupilSize.toFixed(1)} mm</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <span className="text-[color:var(--ciq-text-68)]">Blink:</span>
                                                    <span className="text-[color:var(--ciq-text-strong)]">{baselineData.blinkRate.toFixed(1)}/min</span>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Biometric Metrics */}
                                    {currentBiometrics && currentBiometrics.faceDetected && isRecording && (
                                        <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-2">
                                            <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[color:var(--ciq-text-60)]">
                                                Biometric Metrics
                                            </h3>
                                            <div className="grid grid-cols-3 gap-1">
                                                <div className="rounded-lg bg-[color:var(--ciq-tile)] p-1.5">
                                                    <p className="text-[9px] text-[color:var(--ciq-text-60)]">Blink Rate</p>
                                                    <p className="text-xs font-semibold text-[color:var(--ciq-text-strong)]">{currentBiometrics.metrics.blinkRate.toFixed(1)}/min</p>
                                                    <p className="text-[9px] text-[color:var(--ciq-accent-green)]">Base: {baselineData?.blinkRate.toFixed(1) || "--"}</p>
                                                </div>
                                                <div className="rounded-lg bg-[color:var(--ciq-tile)] p-1.5">
                                                    <p className="text-[9px] text-[color:var(--ciq-text-60)]">Eye Openness</p>
                                                    <p className="text-xs font-semibold text-[color:var(--ciq-text-strong)]">
                                                        {formatMetric(currentBiometrics.metrics.eyeOpenness)}
                                                    </p>
                                                </div>
                                                <div className="rounded-lg bg-[color:var(--ciq-tile)] p-1.5">
                                                    <p className="text-[9px] text-[color:var(--ciq-text-60)]">Smile</p>
                                                    <p className="text-xs font-semibold text-[color:var(--ciq-text-strong)]">
                                                        {formatMetric(currentBiometrics.metrics.smileIntensity)}
                                                    </p>
                                                </div>
                                                <div className="rounded-lg bg-[color:var(--ciq-tile)] p-1.5">
                                                    <p className="text-[9px] text-[color:var(--ciq-text-60)]">Head Pose</p>
                                                    <p className="text-xs font-semibold text-[color:var(--ciq-text-strong)]">
                                                        {getHeadPoseLabel(currentBiometrics.metrics.headPose.yaw)}
                                                    </p>
                                                </div>
                                                <div className="rounded-lg bg-[color:var(--ciq-tile)] p-1.5">
                                                    <p className="text-[9px] text-[color:var(--ciq-text-60)]">Pupil Size</p>
                                                    <p className="text-xs font-semibold text-[color:var(--ciq-text-strong)]">
                                                        {currentBiometrics.metrics.pupilSizeMm.toFixed(1)} mm
                                                    </p>
                                                    <p className="text-[9px] text-[color:var(--ciq-accent-green)]">Base: {baselineData?.pupilSize.toFixed(1) || "--"}</p>
                                                </div>
                                                <div className="rounded-lg bg-[color:var(--ciq-tile)] p-1.5">
                                                    <p className="text-[9px] text-[color:var(--ciq-text-60)]">Blink Change</p>
                                                    <p
                                                        className={`text-xs font-semibold ${currentBiometrics.metrics.blinkRateChangePercent >= 0 ? "text-[color:var(--ciq-accent-red)]" : "text-[color:var(--ciq-accent-green)]"}`}
                                                    >
                                                        {currentBiometrics.metrics.blinkRateChangePercent >= 0 ? "+" : ""}
                                                        {currentBiometrics.metrics.blinkRateChangePercent.toFixed(1)}%
                                                    </p>
                                                </div>
                                                <div className="rounded-lg bg-[color:var(--ciq-tile)] p-1.5">
                                                    <p className="text-[9px] text-[color:var(--ciq-text-60)]">Gaze</p>
                                                    <GazeIndicator gaze={currentBiometrics.metrics.gaze} />
                                                    <p className="text-[9px] text-[color:var(--ciq-text-strong)]">{gazeLabel(currentBiometrics.metrics.gaze)}</p>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Stress Analysis */}
                                    {stressResult && isRecording && (
                                        <div className={`mt-3 rounded-lg border p-2 ${getStressBgColor(stressResult.state)}`}>
                                            <div className="flex items-center justify-between">
                                                <h4 className="text-xs font-semibold text-[color:var(--ciq-text-strong)]">Blink Rate Stress</h4>
                                                <span className={`text-[10px] font-medium ${getStressColor(stressResult.state)}`}>
                                                    {stressResult.state.toUpperCase()}
                                                </span>
                                            </div>
                                            <div className="mt-1 flex items-center gap-3 text-[10px]">
                                                <div className="flex items-center gap-1">
                                                    <span className="text-[color:var(--ciq-text-68)]">State:</span>
                                                    <span className={`font-medium ${getStressColor(stressResult.state)}`}>{stressResult.state}</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <span className="text-[color:var(--ciq-text-68)]">Change:</span>
                                                    <span
                                                        className={`font-medium ${(stressResult.blink_rate_change_percent || 0) >= 0 ? "text-[color:var(--ciq-accent-red)]" : "text-[color:var(--ciq-accent-green)]"}`}
                                                    >
                                                        {(stressResult.blink_rate_change_percent || 0) >= 0 ? "+" : ""}
                                                        {stressResult.blink_rate_change_percent?.toFixed(1) || "0.0"}%
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <span className="text-[color:var(--ciq-text-68)]">Conf:</span>
                                                    <span className="text-[color:var(--ciq-text-strong)]">{(stressResult.confidence * 100).toFixed(0)}%</span>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <span className="text-[color:var(--ciq-text-68)]">Trend:</span>
                                                    <span
                                                        className={`font-medium ${
                                                            stressResult.trend === "increasing"
                                                                ? "text-[color:var(--ciq-accent-red)]"
                                                                : stressResult.trend === "decreasing"
                                                                  ? "text-[color:var(--ciq-accent-green)]"
                                                                  : "text-[color:var(--ciq-accent-amber)]"
                                                        }`}
                                                    >
                                                        {stressResult.trend}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                </div>
                            </div>
                        </section>

                        {/* Final Results Panel - Burnout Assessment (spans 2 columns, row 3) */}
                        <section className="ciq-glass-card col-span-2">
                            <div className="flex h-full flex-col">
                                <div className="border-b border-[color:var(--ciq-divider)] px-5 py-3">
                                    <h2 className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">Final Results - Burnout Assessment</h2>
                                </div>
                                <div className="flex-1 overflow-y-auto p-4">
                                    {surveyTotal > 0 ? (
                                        <>
                                            <div className="mb-4">
                                                <div className="mb-2 flex justify-between text-xs text-[color:var(--ciq-text-60)]">
                                                    <span>Overall Assessment Progress</span>
                                                    <span>{Math.round((surveyCompleted / surveyTotal) * 100)}%</span>
                                                </div>
                                                <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--ciq-track)]">
                                                    <div
                                                        className="h-full rounded-full bg-gradient-to-r from-purple-600 to-pink-500 transition-all duration-500"
                                                        style={{ width: `${(surveyCompleted / surveyTotal) * 100}%` }}
                                                    />
                                                </div>
                                            </div>

                                            {surveyQuestions.length > 0 && (
                                                <div className="mb-4">
                                                    <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[color:var(--ciq-text-60)]">
                                                        Assessment Summary
                                                    </h3>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <div className="rounded-lg bg-[color:var(--ciq-tile)] p-3">
                                                            <p className="text-xs text-[color:var(--ciq-text-60)]">Total Questions</p>
                                                            <p className="text-2xl font-semibold text-[color:var(--ciq-text-strong)]">{surveyTotal}</p>
                                                        </div>
                                                        <div className="rounded-lg bg-[color:var(--ciq-tile)] p-3">
                                                            <p className="text-xs text-[color:var(--ciq-text-60)]">Completed</p>
                                                            <p className="text-2xl font-semibold text-[color:var(--ciq-accent-purple)]">{surveyCompleted}</p>
                                                        </div>
                                                        <div className="rounded-lg bg-[color:var(--ciq-tile)] p-3">
                                                            <p className="text-xs text-[color:var(--ciq-text-60)]">Current Score</p>
                                                            <p className="text-2xl font-semibold text-[color:var(--ciq-text-strong)]">
                                                                {surveyQuestions[surveyQuestions.length - 1].score}/5
                                                            </p>
                                                        </div>
                                                        <div className="rounded-lg bg-[color:var(--ciq-tile)] p-3">
                                                            <p className="text-xs text-[color:var(--ciq-text-60)]">Average Score</p>
                                                            <p className="text-2xl font-semibold text-[color:var(--ciq-text-strong)]">
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
                                                    <ErrorBoundary label="report">
                                                        <Suspense
                                                            fallback={
                                                                <div className="flex items-center justify-center gap-2 py-10 text-sm text-[color:var(--ciq-text-60)]">
                                                                    <Loader2 className="h-4 w-4 animate-spin" /> Building your report…
                                                                </div>
                                                            }
                                                        >
                                                            <DetailedReport
                                                                snapshots={biometricSnapshots}
                                                                sessionId={sessionId}
                                                                surveyRunId={surveyRunId}
                                                                surveyType={surveyTypeConfig?.activeSurveyType}
                                                                onClose={() => setShowDetailedReport(false)}
                                                                onAgentSpeaking={text => console.log("[App] Agent speaking:", text)}
                                                                onReportDelivered={refreshSession}
                                                            />
                                                        </Suspense>
                                                    </ErrorBoundary>
                                                </div>
                                            )}

                                            {!showDetailedReport && (
                                                <div className="mt-4 text-center text-sm text-[color:var(--ciq-text-60)]">
                                                    Complete the survey to view detailed burnout assessment results
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="flex h-full flex-col items-center justify-center text-center">
                                            <ClipboardList className="mb-3 h-12 w-12 text-[color:var(--ciq-text-40)]" />
                                            <p className="text-sm text-[color:var(--ciq-text-60)]">No assessment data</p>
                                            <p className="text-xs text-[color:var(--ciq-text-40)]">Begin conversation to start the survey assessment</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </section>
                    </div>
                </main>
            )}
        </div>
    );
}

export default App;
