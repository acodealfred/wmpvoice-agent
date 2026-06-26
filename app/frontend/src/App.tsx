import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { Mic, MicOff, Smile, Meh, Frown, ClipboardList, Play, Loader2, RotateCcw, Sun, Moon, Droplets, Check, ChevronDown, Activity, Maximize2, Minimize2, Bot, Video } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LoginScreen } from "@/components/ui/login-screen";
import { VideoPanel } from "@/components/ui/video-panel";
import { GazeIndicator, gazeLabel } from "@/components/ui/gaze-indicator";
import { CyberAvatar } from "@/components/ui/cyber-avatar";
import { ErrorBoundary } from "@/components/ui/error-boundary";
// Lazy-loaded so Recharts (heavy) is code-split out of the initial bundle and
// only fetched when a completed survey opens the report.
const DetailedReport = lazy(() => import("@/components/ui/detailed-report").then(m => ({ default: m.DetailedReport })));
import { AdminPanel } from "@/components/ui/admin-panel";
import { TestGenerator } from "@/components/ui/test-generator";
import { UserHistory } from "@/components/ui/user-history";
import { ManagerLanding } from "@/components/ui/manager-landing";
import { Button } from "@/components/ui/button";
import { apiFetch, setAuthExpiredHandler } from "@/lib/api";
import { applyFontScale, getFontScale } from "@/lib/fontScale";

import useRealTime from "@/hooks/useRealtime";
import useAudioRecorder from "@/hooks/useAudioRecorder";
import useAudioPlayer from "@/hooks/useAudioPlayer";
import { useBiometrics } from "@/hooks/useBiometrics";

import { SentimentUpdate, SurveyQuestion, SurveyOption, BiometricSnapshot, BiometricResult, SurveyTypeConfig, AuthUser, AuthState } from "./types";

import logo from "./assets/logo.png";

const NAV_TABS = [
    { id: "dashboard",  label: "Dashboard",      adminOnly: false, managerOnly: true  },
    { id: "assessment", label: "Assessment",      adminOnly: false, managerOnly: false },
    { id: "admin",      label: "Admin",           adminOnly: true,  managerOnly: false },
    { id: "test",       label: "Test Generator",  adminOnly: true,  managerOnly: false },
    { id: "history",    label: "History",         adminOnly: false, managerOnly: false },
] as const;

type ThemeMode = "light" | "dark" | "ocean";
const THEME_OPTIONS: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
    { id: "light", label: "Light", icon: Sun },
    { id: "dark", label: "Dark", icon: Moon },
    { id: "ocean", label: "Ocean", icon: Droplets },
];

function App() {
    const [theme, setTheme] = useState<"light" | "dark" | "ocean">(() => {
        const saved = localStorage.getItem("ciq-theme");
        return saved === "dark" || saved === "ocean" ? saved : "light";
    });
    const [themeMenuOpen, setThemeMenuOpen] = useState(false);
    const [authState, setAuthState] = useState<AuthState>("checking");
    const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
    // Session ID starts as a local UUID and is replaced with the server-issued one on login
    const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
    // Identifies a single survey run. A fresh id is minted for every new assessment so
    // each survey is persisted as its own history record instead of overwriting the last.
    const [surveyRunId, setSurveyRunId] = useState<string>(() => crypto.randomUUID());
    const [activeTab, setActiveTab] = useState<"dashboard" | "assessment" | "admin" | "test" | "history">("assessment");
    const isAdmin = currentUser?.role === "admin";
    const isManager = currentUser?.role === "manager";
    const [isRecording, setIsRecording] = useState(false);
    const [sentiment, setSentiment] = useState<SentimentUpdate | null>(null);
    const [surveyQuestions, setSurveyQuestions] = useState<SurveyQuestion[]>([]);
    const [surveyTotal, setSurveyTotal] = useState(0);
    const [surveyCompleted, setSurveyCompleted] = useState(0);
    const [surveyOptions, setSurveyOptions] = useState<SurveyOption[]>([]);
    const [biometricSnapshots, setBiometricSnapshots] = useState<BiometricSnapshot[]>([]);
    const [showDetailedReport, setShowDetailedReport] = useState(false);
    // True from survey completion until the report has finished post-processing
    // (POST /analyze-report) — drives the in-panel "Generating your report…" loader.
    const [reportLoading, setReportLoading] = useState(false);
    // True once a survey has been fully answered. Gates the "start fresh" reset so a
    // new assessment only begins after completion — an in-progress survey resumes instead.
    const [assessmentComplete, setAssessmentComplete] = useState(false);
    // Set when the report has been saved; consumed on the next response.done to force a
    // clean reconnect so the agent answers follow-ups strictly from the saved report
    // (wipes Azure's survey conversation memory) without cutting off its spoken result.
    const pendingGuardrailResetRef = useRef(false);
    // Raised while a reset reconnect is in flight (Start New Survey / post-report hard reset).
    // Drops stale response.audio.delta chunks from the OLD turn so the agent doesn't keep
    // speaking the previous sentence over the fresh session. Lifted on the next session.created.
    const suppressAgentAudioRef = useRef(false);
    const [enableSurvey, setEnableSurvey] = useState(false);
    const [surveyTypeConfig, setSurveyTypeConfig] = useState<SurveyTypeConfig | null>(null);
    const [enableBiometrics, setEnableBiometrics] = useState(true);
    const [isReasonExpanded, setIsReasonExpanded] = useState(false);
    // Toggles the camera feed between compact (centered, max-width) and full card width.
    const [videoExpanded, setVideoExpanded] = useState(false);
    // Camera feed vs. the audio-reactive agent avatar. The camera keeps running
    // underneath in avatar mode so biometric capture is never interrupted.
    const [cameraView, setCameraView] = useState<"camera" | "avatar">("camera");
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
        clearBaseline,
        setBaseline
    } = useBiometrics();
    // Armed when a fresh baseline recording is started because the user had none on
    // the server — the recording is persisted to the DB once it completes.
    const baselineNeedsSaveRef = useRef(false);

    // Apply the active theme to <html> (drives the CSS theme tokens) and persist it.
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        // Toggle the shadcn `.dark` class for any dark-ish theme so Button/Card
        // primitives follow along (both "dark" and "ocean" are dark surfaces).
        document.documentElement.classList.toggle("dark", theme !== "light");
        localStorage.setItem("ciq-theme", theme);
    }, [theme]);

    // Apply the persisted text-size preference (set from the Admin tab) on load.
    useEffect(() => {
        applyFontScale(getFontScale());
    }, []);

    // Check existing session cookie on mount
    useEffect(() => {
        fetch("/me", { credentials: "same-origin" })
            .then(r => (r.ok ? r.json() : Promise.reject()))
            .then(data => {
                setCurrentUser({ user_id: data.user_id, name: "", session_id: data.session_id, role: data.role });
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

    // Defensive: fall back to a permitted tab when the current role can't see the active one.
    useEffect(() => {
        const tab = NAV_TABS.find(t => t.id === activeTab);
        if (!tab) return;
        if (tab.adminOnly && !isAdmin) setActiveTab("assessment");
        else if (tab.managerOnly && !isManager) setActiveTab("assessment");
    }, [activeTab, isAdmin, isManager]);

    const handleLogin = useCallback((user: AuthUser) => {
        setCurrentUser(user);
        setSessionId(user.session_id);
        setAuthState("authenticated");
        if (user.role === "manager") setActiveTab("dashboard");
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
                setEnableSurvey(data.enableSurveyMode);
                setSurveyTypeConfig({
                    surveyTypeOverridden: data.surveyTypeOverridden ?? false,
                    activeSurveyType: data.activeSurveyType ?? "TEST",
                    availableSurveyTypes: data.availableSurveyTypes ?? ["TEST", "BATFULL", "CBTFULL"]
                });
            })
            .catch(err => console.error("Failed to fetch config:", err));
    }, [authState]);

    const handleSurveyTypeChange = useCallback(async (type: string) => {
        try {
            const res = await apiFetch("/survey-type", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ surveyType: type })
            });
            if (res.ok) {
                const data = await res.json();
                setSurveyTypeConfig(prev => (prev ? { ...prev, activeSurveyType: data.activeSurveyType } : prev));
            }
        } catch (err) {
            console.error("Failed to set survey type:", err);
        }
    }, []);

    // Baseline is loaded from localStorage by useBiometrics hook itself

    const { startSession, requestGreeting, reconnect, refreshSession, addUserAudio, inputAudioBufferClear } = useRealTime({
        sessionId,
        onWebSocketOpen: () => console.log("WebSocket connection opened"),
        onWebSocketClose: () => console.log("WebSocket connection closed"),
        onWebSocketError: event => console.error("WebSocket error:", event),
        onReceivedError: message => console.error("error", message),
        onReceivedResponseDone: () => {
            // The report was just saved — perform the strict report-only hard reset now
            // that the agent has finished its current turn (so we don't cut off speech).
            if (pendingGuardrailResetRef.current) {
                pendingGuardrailResetRef.current = false;
                console.log("[App] Report saved — reconnecting for strict report-only Q&A");
                suppressAgentAudioRef.current = true;
                reconnect();
            }
        },
        onReceivedResponseAudioDelta: message => {
            // Ignore audio from the old session while a reset reconnect is settling.
            if (suppressAgentAudioRef.current) return;
            isRecording && playAudio(message.delta);
        },
        onReceivedSessionReady: () => {
            // Fresh session is live — let the new agent be heard again.
            suppressAgentAudioRef.current = false;
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
                // Show the in-panel loader and mount DetailedReport immediately so it fires
                // POST /analyze-report (which post-processes + persists). The loader is cleared
                // and the full report revealed once that resolves (handleReportReady).
                setReportLoading(true);
                setShowDetailedReport(true);
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

    // Stress analysis effect — polls /analyze-stress off the live blink rate.
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

    const { reset: resetAudioPlayer, play: playAudio, stop: stopAudioPlayer, getAnalyser: getAudioAnalyser } = useAudioPlayer();
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
        setReportLoading(false);
        setSentiment(null);
        setStressResult(null);
        setEnableBiometrics(true);
        // Each fresh assessment is a new persisted survey record.
        setSurveyRunId(crypto.randomUUID());
    }, []);

    // Resolve the user's baseline before a conversation starts:
    //  • DB has one  → inject it and skip the 30s recording.
    //  • DB has none → wipe local state so the recording runs, and arm a save so the
    //                  fresh baseline is persisted to the DB on completion.
    //  • fetch fails → keep any local baseline, don't force a re-record.
    const resolveBaseline = useCallback(async () => {
        try {
            const res = await apiFetch("/baseline");
            if (res.ok) {
                const data = await res.json();
                if (data.baseline) {
                    setBaseline({ pupilSize: data.baseline.pupilSize, blinkRate: data.baseline.blinkRate, timestamp: Date.now() });
                    baselineNeedsSaveRef.current = false;
                } else {
                    clearBaseline();
                    baselineNeedsSaveRef.current = true;
                }
                return;
            }
        } catch (err) {
            console.warn("[App] Baseline fetch failed; using local baseline if present", err);
        }
        baselineNeedsSaveRef.current = false;
    }, [setBaseline, clearBaseline]);

    // Once a fresh 30s baseline finishes recording (DB-miss path only): persist it, then
    // open the warm-up → survey gate on the backend and re-send session.update so the agent
    // delivers its bridge line and begins the questions. Returning users (injected baseline)
    // never enter this branch — they start unlocked server-side, so no transition is fired.
    useEffect(() => {
        if (baselineSessionStatus === "completed" && baselineData && baselineNeedsSaveRef.current) {
            baselineNeedsSaveRef.current = false;
            apiFetch("/baseline", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pupilSize: baselineData.pupilSize, blinkRate: baselineData.blinkRate })
            }).catch(err => console.warn("[App] Failed to persist baseline:", err));

            apiFetch("/survey-phase", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: sessionId, phase: "survey" })
            })
                .then(() => refreshSession())
                .catch(err => console.warn("[App] Failed to unlock survey phase:", err));
        }
    }, [baselineSessionStatus, baselineData, sessionId, refreshSession]);

    // Primary toggle: start / stop / resume. It never resets — a stopped survey
    // (mid-way) is left untouched so pressing it again resumes, and after completion
    // it simply reconnects the user for report Q&A. Starting a brand-new assessment
    // is the dedicated "Start New Survey" button's job (onStartNewSurvey).
    const onStartListening = async () => {
        if (isRecording) return;
        setIsRecording(true);
        // Open the session, arm playback and ask the agent to greet IMMEDIATELY, so its
        // opening line is already generating while the baseline fetch and mic init run in
        // parallel below. The agent doesn't need the mic to talk, and the survey phase is
        // resolved server-side at connect — so neither await needs to block the greeting.
        startSession();
        resetAudioPlayer();
        requestGreeting();
        // Now finish arming input: load the baseline (decides if the 30s recording runs)
        // and start the mic so the user can answer.
        await resolveBaseline();
        await startAudioRecording();
    };

    const onStopListening = async () => {
        if (!isRecording) return;
        await stopAudioRecording();
        stopAudioPlayer();
        inputAudioBufferClear();
        setIsRecording(false);
    };

    // Dedicated "Start New Survey": discards the current assessment and starts a fresh
    // conversation. Fully resets the SAME backend session (clears survey_results,
    // conversation_state and the reconnect counter), wipes the UI, then forces a clean
    // realtime reconnect so the agent has no memory of the previous survey.
    const onStartNewSurvey = async () => {
        // Silence the agent the instant the button is pressed — window.confirm() blocks the
        // JS main thread, but already-buffered speech keeps playing on the audio thread
        // underneath the dialog. Flushing the player here "pauses" the agent while the user
        // decides, instead of letting it talk over the confirmation prompt.
        stopAudioPlayer();
        if (!window.confirm("This discards the current assessment and starts a fresh survey. Continue?")) {
            return;
        }
        // Guard against the old turn's audio bleeding into the new session during the
        // reconnect below; lifted on the fresh session.created (onReceivedSessionReady).
        suppressAgentAudioRef.current = true;
        if (isRecording) {
            await stopAudioRecording();
            stopAudioPlayer();
            inputAudioBufferClear();
        }
        pendingGuardrailResetRef.current = false;
        try {
            await apiFetch("/clear-conversation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: sessionId })
            });
        } catch (err) {
            console.error("Failed to reset session for new survey:", err);
        }
        resetAssessmentState();
        setAssessmentComplete(false);

        // Settle the baseline decision BEFORE we start recording. resolveBaseline either
        // injects a stored baseline (status → "completed", the 30s recording is skipped) or
        // clears it (status → "idle", recording runs). It must run first so the auto-start
        // effect fires deterministically on the resolved status instead of racing it — and
        // so it agrees with the phase the backend resolves from the same baseline on the
        // fresh connection below (DB hit → returning-user "survey"; miss → "warmup").
        await resolveBaseline();

        setIsRecording(true);
        reconnect();
        startSession();
        resetAudioPlayer();
        // Arm the greeting now (deferred until the reconnect's session.created, since the
        // socket is mid-reopen here) so the agent opens the fresh conversation the instant
        // the session is ready.
        requestGreeting();
        await startAudioRecording();
    };

    // Called by DetailedReport once POST /analyze-report has resolved (report
    // post-processed + persisted to DB). Clears the loader and arms the strict
    // report-only hard reset, performed on the next response.done.
    const handleReportReady = useCallback(() => {
        setReportLoading(false);
        pendingGuardrailResetRef.current = true;
    }, []);

    const handleStartBaselineSession = useCallback(() => {
        startBaselineSession();
    }, [startBaselineSession]);

    const handleProceedWithoutBaseline = useCallback(() => {
        // Skip baseline — hook treats missing baseline as "completed with no reference"
        startBaselineSession();
    }, [startBaselineSession]);

    const handleRerecordBaseline = useCallback(async () => {
        // Drop the server copy too, and arm a save so the new recording replaces it. Awaited
        // so the delete is durable before any subsequent Start-New-Survey reads the baseline
        // (both the frontend resolveBaseline GET and the backend phase resolution) — otherwise
        // a stale baseline would be read and the fresh 30s recording skipped.
        try {
            await apiFetch("/baseline", { method: "DELETE" });
        } catch (err) {
            console.warn("[App] Failed to clear server baseline:", err);
        }
        baselineNeedsSaveRef.current = true;
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

    // A survey that was started and stopped before completion — the primary button
    // becomes "Continue Conversation" to resume it.
    const surveyInProgress = surveyCompleted > 0 && !assessmentComplete;
    // There is an assessment worth discarding/resetting.
    const hasAssessment = surveyCompleted > 0 || assessmentComplete;

    // Single source of truth for the always-visible baseline card's state:
    //  • recording — the 30s capture is running
    //  • recorded  — a valid baseline exists
    //  • needed    — conversation is live but no baseline yet (prompt to record/skip)
    //  • none      — idle, no baseline (recorded on the next conversation start)
    // Note: a "completed" status without baselineData means capture finished with no usable
    // samples (e.g. no face) — surface that as "none" so the user can record again.
    const baselineState: "recording" | "recorded" | "needed" | "none" =
        baselineSessionStatus === "collecting"
            ? "recording"
            : baselineSessionStatus === "completed" && baselineData
              ? "recorded"
              : isRecording && enableBiometrics
                ? "needed"
                : "none";

    if (authState === "checking") {
        return (
            <div className="ciq-page flex min-h-screen items-center justify-center">
                <p className="text-sm text-[color:var(--ciq-text-60)]">Loading…</p>
            </div>
        );
    }

    if (authState === "unauthenticated") {
        return <LoginScreen onLogin={handleLogin} />;
    }

    return (
        <div className="ciq-page flex h-screen flex-col overflow-hidden text-[color:var(--ciq-text-strong)]">
            {/* ── Floating pill header ── */}
            <div className="sticky top-0 z-40 px-5 pb-2 pt-4">
                <div className="flex items-center justify-between rounded-[40px] border border-[color:var(--ciq-border)] bg-[color:var(--ciq-header-bg)] px-6 py-3 shadow-[0_30px_100px_rgba(0,0,0,0.42),inset_0_1px_1px_rgba(255,255,255,0.22)] saturate-150 backdrop-blur-[34px]">
                    <div className="flex items-center gap-3">
                        <img src={logo} alt="CIQ logo" className="ciq-logo h-10 w-10" />
                        <div>
                            <h1 className="font-display text-xl font-bold tracking-tight text-[color:var(--ciq-text-strong)]">CIQ Voice Agent</h1>
                            <p className="text-xs text-[color:var(--ciq-text-46)]">Burnout Assessment Platform</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <nav className="flex items-center gap-1">
                            {NAV_TABS.filter(tab => (!tab.adminOnly || isAdmin) && (!tab.managerOnly || isManager)).map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    aria-current={activeTab === tab.id ? "page" : undefined}
                                    className={`rounded-full px-4 py-1.5 text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-purple)] ${
                                        activeTab === tab.id
                                            ? "border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] font-semibold text-[color:var(--ciq-text-strong)] shadow-[0_8px_20px_rgba(0,0,0,0.12)]"
                                            : "font-medium text-[color:var(--ciq-text-60)] hover:bg-[color:var(--ciq-tile)] hover:text-[color:var(--ciq-text-86)]"
                                    }`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </nav>
                        <div className="relative">
                            {(() => {
                                const ActiveIcon = THEME_OPTIONS.find(o => o.id === theme)?.icon ?? Sun;
                                return (
                                    <button
                                        onClick={() => setThemeMenuOpen(o => !o)}
                                        aria-label="Change color theme"
                                        aria-haspopup="menu"
                                        aria-expanded={themeMenuOpen}
                                        title="Change color theme"
                                        className="flex h-8 items-center gap-1.5 rounded-full bg-[color:var(--ciq-tile-strong)] px-2.5 text-[color:var(--ciq-text-68)] transition-colors hover:bg-[color:var(--ciq-hover)]"
                                    >
                                        <ActiveIcon className="h-4 w-4" />
                                        <ChevronDown className={`h-3 w-3 transition-transform ${themeMenuOpen ? "rotate-180" : ""}`} />
                                    </button>
                                );
                            })()}
                            {themeMenuOpen && (
                                <>
                                    {/* click-away backdrop */}
                                    <div className="fixed inset-0 z-40" onClick={() => setThemeMenuOpen(false)} />
                                    <div
                                        role="menu"
                                        className="absolute right-0 z-50 mt-2 w-36 overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-card)] p-1 shadow-[var(--ciq-glass-shadow)]"
                                    >
                                        {THEME_OPTIONS.map(opt => {
                                            const Icon = opt.icon;
                                            const active = theme === opt.id;
                                            return (
                                                <button
                                                    key={opt.id}
                                                    role="menuitemradio"
                                                    aria-checked={active}
                                                    onClick={() => { setTheme(opt.id); setThemeMenuOpen(false); }}
                                                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs transition-colors ${
                                                        active
                                                            ? "bg-[color:var(--ciq-tile-strong)] font-semibold text-[color:var(--ciq-text-strong)]"
                                                            : "font-medium text-[color:var(--ciq-text-68)] hover:bg-[color:var(--ciq-tile)]"
                                                    }`}
                                                >
                                                    <Icon className="h-4 w-4" />
                                                    <span className="flex-1">{opt.label}</span>
                                                    {active && <Check className="h-3.5 w-3.5" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                        </div>
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

            {/* ── Manager Dashboard ── */}
            {activeTab === "dashboard" && isManager && (
                <main className="relative flex-1 overflow-hidden">
                    <ManagerLanding theme={theme} />
                </main>
            )}

            {/* ── Admin Panel ── (same centered 8-of-12 column as the assessment) */}
            {/* isAdmin gates the render so a guest can never see it even if activeTab
                is forced to "admin"; the backend 403s on /admin/* regardless. */}
            {activeTab === "admin" && isAdmin && (
                <main className="flex-1 overflow-y-auto p-4">
                    <div className="grid w-full grid-cols-12 gap-4">
                        <div className="col-span-12 lg:col-span-8 lg:col-start-3">
                            <AdminPanel />
                        </div>
                    </div>
                </main>
            )}

            {/* ── Test Generator ── (admin-only, like the Admin panel) */}
            {activeTab === "test" && isAdmin && (
                <main className="flex-1 overflow-y-auto p-4">
                    <div className="grid w-full grid-cols-12 gap-4">
                        <div className="col-span-12 lg:col-span-8 lg:col-start-3">
                            <TestGenerator />
                        </div>
                    </div>
                </main>
            )}

            {/* ── User History ── */}
            {activeTab === "history" && (
                <main className="flex-1 overflow-y-auto p-4">
                    <div className="grid w-full grid-cols-12 gap-4">
                        <div className="col-span-12 lg:col-span-8 lg:col-start-3">
                            <UserHistory />
                        </div>
                    </div>
                </main>
            )}

            {/* ── Assessment Panel ── */}
            {activeTab === "assessment" && (
                <main className="flex-1 overflow-y-auto p-4">
                    <div className="grid w-full grid-cols-12 gap-4">
                        {/* Centered 8-of-12 column: video → biometrics → results */}
                        <div className="col-span-12 flex flex-col gap-4 lg:col-span-8 lg:col-start-3">
                            {/* Camera Feed Panel */}
                            <section className="ciq-glass-card">
                                <div className="flex h-full flex-col">
                                    <div className="border-b border-[color:var(--ciq-divider)] px-5 py-3">
                                        <div className="flex items-center gap-2">
                                            <h2 className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">
                                                {cameraView === "avatar" ? "AI Avatar" : "Camera Feed"}
                                            </h2>
                                            <div className="ml-auto flex items-center gap-2">
                                                <button
                                                    onClick={() => setCameraView(v => (v === "camera" ? "avatar" : "camera"))}
                                                    aria-label={cameraView === "camera" ? "Switch to AI avatar" : "Switch to camera feed"}
                                                    title={cameraView === "camera" ? "Switch to AI avatar" : "Switch to camera feed"}
                                                    className="flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--ciq-tile-strong)] text-[color:var(--ciq-text-68)] transition-colors hover:bg-[color:var(--ciq-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-purple)]"
                                                >
                                                    {cameraView === "camera" ? <Bot className="h-3.5 w-3.5" /> : <Video className="h-3.5 w-3.5" />}
                                                </button>
                                                <button
                                                    onClick={() => setVideoExpanded(prev => !prev)}
                                                    aria-label={videoExpanded ? "Shrink camera feed" : "Expand camera feed to full width"}
                                                    title={videoExpanded ? "Shrink camera feed" : "Expand to full width"}
                                                    className="flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--ciq-tile-strong)] text-[color:var(--ciq-text-68)] transition-colors hover:bg-[color:var(--ciq-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-purple)]"
                                                >
                                                    {videoExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                                                </button>
                                                {/* Status badge: green dot when the conversation is live, red when stopped. */}
                                                <span
                                                    className="flex items-center gap-1.5 rounded-full bg-[color:var(--ciq-tile-strong)] px-2.5 py-0.5 text-[10px] font-semibold tracking-widest text-[color:var(--ciq-text-60)]"
                                                    title={isRecording ? "Conversation active" : "Conversation stopped"}
                                                >
                                                    <span className="relative flex h-2 w-2">
                                                        {isRecording && (
                                                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--ciq-accent-green)] opacity-60" />
                                                        )}
                                                        <span
                                                            className="relative inline-flex h-2 w-2 rounded-full"
                                                            style={{ background: isRecording ? "var(--ciq-accent-green)" : "var(--ciq-accent-red)" }}
                                                        />
                                                    </span>
                                                    LIVE
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="relative p-4">
                                        {/* The camera stays mounted underneath in avatar mode so MediaPipe
                                            biometric capture is never interrupted — the avatar just overlays it. */}
                                        <VideoPanel
                                            isRecording={isRecording}
                                            expanded={videoExpanded}
                                            surveyQuestions={surveyQuestions}
                                            surveyTotal={surveyTotal}
                                            surveyCompleted={surveyCompleted}
                                            surveyOptions={surveyOptions}
                                            onVideoReady={setVideoElement}
                                        />
                                        {cameraView === "avatar" && (
                                            <div className="absolute inset-0 p-4">
                                                <div className={`mx-auto aspect-video w-full ${videoExpanded ? "max-w-none" : "max-w-xl"}`}>
                                                    <CyberAvatar getAnalyser={getAudioAnalyser} className="border border-[color:var(--ciq-border)]" />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <div className="border-t border-[color:var(--ciq-divider)] px-5 py-4">
                                        <div className="flex flex-col gap-2">
                                            {enableSurvey && surveyTypeConfig && (
                                                <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3">
                                                    <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[color:var(--ciq-text-60)]">
                                                        Survey Type
                                                    </p>
                                                    {surveyTypeConfig.surveyTypeOverridden ? (
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xs text-[color:var(--ciq-text-strong)]">
                                                                {surveyTypeConfig.activeSurveyType}
                                                            </span>
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
                                            {/* Controls — desktop: [Restart][Start/Continue][Stop] on one row.
                                            Mobile: [Start/Continue][Stop] on top, [Restart] full-width below. */}
                                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                                <Button
                                                    onClick={onStartNewSurvey}
                                                    variant="outline"
                                                    disabled={!hasAssessment && !isRecording}
                                                    className="order-3 col-span-2 flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-purple)] disabled:opacity-40 sm:order-1 sm:col-span-1"
                                                >
                                                    <RotateCcw className="h-4 w-4" />
                                                    {t("app.startNewSurvey") || "Restart"}
                                                </Button>
                                                <Button
                                                    onClick={onStartListening}
                                                    disabled={isRecording}
                                                    className="order-1 flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:from-purple-500 hover:to-pink-500 focus-visible:ring-2 focus-visible:ring-purple-400 disabled:opacity-40 sm:order-2"
                                                >
                                                    <Mic className="h-4 w-4" />
                                                    {surveyInProgress ? t("app.continueConversation") || "Continue" : t("app.startRecording") || "Start"}
                                                </Button>
                                                <Button
                                                    onClick={onStopListening}
                                                    disabled={!isRecording}
                                                    variant="outline"
                                                    className="order-2 flex h-11 items-center justify-center gap-2 rounded-xl border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] text-sm font-semibold text-[color:var(--ciq-text-68)] hover:bg-[color:var(--ciq-hover)] focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-red)] disabled:opacity-40 sm:order-3"
                                                >
                                                    <MicOff className="h-4 w-4" />
                                                    {t("app.stopConversation") || "Stop"}
                                                </Button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </section>

                            {/* Biometrics & Sentiment Panel - below the video */}
                            <section className="ciq-glass-card">
                                <div className="flex h-full flex-col">
                                    <div className="border-b border-[color:var(--ciq-divider)] px-5 py-3">
                                        <h2 className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">Biometrics &amp; Sentiment</h2>
                                    </div>
                                    <div className="flex-1 space-y-4 overflow-y-auto p-4">
                                        {/* Biometric Baseline — always visible; its inner content
                                            reflects baselineState (recorded / recording / needed / none). */}
                                        <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3">
                                            <div className="mb-2 flex items-center justify-between">
                                                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[color:var(--ciq-text-60)]">
                                                    Biometric Baseline
                                                </p>
                                                <span
                                                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${
                                                        baselineState === "recorded"
                                                            ? "text-[color:var(--ciq-accent-green)]"
                                                            : baselineState === "recording"
                                                              ? "text-[color:var(--ciq-accent-blue)]"
                                                              : baselineState === "needed"
                                                                ? "text-[color:var(--ciq-accent-amber)]"
                                                                : "text-[color:var(--ciq-text-60)]"
                                                    }`}
                                                >
                                                    {baselineState === "recorded"
                                                        ? "RECORDED"
                                                        : baselineState === "recording"
                                                          ? "RECORDING"
                                                          : baselineState === "needed"
                                                            ? "REQUIRED"
                                                            : "NOT SET"}
                                                </span>
                                            </div>

                                            {/* Recorded — show captured values + rerecord */}
                                            {baselineState === "recorded" && baselineData && (
                                                <div className="flex items-center justify-between gap-3">
                                                    <div className="flex items-center gap-4 text-[11px]">
                                                        <div className="flex items-center gap-1">
                                                            <span className="text-[color:var(--ciq-text-68)]">Pupil:</span>
                                                            <span className="font-data font-semibold text-[color:var(--ciq-text-strong)]">
                                                                {baselineData.pupilSize.toFixed(1)} mm
                                                            </span>
                                                        </div>
                                                        <div className="flex items-center gap-1">
                                                            <span className="text-[color:var(--ciq-text-68)]">Blink:</span>
                                                            <span className="font-data font-semibold text-[color:var(--ciq-text-strong)]">
                                                                {baselineData.blinkRate.toFixed(1)}/min
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <Button onClick={handleRerecordBaseline} size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[10px]">
                                                        <RotateCcw className="mr-1 h-3 w-3" />
                                                        Rerecord
                                                    </Button>
                                                </div>
                                            )}

                                            {/* Recording — 30s progress */}
                                            {baselineState === "recording" && (
                                                <div>
                                                    <div className="mb-2 flex items-center gap-2">
                                                        <Loader2 className="h-4 w-4 animate-spin text-[color:var(--ciq-accent-blue)]" />
                                                        <span className="text-xs text-[color:var(--ciq-accent-blue)]">
                                                            Hold still and look at the camera…
                                                        </span>
                                                    </div>
                                                    <div className="h-2 w-full rounded-full bg-[color:var(--ciq-track)]">
                                                        <div
                                                            className="h-2 rounded-full bg-blue-500 transition-all duration-100"
                                                            style={{ width: `${baselineProgress}%` }}
                                                        />
                                                    </div>
                                                    <p className="mt-1.5 text-[11px] text-[color:var(--ciq-text-60)]">
                                                        {Math.round((baselineProgress / 100) * 30)} / 30 seconds
                                                    </p>
                                                </div>
                                            )}

                                            {/* Needed — conversation live, prompt to record or skip */}
                                            {baselineState === "needed" && (
                                                <div>
                                                    <p className="mb-3 text-xs text-[color:var(--ciq-text-86)]">
                                                        Record a 30-second baseline of your pupil size and blink rate so changes during the
                                                        conversation can be measured.
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

                                            {/* None — idle, no baseline yet */}
                                            {baselineState === "none" && (
                                                <p className="text-xs text-[color:var(--ciq-text-60)]">
                                                    No baseline recorded yet. It will be captured for 30 seconds when you start the conversation.
                                                </p>
                                            )}
                                        </div>

                                        {/* Idle state — keeps the panel feeling alive before signals arrive */}
                                        {!isRecording && (
                                            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[color:var(--ciq-border)] py-10 text-center">
                                                <Activity className="h-7 w-7 text-[color:var(--ciq-text-40)]" />
                                                <p className="text-sm font-medium text-[color:var(--ciq-text-68)]">Biometric stream idle</p>
                                                <p className="text-xs text-[color:var(--ciq-text-40)]">Start the conversation to capture live signals</p>
                                            </div>
                                        )}

                                        {/* Live Biometric Metrics */}
                                        {currentBiometrics && currentBiometrics.faceDetected && isRecording && (
                                            <div>
                                                <div className="mb-2.5 flex items-center gap-2">
                                                    <span className="relative flex h-2 w-2">
                                                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--ciq-accent-green)] opacity-60" />
                                                        <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--ciq-accent-green)]" />
                                                    </span>
                                                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--ciq-text-60)]">
                                                        Live Biometrics
                                                    </h3>
                                                </div>
                                                <div className="flex flex-wrap justify-center gap-2.5 [&>*]:w-[9.5rem] [&>*]:grow-0">
                                                    <MetricCell
                                                        label="Blink Rate"
                                                        accent="var(--ciq-accent-blue)"
                                                        value={
                                                            <>
                                                                {currentBiometrics.metrics.blinkRate.toFixed(1)}
                                                                <span className="ml-0.5 text-[12px] font-medium text-[color:var(--ciq-text-60)]">/min</span>
                                                            </>
                                                        }
                                                        sub={`base ${baselineData?.blinkRate.toFixed(1) || "--"}`}
                                                    />
                                                    <MetricCell
                                                        label="Eye Openness"
                                                        accent="var(--ciq-accent-blue)"
                                                        value={formatMetric(currentBiometrics.metrics.eyeOpenness)}
                                                    />
                                                    <MetricCell
                                                        label="Smile"
                                                        accent="var(--ciq-accent-green)"
                                                        value={formatMetric(currentBiometrics.metrics.smileIntensity)}
                                                    />
                                                    <MetricCell
                                                        label="Head Pose"
                                                        accent="var(--ciq-accent-purple)"
                                                        value={<span className="text-base">{getHeadPoseLabel(currentBiometrics.metrics.headPose.yaw)}</span>}
                                                    />
                                                    <MetricCell
                                                        label="Pupil Size"
                                                        accent="var(--ciq-accent-amber)"
                                                        value={
                                                            <>
                                                                {currentBiometrics.metrics.pupilSizeMm.toFixed(1)}
                                                                <span className="ml-0.5 text-[12px] font-medium text-[color:var(--ciq-text-60)]">mm</span>
                                                            </>
                                                        }
                                                        sub={`base ${baselineData?.pupilSize.toFixed(1) || "--"}`}
                                                    />
                                                    <MetricCell
                                                        label="Blink Change"
                                                        accent={
                                                            currentBiometrics.metrics.blinkRateChangePercent >= 0
                                                                ? "var(--ciq-accent-red)"
                                                                : "var(--ciq-accent-green)"
                                                        }
                                                        valueClassName={
                                                            currentBiometrics.metrics.blinkRateChangePercent >= 0
                                                                ? "text-[color:var(--ciq-accent-red)]"
                                                                : "text-[color:var(--ciq-accent-green)]"
                                                        }
                                                        value={`${currentBiometrics.metrics.blinkRateChangePercent >= 0 ? "+" : ""}${currentBiometrics.metrics.blinkRateChangePercent.toFixed(1)}%`}
                                                    />
                                                    <div
                                                        className="ciq-metric"
                                                        style={{ ["--ciq-metric-accent" as string]: "var(--ciq-accent-purple)" } as React.CSSProperties}
                                                    >
                                                        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--ciq-text-60)]">
                                                            Gaze
                                                        </p>
                                                        <div className="mt-0.5 flex items-center gap-1.5">
                                                            <GazeIndicator gaze={currentBiometrics.metrics.gaze} />
                                                            <span className="font-data text-base font-bold text-[color:var(--ciq-text-strong)]">
                                                                {gazeLabel(currentBiometrics.metrics.gaze)}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* Blink Rate Stress + Voice Sentiment — compact cards centered below the live feed */}
                                        {((stressResult && isRecording) || sentiment) && (
                                            <div className="flex flex-wrap justify-center gap-3">
                                                {stressResult && isRecording && (
                                                    <div className={`w-full rounded-xl border p-3 sm:w-[16rem] ${getStressBgColor(stressResult.state)}`}>
                                                        <div className="flex items-center justify-between">
                                                            <h4 className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">Blink Rate Stress</h4>
                                                            <span
                                                                className={`rounded-full px-2 py-0.5 text-[11px] font-bold tracking-wide ${getStressColor(stressResult.state)}`}
                                                            >
                                                                {stressResult.state.toUpperCase()}
                                                            </span>
                                                        </div>
                                                        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                                                            <div>
                                                                <span className="block text-[color:var(--ciq-text-60)]">Change</span>
                                                                <span
                                                                    className={`font-data text-sm font-bold ${(stressResult.blink_rate_change_percent || 0) >= 0 ? "text-[color:var(--ciq-accent-red)]" : "text-[color:var(--ciq-accent-green)]"}`}
                                                                >
                                                                    {(stressResult.blink_rate_change_percent || 0) >= 0 ? "+" : ""}
                                                                    {stressResult.blink_rate_change_percent?.toFixed(1) || "0.0"}%
                                                                </span>
                                                            </div>
                                                            <div>
                                                                <span className="block text-[color:var(--ciq-text-60)]">Conf</span>
                                                                <span className="font-data text-sm font-bold text-[color:var(--ciq-text-strong)]">
                                                                    {(stressResult.confidence * 100).toFixed(0)}%
                                                                </span>
                                                            </div>
                                                            <div>
                                                                <span className="block text-[color:var(--ciq-text-60)]">Trend</span>
                                                                <span
                                                                    className={`font-medium capitalize ${
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

                                                {sentiment && (
                                                    <div className="w-full rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3 sm:w-[16rem]">
                                                        <div className="flex items-center gap-2">
                                                            {sentiment.sentiment === "positive" && (
                                                                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/20">
                                                                    <Smile className="h-5 w-5 text-[color:var(--ciq-accent-green)]" />
                                                                </div>
                                                            )}
                                                            {sentiment.sentiment === "neutral" && (
                                                                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-500/20">
                                                                    <Meh className="h-5 w-5 text-[color:var(--ciq-accent-amber)]" />
                                                                </div>
                                                            )}
                                                            {sentiment.sentiment === "negative" && (
                                                                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20">
                                                                    <Frown className="h-5 w-5 text-[color:var(--ciq-accent-red)]" />
                                                                </div>
                                                            )}
                                                            <div className="min-w-0">
                                                                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[color:var(--ciq-text-60)]">
                                                                    Voice Sentiment
                                                                </p>
                                                                <p className="text-base font-semibold capitalize text-[color:var(--ciq-text-strong)]">
                                                                    {sentiment.sentiment}
                                                                </p>
                                                            </div>
                                                            {sentiment.reason && (
                                                                <button
                                                                    onClick={() => setIsReasonExpanded(!isReasonExpanded)}
                                                                    className="ml-auto shrink-0 text-[10px] text-[color:var(--ciq-text-60)] hover:text-[color:var(--ciq-text-86)] focus:outline-none"
                                                                >
                                                                    {isReasonExpanded ? "Hide" : "Why?"}
                                                                </button>
                                                            )}
                                                        </div>
                                                        {sentiment.reason && isReasonExpanded && (
                                                            <p className="mt-2 rounded-lg bg-[color:var(--ciq-tile)] p-2 text-[11px] leading-relaxed text-[color:var(--ciq-text-86)]">
                                                                {sentiment.reason}
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </section>

                            {/* Final Results Panel - Burnout Assessment */}
                            <section className="ciq-glass-card min-h-[420px]">
                                <div className="flex h-full flex-col">
                                    <div className="border-b border-[color:var(--ciq-divider)] px-5 py-3">
                                        <h2 className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">
                                            Final Results — Burnout Assessment
                                        </h2>
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
                                                                <p className="font-data text-2xl font-semibold text-[color:var(--ciq-text-strong)]">
                                                                    {surveyTotal}
                                                                </p>
                                                            </div>
                                                            <div className="rounded-lg bg-[color:var(--ciq-tile)] p-3">
                                                                <p className="text-xs text-[color:var(--ciq-text-60)]">Completed</p>
                                                                <p className="font-data text-2xl font-semibold text-[color:var(--ciq-accent-purple)]">
                                                                    {surveyCompleted}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}

                                                {showDetailedReport && biometricSnapshots.length > 0 && (
                                                    <div className="relative mt-4">
                                                        {/* DetailedReport renders underneath while post-processing so Recharts
                                                        sizes correctly; the overlay covers it until /analyze-report resolves. */}
                                                        {reportLoading && (
                                                            <div className="bg-[color:var(--ciq-card)]/90 absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl backdrop-blur-sm">
                                                                <Loader2 className="h-8 w-8 animate-spin text-[color:var(--ciq-accent-purple)]" />
                                                                <p className="text-sm font-medium text-[color:var(--ciq-text-strong)]">
                                                                    Generating your report…
                                                                </p>
                                                                <p className="text-xs text-[color:var(--ciq-text-60)]">
                                                                    Analyzing your responses and biometrics
                                                                </p>
                                                            </div>
                                                        )}
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
                                                                    onReportDelivered={handleReportReady}
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
                    </div>
                </main>
            )}
        </div>
    );
}

// Futuristic biometric readout cell — mono value, per-metric accent rail/glow.
function MetricCell({
    label,
    value,
    sub,
    accent = "var(--ciq-accent-purple)",
    valueClassName
}: {
    label: string;
    value: ReactNode;
    sub?: ReactNode;
    accent?: string;
    valueClassName?: string;
}) {
    return (
        <div className="ciq-metric" style={{ ["--ciq-metric-accent" as string]: accent } as React.CSSProperties}>
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--ciq-text-60)]">{label}</p>
            <p className={`font-data text-xl font-bold leading-tight text-[color:var(--ciq-text-strong)] ${valueClassName ?? ""}`}>{value}</p>
            {sub != null && <p className="mt-0.5 text-[11px] text-[color:var(--ciq-text-60)]">{sub}</p>}
        </div>
    );
}

export default App;
