import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import {
    Mic,
    MicOff,
    Smile,
    Meh,
    Frown,
    ClipboardList,
    Loader2,
    RotateCcw,
    Activity,
    Maximize2,
    Minimize2,
    Bot,
    Video,
    Menu,
    X,
    HeartHandshake,
    ChevronRight,
    CheckCircle2
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LoginScreen } from "@/components/ui/login-screen";
import { SignupScreen } from "@/components/ui/signup-screen";
import { VideoPanel } from "@/components/ui/video-panel";
import { GazeIndicator } from "@/components/ui/gaze-indicator";
import { CyberAvatar } from "@/components/ui/cyber-avatar";
import { ErrorBoundary } from "@/components/ui/error-boundary";
// Lazy-loaded so Recharts (heavy) is code-split out of the initial bundle and
// only fetched when a completed survey opens the report.
const DetailedReport = lazy(() => import("@/components/ui/detailed-report").then(m => ({ default: m.DetailedReport })));
const RecoveryWindowScreen = lazy(() => import("@/components/ui/recovery-window-screen"));
import { AdminPanel } from "@/components/ui/admin-panel";
import { TestGenerator } from "@/components/ui/test-generator";
import { MusePanel } from "@/components/ui/muse-panel";
import { EegConnectPanel } from "@/components/ui/eeg-connect-panel";
import { UserHistory } from "@/components/ui/user-history";
import { ManagerLanding } from "@/components/ui/manager-landing";
import { GuestLanding } from "@/components/ui/guest-landing";
import { Button } from "@/components/ui/button";
import ConsentModal, { CONSENT_VERSION } from "@/components/ui/consent-modal";
import { apiFetch, setAuthExpiredHandler } from "@/lib/api";
import { assessmentControls, closeAssessment, continueAssessment, fetchResumableAssessment, pauseAssessment, startAssessment } from "@/lib/assessment";
import { applyFontScale, getFontScale } from "@/lib/fontScale";

import useRealTime from "@/hooks/useRealtime";
import useAudioRecorder from "@/hooks/useAudioRecorder";
import useAudioPlayer from "@/hooks/useAudioPlayer";
import { useBiometrics } from "@/hooks/useBiometrics";
import { useMuse } from "@/hooks/useMuse";
import { useBaselineProtocol } from "@/hooks/useBaselineProtocol";

import {
    SentimentUpdate,
    SurveyQuestion,
    SurveyOption,
    BiometricSnapshot,
    BiometricResult,
    SurveyTypeConfig,
    AuthUser,
    AuthState,
    RecoveryUpdate,
    ChatTurn,
    AssessmentContinued,
    ResumableAssessment
} from "./types";

import logo from "./assets/logo.png";

// `managerOnly` tabs are the management views: visible to managers and admins
// (admins are a superset role), but never to guests.
// `guestOnly` is the inverse — the guest "Home" landing, shown only to plain
// guests (managers/admins get their own dashboard instead).
const NAV_TABS = [
    { id: "home", label: "Home", adminOnly: false, managerOnly: false, guestOnly: true },
    { id: "dashboard", label: "Dashboard", adminOnly: false, managerOnly: true, guestOnly: false },
    { id: "assessment", label: "Assessment", adminOnly: false, managerOnly: false, guestOnly: false },
    { id: "admin", label: "Admin", adminOnly: true, managerOnly: false, guestOnly: false },
    { id: "test", label: "Test Generator", adminOnly: true, managerOnly: false, guestOnly: false },
    { id: "eeg", label: "Muse EEG", adminOnly: true, managerOnly: false, guestOnly: false },
    { id: "history", label: "History", adminOnly: false, managerOnly: false, guestOnly: false }
] as const;

// Baseline protocol phase lengths (see useBaselineProtocol / session/baseline-protocol.ts).
const BASELINE_EYES_OPEN_SECONDS = 180;
const BASELINE_EYES_CLOSED_SECONDS = 180;

const formatCountdown = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function App() {
    const [authState, setAuthState] = useState<AuthState>("checking");
    const [authView, setAuthView] = useState<"login" | "signup">("login");
    const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
    // Session ID starts as a local UUID and is replaced with the server-issued one on login
    const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
    // Identifies a single survey run. Minted by the backend on Start (POST
    // /me/assessment/start) so each survey is persisted as its own history record; a
    // Continue carries the paused run's id back. The local UUID is only a placeholder.
    const [surveyRunId, setSurveyRunId] = useState<string>(() => crypto.randomUUID());
    // The user's open (paused, or left active by a closed tab) assessment, fetched on
    // entering the assessment page — drives Start new / Continue / Close vs plain Start.
    const [resumable, setResumable] = useState<ResumableAssessment | null>(null);
    // Which Start/Continue segment of the run the live EEG recording belongs to — each
    // segment is uploaded as its own file (see ciq/eeg/combine.combine_segments).
    const eegSegmentRef = useRef(0);
    const [activeTab, setActiveTab] = useState<"home" | "dashboard" | "assessment" | "admin" | "test" | "eeg" | "history">("assessment");
    // Nav collapses into this drawer below the `lg` breakpoint (see the header markup) —
    // desktop keeps the always-visible pill row untouched.
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const isAdmin = currentUser?.role === "admin";
    const isManager = currentUser?.role === "manager";
    // Plain guests (neither admin nor manager) get the Home landing as their default.
    const isGuest = currentUser != null && !isAdmin && !isManager;
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
    // Bumped on every recovery.* realtime message so RecoveryWindowCard (a read-only
    // mirror of the voice-driven flow) knows to refetch its status.
    const [recoveryUpdateTick, setRecoveryUpdateTick] = useState(0);
    // Opens the dedicated full-screen Recovery Window (recovery-window-screen.tsx),
    // separate from the report panel so the voice-guided check-in isn't buried among
    // the report stats. Toggling this never touches the realtime WS/audio session.
    const [recoveryWindowOpen, setRecoveryWindowOpen] = useState(false);
    // Mirrors the live camera MediaStream from the main VideoPanel (see onStreamReady
    // below) so the Recovery Window screen can show its own live camera panel — same
    // feed, no second getUserMedia capture.
    const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
    // Live text transcript of the voice conversation, shown as a chat inside the
    // Recovery Window screen. Agent turns stream in via response.audio_transcript.delta;
    // user turns get a slot reserved on speech_started and the text filled in once
    // whisper transcription completes (it lags the agent's spoken reply).
    const [chatTranscript, setChatTranscript] = useState<ChatTurn[]>([]);
    const agentTurnIdRef = useRef<string | null>(null);
    const pendingUserTurnIdRef = useRef<string | null>(null);
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
    // Informed-consent gate for the pilot study, asked on EVERY visit to the assessment
    // page (Home's start buttons, the Assessment tab, landing there after login). True
    // only for the current visit — reset on leaving the page. Each acceptance is logged
    // server-side (POST /consent -> consent_events) with the wording version.
    const [showConsent, setShowConsent] = useState(false);
    const [consentGiven, setConsentGiven] = useState<boolean | null>(null);
    // Holds whichever start action (onStartListening / onStartNewSurvey) triggered the
    // consent gate, so ConsentModal's onAgree can resume exactly that action.
    const pendingStartActionRef = useRef<(() => void) | null>(null);
    const requiresConsent = surveyTypeConfig?.activeSurveyType === "PILOT";
    const [enableBiometrics, setEnableBiometrics] = useState(true);
    const [isReasonExpanded, setIsReasonExpanded] = useState(false);
    const [isBiometricsPanelExpanded, setIsBiometricsPanelExpanded] = useState(false);
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
        setVideoElement,
        startAnalysis: startBiometricAnalysis,
        stopAnalysis: stopBiometricAnalysis,
        startBaselineSession,
        completeBaselineSession,
        clearBaseline,
        setBaseline
    } = useBiometrics();
    // Armed when a fresh baseline recording is started because the user had none on
    // the server — the recording is persisted to the DB once it completes.
    const baselineNeedsSaveRef = useRef(false);

    // Optional Muse EEG headband, self-paired from the assessment screen (see
    // EegConnectPanel below). Raw recording only — no derived stress/burnout
    // metric is computed from it (docs/muse-2-findings.md defers that). Owned
    // here, rather than inside the panel, so the survey lifecycle below can
    // mark question boundaries and upload the finished recording.
    const {
        status: eegStatus,
        device: eegDevice,
        error: eegError,
        available: eegAvailable,
        hasRecording: eegHasRecording,
        surveyStarted: eegSurveyStarted,
        connect: connectEeg,
        disconnect: disconnectEeg,
        markQuestionResolved: markEegQuestionResolved,
        markSurveyStarted: markEegSurveyStarted,
        beginNewRecording: beginNewEegRecording,
        finishForUpload: finishEegForUpload,
        splitRecording: splitEegRecording,
        getSessionTMs: getEegSessionTMs,
        addMarker: addEegMarker,
        save: saveEeg,
        getChannelSamples: getEegChannelSamples,
        channels: eegChannels
    } = useMuse();

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
                // Land each role on its natural home view on a returning session.
                if (data.role === "manager") setActiveTab("dashboard");
                else if (data.role !== "admin") setActiveTab("home");
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
        else if (tab.managerOnly && !isManager && !isAdmin) setActiveTab("assessment");
        else if (tab.guestOnly && !isGuest) setActiveTab("assessment");
    }, [activeTab, isAdmin, isManager, isGuest]);

    const handleLogin = useCallback((user: AuthUser) => {
        setCurrentUser(user);
        setSessionId(user.session_id);
        setAuthState("authenticated");
        if (user.role === "manager") setActiveTab("dashboard");
        else if (user.role !== "admin") setActiveTab("home");
    }, []);

    const handleLogout = useCallback(async () => {
        await fetch("/logout", { method: "POST", credentials: "same-origin" });
        setActiveTab("assessment");
        setAuthState("unauthenticated");
        setCurrentUser(null);
        setSessionId(crypto.randomUUID());
        // Reset to "unchecked" so the next login re-fetches this user's own consent
        // status instead of carrying over the previous account's.
        setConsentGiven(null);
        // Reset so the next login's WS connection is gated behind a fresh
        // /config fetch instead of racing ahead with the previous login's value.
        setSurveyTypeConfig(null);
    }, []);

    useEffect(() => {
        if (authState !== "authenticated") return;
        apiFetch("/config")
            .then(res => res.json())
            .then(data => {
                setEnableSurvey(data.enableSurveyMode);
                setSurveyTypeConfig({
                    surveyTypeOverridden: data.surveyTypeOverridden ?? false,
                    activeSurveyType: data.activeSurveyType ?? "PILOT",
                    availableSurveyTypes: data.availableSurveyTypes ?? ["PILOT"]
                });
            })
            .catch(err => console.error("Failed to fetch config:", err));
    }, [authState]);

    // On entering the assessment page (and whenever recording stops) ask the backend
    // whether this user has an open assessment: a paused one, or one left "active" by a
    // closed tab / dropped network. Yes → Start new / Continue / Close; no → Start only.
    useEffect(() => {
        if (authState !== "authenticated" || activeTab !== "assessment" || isRecording) return;
        let cancelled = false;
        fetchResumableAssessment()
            .then(run => {
                if (!cancelled) setResumable(run);
            })
            .catch(err => console.error("Failed to fetch resumable assessment:", err));
        return () => {
            cancelled = true;
        };
    }, [authState, activeTab, isRecording]);

    // Show the consent form each time the user lands on the assessment page (PILOT
    // only). Leaving the page forgets this visit's acceptance, so the next entry asks
    // again. Never interrupts an assessment that is already recording. Also fires once
    // /config resolves to PILOT while the user is already on the page.
    useEffect(() => {
        if (authState !== "authenticated") return;
        if (activeTab !== "assessment") {
            setConsentGiven(false);
            setShowConsent(false);
            return;
        }
        if (requiresConsent && consentGiven !== true && !isRecording) setShowConsent(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authState, activeTab, requiresConsent]);

    // Tracks the in-flight POST /survey-type request so Start can await it (see below) —
    // otherwise the very first thing onStartListening/onStartNewSurvey do is send
    // session.update over the ALREADY-OPEN WebSocket (a synchronous, near-instant call),
    // which reliably wins the race against this fetch's HTTP round-trip. That meant the
    // agent would build its question script from whichever survey type was bound
    // BEFORE this POST resolved, while anything read later (e.g. the progress bar's
    // question count) would already see the new type — exactly the "progress bar says
    // 7, agent asks the 5 TEST questions" symptom.
    const surveyTypeChangeRef = useRef<Promise<void> | null>(null);

    const handleSurveyTypeChange = useCallback(
        (type: string) => {
            const promise = (async () => {
                try {
                    const res = await apiFetch("/survey-type", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ surveyType: type, session_id: sessionId })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        setSurveyTypeConfig(prev => (prev ? { ...prev, activeSurveyType: data.activeSurveyType } : prev));
                    }
                } catch (err) {
                    console.error("Failed to set survey type:", err);
                }
            })();
            surveyTypeChangeRef.current = promise;
            return promise;
        },
        [sessionId]
    );

    // Baseline is loaded from localStorage by useBiometrics hook itself

    const { startSession, requestGreeting, sendBaselineCue, reconnect, refreshSession, addUserAudio, inputAudioBufferClear } = useRealTime({
        sessionId,
        // Belt-and-suspenders: also carried on the WS connect URL itself so the survey
        // type is known ATOMICALLY with connection setup, not dependent on the
        // /survey-type POST above having already landed by the time the socket opens.
        surveyType: surveyTypeConfig?.activeSurveyType,
        // Hold the socket closed until /config has resolved so the FIRST connection
        // attempt for this session_id always carries the right survey_type. Without
        // this, the socket could open a beat earlier with no survey_type, the backend
        // would bind the session to its default (TEST) survey, and — since that
        // binding is permanent for the session's lifetime — the correct survey_type
        // sent moments later on reconnect would be silently ignored.
        ready: authState === "authenticated" && surveyTypeConfig !== null,
        onWebSocketOpen: () => console.log("WebSocket connection opened"),
        onWebSocketClose: () => console.log("WebSocket connection closed"),
        onWebSocketError: event => console.error("WebSocket error:", event),
        onReceivedError: message => console.error("error", message),
        onReceivedResponseDone: () => {
            // Agent's turn is over — the next transcript delta starts a fresh bubble.
            agentTurnIdRef.current = null;
            // A baseline cue just finished generating → start its phase once it has played.
            baselineProtocol.notifyResponseDone();
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
            baselineProtocol.notifyAudioDelta(message.delta);
        },
        onReceivedSessionReady: () => {
            // Fresh session is live — let the new agent be heard again.
            suppressAgentAudioRef.current = false;
        },
        onReceivedInputAudioBufferSpeechStarted: () => {
            stopAudioPlayer();
            // Reserve the user's turn in the transcript now, in spoken order — whisper
            // transcription lands later (often after the agent has already replied).
            const id = crypto.randomUUID();
            pendingUserTurnIdRef.current = id;
            agentTurnIdRef.current = null;
            setChatTranscript(prev => [...prev, { id, role: "user", text: "" }]);
        },
        onReceivedResponseAudioTranscriptDelta: message => {
            const delta = message.delta ?? "";
            if (!delta) return;
            setChatTranscript(prev => {
                const last = prev[prev.length - 1];
                if (agentTurnIdRef.current && last && last.id === agentTurnIdRef.current) {
                    return prev.map(t => (t.id === last.id ? { ...t, text: t.text + delta } : t));
                }
                const id = crypto.randomUUID();
                agentTurnIdRef.current = id;
                return [...prev, { id, role: "agent", text: delta }];
            });
        },
        onReceivedInputAudioTranscriptionCompleted: message => {
            const text = (message.transcript ?? "").trim();
            const id = pendingUserTurnIdRef.current;
            pendingUserTurnIdRef.current = null;
            setChatTranscript(prev => {
                if (id && prev.some(t => t.id === id)) {
                    // Drop the reserved slot entirely if whisper came back empty.
                    return text ? prev.map(t => (t.id === id ? { ...t, text } : t)) : prev.filter(t => t.id !== id);
                }
                return text ? [...prev, { id: crypto.randomUUID(), role: "user", text }] : prev;
            });
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
            // No separate EEG mark here: survey.update and survey.biometric.update
            // both fire together, after record_survey_response resolves this
            // question (see markQuestionResolved in useMuse.ts) — there's no
            // earlier "question asked" instant to anchor on.
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
            if (eegHasRecording) markEegQuestionResolved(`${message.snapshot.domain} — ${message.snapshot.questionId}`);
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
                if (eegHasRecording) {
                    const file = finishEegForUpload();
                    if (file) {
                        apiFetch("/eeg-sessions", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ session_id: sessionId, survey_run_id: surveyRunId, segment_index: eegSegmentRef.current, file })
                        }).catch(err => console.error("Failed to upload EEG session:", err));
                    }
                    void disconnectEeg();
                }
            }
        },
        onReceivedRecoveryUpdate: (_message: RecoveryUpdate) => {
            setRecoveryUpdateTick(t => t + 1);
        }
    });

    const lastBiometricsPostRef = useRef(0);
    const biometricsPostInFlightRef = useRef(false);
    const handleBiometricsUpdate = useCallback(
        async (biometrics: BiometricResult) => {
            if (!enableBiometrics) return;

            // Once per second, never overlapping: the hook produces a result per camera
            // frame, and unordered concurrent POSTs could land an older value last.
            const now = Date.now();
            if (biometricsPostInFlightRef.current || now - lastBiometricsPostRef.current < 1000) return;
            lastBiometricsPostRef.current = now;
            biometricsPostInFlightRef.current = true;

            // null (not 0) while the blink window lacks enough face-visible time.
            const ready = biometrics.metrics.blinkRateReady;
            const blinkToSend = ready ? biometrics.metrics.blinkRateChangePercent : null;

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
                        blink_rate_bpm: ready ? biometrics.metrics.blinkRate : null,
                        blink_count: biometrics.metrics.blinkCount,
                        blink_valid_ms: biometrics.metrics.blinkValidMs,
                        baseline_blink_rate: baselineData?.blinkRate ?? null,
                        pupil_mm_change: pupilMmChange,
                        face_emotion: "NEUTRAL",
                        left_gaze_position: biometrics.metrics.leftGaze.label,
                        right_gaze_position: biometrics.metrics.rightGaze.label
                    })
                });
            } catch (err) {
                console.error("Failed to update biometrics:", err);
            } finally {
                biometricsPostInFlightRef.current = false;
            }
        },
        [sentiment, enableBiometrics, sessionId, baselineData]
    );

    // Stress analysis effect — polls /analyze-stress off the live blink rate every 5s.
    // Reads the latest biometrics through a ref: depending on currentBiometrics directly
    // re-ran this effect (and fired a request) on every camera frame.
    const latestBiometricsRef = useRef(currentBiometrics);
    latestBiometricsRef.current = currentBiometrics;
    const faceDetected = !!currentBiometrics?.faceDetected;
    useEffect(() => {
        if (!isRecording || !faceDetected || !enableBiometrics) {
            return;
        }

        const fetchStressAnalysis = async () => {
            const metrics = latestBiometricsRef.current?.metrics;
            // Skip only when there's no real rate yet — a true 0 blinks/min is still data.
            if (!metrics?.blinkRateReady) return;

            const blinkRate = metrics.blinkRate;
            const baselineBlinkRate = baselineData?.blinkRate;

            try {
                const response = await apiFetch("/analyze-stress", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        session_id: sessionId,
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
    }, [isRecording, faceDetected, enableBiometrics, baselineData, sessionId]);

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

    const { reset: resetAudioPlayer, play: playAudio, stop: stopAudioPlayer, getAnalyser: getAudioAnalyser } = useAudioPlayer();
    const { start: startAudioRecording, stop: stopAudioRecording } = useAudioRecorder({ onAudioRecorded: addUserAudio });

    // Clear all per-assessment UI state so a new run starts from a clean slate.
    // Crucially re-enables biometrics, which is switched off when a survey completes.
    const resetAssessmentState = useCallback(() => {
        setChatTranscript([]);
        agentTurnIdRef.current = null;
        pendingUserTurnIdRef.current = null;
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
        // The run id itself is set by the caller: minted by the backend on Start, or
        // the paused run's id on Continue.
    }, []);

    // Resolve the user's baseline before a conversation starts. Returns true when a
    // stored (non-expired) baseline was found, i.e. the baseline protocol is skipped:
    //  • DB has one  → inject it and skip the baseline protocol.
    //  • DB has none → wipe local state so the protocol runs, and arm a save so the
    //                  fresh baseline is persisted to the DB on completion.
    //  • fetch fails → run the protocol anyway (without saving): the backend resolves the
    //                  phase from the DB itself, and a protocol that runs while the backend
    //                  is already in "survey" is harmless, whereas skipping it while the
    //                  backend is gated in "baseline" would leave the agent silent.
    const resolveBaseline = useCallback(async (): Promise<boolean> => {
        try {
            const res = await apiFetch("/baseline");
            if (res.ok) {
                const data = await res.json();
                if (data.baseline) {
                    setBaseline({ pupilSize: data.baseline.pupilSize, blinkRate: data.baseline.blinkRate, timestamp: Date.now() });
                    baselineNeedsSaveRef.current = false;
                    return true;
                }
                clearBaseline();
                baselineNeedsSaveRef.current = true;
                return false;
            }
        } catch (err) {
            console.warn("[App] Baseline fetch failed; running the baseline protocol without saving", err);
        }
        baselineNeedsSaveRef.current = false;
        return false;
    }, [setBaseline, clearBaseline]);

    // ── Baseline protocol (new / expired baseline only) ─────────────────────────────
    // 3 min eyes open (camera biometrics + EEG), then — only with an EEG headband —
    // 3 min eyes closed (EEG only). The agent is silent apart from one spoken cue per
    // phase (the backend drops mic audio while the session is in the "baseline" phase).
    // On completion the baseline is persisted, the EEG recording is split so
    // eeg_sessions only holds the survey, and the survey phase is unlocked.
    const baselineCameraRef = useRef<{ pupilSize: number; blinkRate: number } | null>(null);
    const baselinePhaseStartTMsRef = useRef(0);
    // Set once this assessment's protocol has completed, so a stop/resume (or a failed
    // camera capture that left nothing stored) never runs it a second time.
    const baselineDoneRef = useRef(false);

    const finishBaselineProtocol = async ({ eyesClosed }: { eyesClosed: boolean }) => {
        baselineDoneRef.current = true;
        // Everything recorded so far is the baseline; a fresh recorder captures the survey
        // itself (uploaded to eeg_sessions when the last question is answered).
        const eegBaseline = eegHasRecording ? splitEegRecording() : null;
        markEegSurveyStarted();

        const camera = baselineCameraRef.current;
        if (baselineNeedsSaveRef.current && camera) {
            baselineNeedsSaveRef.current = false;
            apiFetch("/baseline", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pupilSize: camera.pupilSize, blinkRate: camera.blinkRate, eeg: eegBaseline })
            }).catch(err => console.warn("[App] Failed to persist baseline:", err));
        } else if (!camera) {
            console.warn("[App] Baseline protocol finished without usable camera data — baseline not stored");
        }

        try {
            await apiFetch("/survey-phase", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: sessionId, phase: "survey" })
            });
        } catch (err) {
            console.warn("[App] Failed to unlock survey phase:", err);
        }
        // session.update first (re-injects the now-unlocked survey script), then the cue
        // that asks the agent to open the survey — same socket, so they arrive in order.
        refreshSession();
        sendBaselineCue(eyesClosed ? "survey_start_after_closed" : "survey_start_after_open");
    };

    const baselineProtocol = useBaselineProtocol({
        eyesOpenSeconds: BASELINE_EYES_OPEN_SECONDS,
        eyesClosedSeconds: BASELINE_EYES_CLOSED_SECONDS,
        sendCue: sendBaselineCue,
        onPhaseStart: phase => {
            baselinePhaseStartTMsRef.current = getEegSessionTMs();
            if (phase === "eyes_open" && enableBiometrics) startBaselineSession(BASELINE_EYES_OPEN_SECONDS);
        },
        onPhaseEnd: phase => {
            // Camera biometrics come from the eyes-open phase only (no blinks/pupil with eyes shut).
            if (phase === "eyes_open" && enableBiometrics) baselineCameraRef.current = completeBaselineSession();
            addEegMarker(`baseline_${phase}`, baselinePhaseStartTMsRef.current, getEegSessionTMs());
        },
        onComplete: result => void finishBaselineProtocol(result)
    });

    const startBaselineProtocol = () => {
        baselineCameraRef.current = null;
        baselineProtocol.start(eegHasRecording);
    };

    // Gates a start action (Start / Start new / Continue) behind this visit's consent
    // for the pilot survey (normally already given on entering the page — this catches
    // e.g. a survey-type switch to PILOT after landing). If it hasn't been given, the
    // action is stashed and the modal is shown instead; ConsentModal's onAgree resumes it.
    const runWithConsent = useCallback(
        (action: () => void) => {
            if (requiresConsent && consentGiven !== true) {
                pendingStartActionRef.current = action;
                setShowConsent(true);
                return;
            }
            action();
        },
        [requiresConsent, consentGiven]
    );

    // Primary toggle: start / stop / resume. It never resets — a stopped survey
    // (mid-way) is left untouched so pressing it again resumes, and after completion
    // it simply reconnects the user for report Q&A. Starting a brand-new assessment
    // is the dedicated "Start New Survey" button's job (onStartNewSurvey).
    const onStartListening = async () => {
        if (isRecording) return;
        // Only nag about this on a genuinely fresh start (nothing answered yet) — once
        // there's real progress, it's too late for the headband to matter and repeatedly
        // asking on every pause/resume would just be noise. EEG stays fully optional:
        // this is a reminder, not a gate — Continue proceeds with no EEG either way.
        if (!eegHasRecording && !hasAssessment) {
            const proceed = window.confirm(
                "EEG headband isn't connected. If you plan to use it for this assessment, cancel and pair it first — otherwise no EEG data will be recorded for this session. Continue without it?"
            );
            if (!proceed) return;
        }
        setIsRecording(true);
        // Make sure any survey-type selection has actually landed server-side before
        // we send session.update — otherwise the agent's question script can be built
        // from the PREVIOUS survey type (see surveyTypeChangeRef above).
        if (surveyTypeChangeRef.current) {
            await surveyTypeChangeRef.current;
        }
        startSession();
        resetAudioPlayer();
        // The stored baseline decides how the conversation opens: a fresh assessment
        // with no valid baseline runs the baseline protocol (its first cue replaces the
        // greeting); everyone else — returning users, resumes, post-report Q&A — gets the
        // normal greeting. Matches the phase the backend resolves from the same DB row.
        const hasStoredBaseline = await resolveBaseline();
        if (enableSurvey && !hasAssessment && !hasStoredBaseline && !baselineDoneRef.current) {
            await startAudioRecording();
            startBaselineProtocol();
            return;
        }
        requestGreeting();
        // Anchors the EEG recording's "the assessment actually started here" instant —
        // distinct from whenever the headband happened to pair (see markSurveyStarted
        // in useMuse.ts). No-ops if EEG isn't connected, or on a later resume (idempotent
        // on the Recorder itself, so only this genuinely-first call takes effect). With a
        // baseline protocol it is set instead when the protocol completes.
        markEegSurveyStarted();
        await startAudioRecording();
    };

    const onStopListening = async () => {
        if (!isRecording) return;
        // Stopping mid-baseline discards it; the next Start runs the protocol from the top.
        if (baselineProtocol.isActive) {
            baselineProtocol.cancel();
            clearBaseline();
        }
        await stopAudioRecording();
        stopAudioPlayer();
        inputAudioBufferClear();
        setIsRecording(false);
    };

    // Start (and "Start new"): closes any open assessment server-side and starts a fresh
    // one. POST /me/assessment/start fully resets the SAME backend session (clears
    // survey_results, conversation_state and the reconnect counter) and mints the new
    // run's id; the UI is wiped and the realtime socket is forced to reconnect cleanly so
    // the agent has no memory of the previous survey.
    const onStartNewSurvey = async () => {
        // Silence the agent the instant the button is pressed — window.confirm() blocks the
        // JS main thread, but already-buffered speech keeps playing on the audio thread
        // underneath the dialog. Flushing the player here "pauses" the agent while the user
        // decides, instead of letting it talk over the confirmation prompt.
        stopAudioPlayer();
        // Only confirm when something is actually discarded — the very first Start has nothing.
        if (resumable || hasAssessment || isRecording) {
            const message = resumable
                ? "This closes your paused assessment (it can't be continued afterwards) and starts a new one. Continue?"
                : "This discards the current assessment and starts a fresh survey. Continue?";
            if (!window.confirm(message)) return;
        }
        // A new assessment always starts a genuinely fresh recording below
        // (beginNewEegRecording). Only asked if the headband isn't connected at all.
        if (!eegHasRecording) {
            const proceed = window.confirm(
                "EEG headband isn't connected. If you plan to use it for this new assessment, cancel and pair it first — otherwise no EEG data will be recorded for this session. Continue without it?"
            );
            if (!proceed) return;
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
        baselineProtocol.cancel();
        baselineDoneRef.current = false;
        // Any survey-type selection must have landed before the server binds the new run.
        if (surveyTypeChangeRef.current) {
            await surveyTypeChangeRef.current;
        }
        let newRunId: string;
        try {
            const started = await startAssessment(surveyTypeConfig?.activeSurveyType);
            newRunId = started.surveyRunId;
        } catch (err) {
            // Fall back to the pre-lifecycle flow: the report still persists the run (as
            // completed), it just can't be paused/continued.
            console.error("Failed to start assessment run; continuing without pause/resume:", err);
            await apiFetch("/clear-conversation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: sessionId })
            }).catch(e => console.error("Failed to reset session for new survey:", e));
            newRunId = crypto.randomUUID();
        }
        resetAssessmentState();
        setSurveyRunId(newRunId);
        setResumable(null);
        setAssessmentComplete(false);
        eegSegmentRef.current = 0;
        // Keep the headband connected across a retake — a fresh Recorder tied to the
        // new surveyRunId, not a full reconnect (the participant already consented).
        if (eegHasRecording) beginNewEegRecording(new Date().toISOString());

        // Settle the baseline decision BEFORE we start recording. resolveBaseline either
        // injects a stored baseline (the protocol is skipped) or clears it (the protocol
        // runs) — agreeing with the phase the backend resolves from the same baseline on
        // the fresh connection below (DB hit → returning-user "survey"; miss → "baseline").
        const hasStoredBaseline = await resolveBaseline();

        setIsRecording(true);
        reconnect();
        startSession();
        resetAudioPlayer();
        // Arm the opening turn now (deferred until the reconnect's session.created, since
        // the socket is mid-reopen here) so the agent opens the fresh conversation the
        // instant the session is ready — the baseline protocol's first cue, or a greeting.
        if (enableSurvey && !hasStoredBaseline) {
            startBaselineProtocol();
        } else {
            requestGreeting();
            // Anchors this retake's own "assessment actually started here" instant on the
            // fresh Recorder created by beginNewEegRecording above — see markSurveyStarted.
            markEegSurveyStarted();
        }
        await startAudioRecording();
    };

    // Pause: stop listening and park the run server-side. The backend persists this
    // segment's timeline frames (answers were persisted as each was scored); the EEG
    // recorded so far is uploaded as this segment's own file. After the report, the
    // run is already complete — Pause then just stops the post-report conversation.
    const onPauseAssessment = async () => {
        // Read before onStopListening cancels the protocol.
        const pausedDuringBaseline = baselineProtocol.isActive;
        await onStopListening();
        if (assessmentComplete) return;
        // Mid-baseline the recorder holds a partial BASELINE recording, not survey data —
        // discarded like the camera baseline (Continue re-runs the protocol and starts a
        // fresh recorder), never uploaded as a survey segment.
        if (eegHasRecording && !pausedDuringBaseline) {
            // Finish this segment's recording and keep the headband streaming into a
            // fresh recorder (discarded/replaced on Continue).
            const file = splitEegRecording();
            if (file) {
                apiFetch("/eeg-sessions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ session_id: sessionId, survey_run_id: surveyRunId, segment_index: eegSegmentRef.current, file })
                }).catch(err => console.error("Failed to upload EEG segment:", err));
            }
        }
        try {
            await pauseAssessment();
        } catch (err) {
            // e.g. the run was never bound (start failed) — nothing to park server-side.
            console.warn("Failed to pause assessment:", err);
        }
        // The isRecording → false transition also refetches; this makes it immediate.
        setResumable(await fetchResumableAssessment().catch(() => null));
    };

    // Continue: resume the open run where the user left off. The backend rehydrates the
    // live session (answered questions, next timeline segment) and the agent picks up via
    // its reconnect instructions; the stored baseline is reused when there is one.
    const onContinueAssessment = async () => {
        if (!resumable) {
            // Nothing paused — Continue after a finished report resumes the conversation.
            await onStartListening();
            return;
        }
        stopAudioPlayer();
        if (!eegHasRecording) {
            const proceed = window.confirm(
                "EEG headband isn't connected. If you plan to use it for the rest of this assessment, cancel and pair it first — otherwise no EEG data will be recorded for the remaining questions. Continue without it?"
            );
            if (!proceed) return;
        }
        let run: AssessmentContinued;
        try {
            run = await continueAssessment(resumable.surveyRunId);
        } catch (err) {
            console.error("Failed to continue assessment:", err);
            window.alert("This assessment can no longer be continued. Please start a new one.");
            setResumable(await fetchResumableAssessment().catch(() => null));
            return;
        }
        suppressAgentAudioRef.current = true;
        pendingGuardrailResetRef.current = false;
        baselineProtocol.cancel();
        resetAssessmentState();
        setSurveyRunId(run.surveyRunId);
        setBiometricSnapshots(run.snapshots);
        setSurveyCompleted(run.answered);
        setSurveyTotal(run.total);
        setAssessmentComplete(false);
        setResumable(null);
        // The run's own survey type is already bound server-side by /continue (the WS
        // survey_type param is ignored once a session has one), so the selector is left
        // alone — changing it would change the WS URL and force an extra reconnect.
        // A fresh recorder for this segment — whatever streamed while paused is dropped.
        eegSegmentRef.current = run.segmentIndex;
        if (eegHasRecording) beginNewEegRecording(new Date().toISOString());

        const hasStoredBaseline = await resolveBaseline();
        const runBaseline = enableSurvey && run.baselineRequired && !hasStoredBaseline;
        baselineDoneRef.current = !runBaseline;

        setIsRecording(true);
        reconnect();
        startSession();
        resetAudioPlayer();
        if (runBaseline) {
            startBaselineProtocol();
        } else {
            requestGreeting();
            markEegSurveyStarted();
        }
        await startAudioRecording();
    };

    // Finish: end a completed assessment's session and return the page to its starting
    // state. The report is already saved (History); the run's status isn't touched.
    // Resets the server session too, so the post-report Q&A context doesn't linger.
    const onFinishAssessment = async () => {
        if (!window.confirm("Finish this assessment? Your report stays saved in History.")) return;
        stopAudioPlayer();
        pendingGuardrailResetRef.current = false;
        try {
            await apiFetch("/clear-conversation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: sessionId })
            });
        } catch (err) {
            console.error("Failed to reset session on finish:", err);
        }
        resetAssessmentState();
        setAssessmentComplete(false);
        setRecoveryWindowOpen(false);
        setResumable(await fetchResumableAssessment().catch(() => null));
    };

    // Close: discard the paused run for good (it stays out of history and dashboards).
    const onCloseAssessment = async () => {
        if (!resumable) return;
        if (!window.confirm("Close this paused assessment? It can't be continued afterwards.")) return;
        try {
            await closeAssessment(resumable.surveyRunId);
        } catch (err) {
            console.error("Failed to close assessment:", err);
        }
        setResumable(await fetchResumableAssessment().catch(() => null));
    };

    // Called by DetailedReport once POST /analyze-report has resolved (report
    // post-processed + persisted to DB). Clears the loader and arms the strict
    // report-only hard reset, performed on the next response.done.
    const handleReportReady = useCallback(() => {
        setReportLoading(false);
        pendingGuardrailResetRef.current = true;
    }, []);

    const handleRerecordBaseline = useCallback(async () => {
        // Drop the server copy too, and arm a save so the new recording replaces it. Awaited
        // so the delete is durable before any subsequent Start-New-Survey reads the baseline
        // (both the frontend resolveBaseline GET and the backend phase resolution) — otherwise
        // a stale baseline would be read and the fresh baseline protocol skipped.
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

    // There is an assessment on screen worth discarding/resetting.
    const hasAssessment = surveyCompleted > 0 || assessmentComplete;
    // Live "Blink Change" needs both a baseline rate and enough face-visible time —
    // otherwise it's "not enough data", never a real +0.0%.
    const liveBlinkChangeReady = !!currentBiometrics?.metrics.blinkRateReady && (currentBiometrics?.metrics.baselineRateForChange ?? 0) > 0;
    // Face-visible time behind the blink count, as m:ss.
    const formatValidTime = (ms: number) => {
        const total = Math.floor(ms / 1000);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    };
    // Which Start / Pause / Continue / Close buttons are shown (see lib/assessment.ts).
    const controls = assessmentControls({ isRecording, hasResumable: resumable !== null, assessmentComplete });
    const controlCount = Object.values(controls).filter(Boolean).length;

    // Single source of truth for the always-visible baseline card's state:
    //  • recording — the baseline protocol is running (cue or eyes-open/closed phase)
    //  • recorded  — a valid baseline exists
    //  • none      — no baseline (the protocol runs on the next assessment start)
    // Note: a "completed" status without baselineData means capture finished with no usable
    // samples (e.g. no face) — surface that as "none" so the user can record again.
    const baselineState: "recording" | "recorded" | "none" = baselineProtocol.isActive
        ? "recording"
        : baselineSessionStatus === "completed" && baselineData
          ? "recorded"
          : "none";
    const baselinePhaseLabel = baselineProtocol.state.phase === "eyes_closed" ? "Eyes closed" : "Eyes open";
    const baselineStepNote =
        baselineProtocol.state.stage === "cue"
            ? "Listen to the instruction…"
            : baselineProtocol.state.phase === "eyes_closed"
              ? "Keep your eyes closed and relax — you'll be told when to open them."
              : "Keep your eyes open, look at the screen and stay still.";
    const baselinePhaseProgress =
        baselineProtocol.state.stage === "recording" && baselineProtocol.state.phaseSeconds > 0
            ? ((baselineProtocol.state.phaseSeconds - baselineProtocol.secondsLeft) / baselineProtocol.state.phaseSeconds) * 100
            : 0;

    if (authState === "checking") {
        return (
            <div className="ciq-page flex min-h-screen items-center justify-center">
                <p className="text-sm text-[color:var(--ciq-text-60)]">Loading…</p>
            </div>
        );
    }

    if (authState === "unauthenticated") {
        return authView === "signup" ? (
            <SignupScreen onSignupSuccess={() => setAuthView("login")} onSwitchToLogin={() => setAuthView("login")} />
        ) : (
            <LoginScreen onLogin={handleLogin} onSwitchToSignup={() => setAuthView("signup")} />
        );
    }

    return (
        <div className="ciq-page flex h-screen flex-col overflow-hidden text-[color:var(--ciq-text-strong)]">
            <ErrorBoundary label="recovery-window-screen">
                <Suspense fallback={null}>
                    <RecoveryWindowScreen
                        open={recoveryWindowOpen}
                        onClose={() => setRecoveryWindowOpen(false)}
                        surveyRunId={surveyRunId}
                        sessionId={sessionId}
                        scoreReady={!reportLoading}
                        updateSignal={recoveryUpdateTick}
                        isRecording={isRecording}
                        onResumeListening={() => runWithConsent(onStartListening)}
                        cameraStream={cameraStream}
                        chatTranscript={chatTranscript}
                        refreshRealtimeSession={refreshSession}
                        requestAgentTurn={requestGreeting}
                    />
                </Suspense>
            </ErrorBoundary>

            {/* ── Floating pill header ── */}
            <div className="sticky top-0 z-40 px-3 pb-2 pt-4 sm:px-5">
                <div className="flex items-center justify-between gap-3 rounded-[28px] border border-[color:var(--ciq-border)] bg-[color:var(--ciq-header-bg)] px-4 py-3 shadow-[0_30px_100px_rgba(0,0,0,0.42),inset_0_1px_1px_rgba(255,255,255,0.22)] saturate-150 backdrop-blur-[34px] sm:rounded-[40px] sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                        <img src={logo} alt="CIQ logo" className="ciq-logo h-9 w-9 shrink-0 sm:h-10 sm:w-10" />
                        <div className="min-w-0">
                            <h1 className="truncate font-display text-base font-bold tracking-tight text-[color:var(--ciq-text-strong)] sm:text-xl">
                                CIQ Voice Agent
                            </h1>
                            <p className="hidden truncate text-xs text-[color:var(--ciq-text-46)] sm:block">
                                {surveyTypeConfig?.activeSurveyType === "READINESS" ? "Readiness Assessment Platform" : "Burnout Assessment Platform"}
                            </p>
                        </div>
                    </div>

                    {/* Desktop/laptop nav — unchanged, always visible at lg+ */}
                    <div className="hidden items-center gap-3 lg:flex">
                        <nav className="flex items-center gap-1">
                            {NAV_TABS.filter(
                                tab => (!tab.adminOnly || isAdmin) && (!tab.managerOnly || isManager || isAdmin) && (!tab.guestOnly || isGuest)
                            ).map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    aria-current={activeTab === tab.id ? "page" : undefined}
                                    className={`ciq-touch rounded-full px-5 text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-blue)] ${
                                        activeTab === tab.id
                                            ? "border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] font-semibold text-[color:var(--ciq-text-strong)] shadow-[0_8px_20px_rgba(0,0,0,0.12)]"
                                            : "font-medium text-[color:var(--ciq-text-60)] hover:bg-[color:var(--ciq-tile)] hover:text-[color:var(--ciq-text-86)]"
                                    }`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </nav>
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

                    {/* Mobile/tablet hamburger — collapses the nav below lg */}
                    <button
                        onClick={() => setMobileNavOpen(o => !o)}
                        aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
                        aria-expanded={mobileNavOpen}
                        className="ciq-touch flex shrink-0 items-center justify-center rounded-full text-[color:var(--ciq-text-68)] transition-colors hover:bg-[color:var(--ciq-tile)] lg:hidden"
                    >
                        {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                    </button>
                </div>

                {/* Mobile/tablet nav drawer — stacked list, shown below lg only */}
                {mobileNavOpen && (
                    <div className="mt-2 rounded-[24px] border border-[color:var(--ciq-border)] bg-[color:var(--ciq-header-bg)] p-3 shadow-[0_30px_100px_rgba(0,0,0,0.42)] backdrop-blur-[34px] lg:hidden">
                        <nav className="flex flex-col gap-1">
                            {NAV_TABS.filter(
                                tab => (!tab.adminOnly || isAdmin) && (!tab.managerOnly || isManager || isAdmin) && (!tab.guestOnly || isGuest)
                            ).map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => {
                                        setActiveTab(tab.id);
                                        setMobileNavOpen(false);
                                    }}
                                    aria-current={activeTab === tab.id ? "page" : undefined}
                                    className={`ciq-touch w-full rounded-2xl px-4 text-left text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-blue)] ${
                                        activeTab === tab.id
                                            ? "border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] font-semibold text-[color:var(--ciq-text-strong)]"
                                            : "font-medium text-[color:var(--ciq-text-60)] hover:bg-[color:var(--ciq-tile)] hover:text-[color:var(--ciq-text-86)]"
                                    }`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </nav>
                        <div className="mt-2 flex items-center justify-between gap-2 border-t border-[color:var(--ciq-divider)] px-1 pt-3">
                            <span className="truncate text-xs text-[color:var(--ciq-text-60)]">{currentUser?.name}</span>
                            <button
                                onClick={() => {
                                    setMobileNavOpen(false);
                                    handleLogout();
                                }}
                                className="ciq-touch shrink-0 rounded-full bg-[color:var(--ciq-tile-strong)] px-4 text-xs font-medium text-[color:var(--ciq-text-68)] transition-colors hover:bg-[color:var(--ciq-hover)]"
                            >
                                Sign Out
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Guest Home / landing ── (plain guests only) */}
            {activeTab === "home" && isGuest && (
                <main className="relative flex-1 overflow-hidden">
                    <GuestLanding userName={currentUser?.name} onStartAssessment={() => setActiveTab("assessment")} />
                </main>
            )}

            {/* ── Manager Dashboard ── */}
            {activeTab === "dashboard" && (isManager || isAdmin) && (
                <main className="relative flex-1 overflow-hidden">
                    <ManagerLanding theme="petroleum" />
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

            {/* ── Muse EEG ── (admin-only, like the Admin panel) */}
            {activeTab === "eeg" && isAdmin && (
                <main className="flex-1 overflow-y-auto p-4">
                    <div className="grid w-full grid-cols-12 gap-4">
                        <div className="col-span-12 lg:col-span-8 lg:col-start-3">
                            <MusePanel />
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
                                                {enableSurvey && surveyTypeConfig && (
                                                    <div className="flex items-center gap-1.5">
                                                        {surveyTypeConfig.surveyTypeOverridden ? (
                                                            <span
                                                                className="rounded px-2 py-1 text-[10px] font-medium text-[color:var(--ciq-text-strong)]"
                                                                title="Survey type locked by deployment"
                                                            >
                                                                {surveyTypeConfig.activeSurveyType}
                                                            </span>
                                                        ) : (
                                                            surveyTypeConfig.availableSurveyTypes.map(type => (
                                                                <button
                                                                    key={type}
                                                                    onClick={() => handleSurveyTypeChange(type)}
                                                                    disabled={isRecording}
                                                                    title="Survey type"
                                                                    className={`ciq-badge-tag rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                                                                        surveyTypeConfig.activeSurveyType === type
                                                                            ? "ciq-badge-tag-active bg-[#5ee5a1] text-[#0d1a14]"
                                                                            : "bg-[color:var(--ciq-tile-strong)] text-[color:var(--ciq-text-68)] hover:bg-[color:var(--ciq-hover)]"
                                                                    }`}
                                                                >
                                                                    {type}
                                                                </button>
                                                            ))
                                                        )}
                                                    </div>
                                                )}
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
                                            onVideoReady={setVideoElement}
                                            onStreamReady={setCameraStream}
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
                                            {enableSurvey && (
                                                <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3">
                                                    <div className="space-y-2">
                                                        <div className="text-sm font-medium text-[color:var(--ciq-text-strong)]">Survey Assessment</div>
                                                        {surveyTotal && surveyTotal > 0 && surveyQuestions && surveyQuestions.length > 0 ? (
                                                            <>
                                                                <div className="text-xs text-[color:var(--ciq-text-60)]">
                                                                    Progress: {surveyCompleted ?? 0}/{surveyTotal}
                                                                </div>
                                                                <div className="text-xs text-[color:var(--ciq-text-strong)]">
                                                                    {surveyQuestions[surveyQuestions.length - 1].text}
                                                                </div>
                                                                {surveyOptions && surveyOptions.length > 0 && (
                                                                    <div className="mt-1 flex flex-wrap gap-2">
                                                                        {surveyOptions.map(opt => (
                                                                            <span
                                                                                key={opt.value}
                                                                                className="rounded bg-[color:var(--ciq-tile-strong)] px-2 py-0.5 text-xs text-[color:var(--ciq-text-68)]"
                                                                            >
                                                                                {opt.label}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                                <div className="mt-2">
                                                                    <div className="h-1 w-full overflow-hidden rounded-full bg-[color:var(--ciq-tile-strong)]">
                                                                        <div
                                                                            className="h-full bg-[color:var(--ciq-accent-blue)] transition-all duration-300"
                                                                            style={{ width: `${((surveyCompleted ?? 0) / surveyTotal) * 100}%` }}
                                                                        ></div>
                                                                    </div>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <div className="text-xs text-[color:var(--ciq-text-60)]">No active survey</div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                            {/* Controls — driven by the assessment lifecycle (lib/assessment.ts):
                                            recording → [Pause]; paused run → [Start new][Continue][Close];
                                            finished report → [Start new][Continue]; otherwise → [Start]. */}
                                            {controls.close && resumable && (
                                                <p className="mb-2 text-xs text-[color:var(--ciq-text-60)]" role="status">
                                                    {t("app.pausedAssessmentNotice", { answered: resumable.answered, total: resumable.total }) ||
                                                        `Paused assessment: ${resumable.answered} of ${resumable.total} answered`}
                                                </p>
                                            )}
                                            <div
                                                className={`grid gap-2 ${controlCount === 3 ? "grid-cols-2 sm:grid-cols-3" : controlCount === 2 ? "grid-cols-2" : "grid-cols-1"}`}
                                            >
                                                {controls.start && (
                                                    <Button
                                                        onClick={() => runWithConsent(onStartNewSurvey)}
                                                        className="ciq-btn-primary ciq-touch-lg flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-blue)]"
                                                    >
                                                        <Mic className="h-4 w-4" />
                                                        {t("app.startAssessment") || "Start Assessment"}
                                                    </Button>
                                                )}
                                                {controls.startNew && (
                                                    <Button
                                                        onClick={() => runWithConsent(onStartNewSurvey)}
                                                        variant="outline"
                                                        className="ciq-btn-secondary ciq-touch order-3 col-span-2 flex items-center justify-center gap-2 rounded-xl text-sm font-semibold focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-purple)] sm:order-1 sm:col-span-1"
                                                    >
                                                        <RotateCcw className="h-4 w-4" />
                                                        {t("app.startNewSurvey") || "Start New Survey"}
                                                    </Button>
                                                )}
                                                {controls.continue && (
                                                    <Button
                                                        onClick={() => runWithConsent(onContinueAssessment)}
                                                        className="ciq-btn-primary ciq-touch-lg order-1 flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-blue)] sm:order-2"
                                                    >
                                                        <Mic className="h-4 w-4" />
                                                        {resumable
                                                            ? t("app.continueAssessment") || "Continue Assessment"
                                                            : t("app.continueConversation") || "Continue Conversation"}
                                                    </Button>
                                                )}
                                                {controls.close && (
                                                    <Button
                                                        onClick={onCloseAssessment}
                                                        variant="outline"
                                                        className="ciq-btn-secondary ciq-touch order-2 flex items-center justify-center gap-2 rounded-xl border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] text-sm font-semibold text-[color:var(--ciq-text-68)] hover:bg-[color:var(--ciq-hover)] focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-red)] sm:order-3"
                                                    >
                                                        <X className="h-4 w-4" />
                                                        {t("app.closeAssessment") || "Close"}
                                                    </Button>
                                                )}
                                                {controls.finish && (
                                                    <Button
                                                        onClick={onFinishAssessment}
                                                        variant="outline"
                                                        className="ciq-btn-secondary ciq-touch order-2 flex items-center justify-center gap-2 rounded-xl border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] text-sm font-semibold text-[color:var(--ciq-text-68)] hover:bg-[color:var(--ciq-hover)] focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-green)] sm:order-3"
                                                    >
                                                        <CheckCircle2 className="h-4 w-4" />
                                                        {t("app.finishAssessment") || "Finish"}
                                                    </Button>
                                                )}
                                                {controls.pause && (
                                                    <Button
                                                        onClick={onPauseAssessment}
                                                        variant="outline"
                                                        className="ciq-btn-secondary ciq-touch flex items-center justify-center gap-2 rounded-xl border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] text-sm font-semibold text-[color:var(--ciq-text-68)] hover:bg-[color:var(--ciq-hover)] focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-red)]"
                                                    >
                                                        <MicOff className="h-4 w-4" />
                                                        {t("app.pauseAssessment") || "Pause"}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </section>

                            {/* Biometrics & Sentiment Panel - below the video */}
                            <section className="ciq-glass-card">
                                <div className="flex h-full flex-col">
                                    <button
                                        type="button"
                                        onClick={() => setIsBiometricsPanelExpanded(prev => !prev)}
                                        aria-expanded={isBiometricsPanelExpanded}
                                        aria-controls="biometrics-sentiment-panel"
                                        className={`flex w-full items-center gap-2 px-5 py-3 text-left focus:outline-none ${
                                            isBiometricsPanelExpanded ? "border-b border-[color:var(--ciq-divider)]" : ""
                                        }`}
                                    >
                                        <ChevronRight
                                            className={`h-4 w-4 shrink-0 text-[color:var(--ciq-text-60)] transition-transform duration-200 ${
                                                isBiometricsPanelExpanded ? "rotate-90" : ""
                                            }`}
                                        />
                                        <h2 className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">Biometrics &amp; Sentiment</h2>
                                    </button>
                                    <div
                                        id="biometrics-sentiment-panel"
                                        className={`flex-1 space-y-4 overflow-y-auto p-4 ${isBiometricsPanelExpanded ? "" : "hidden"}`}
                                    >
                                        {/* Biometric Baseline — always visible; its inner content
                                            reflects baselineState (recorded / recording / needed / none). */}
                                        <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3">
                                            <div className="mb-2 flex items-center justify-between">
                                                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[color:var(--ciq-text-60)]">Baseline</p>
                                                <span
                                                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${
                                                        baselineState === "recorded"
                                                            ? "text-[color:var(--ciq-accent-green)]"
                                                            : baselineState === "recording"
                                                              ? "text-[color:var(--ciq-accent-blue)]"
                                                              : "text-[color:var(--ciq-text-60)]"
                                                    }`}
                                                >
                                                    {baselineState === "recorded" ? "RECORDED" : baselineState === "recording" ? "RECORDING" : "NOT SET"}
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
                                                    <Button
                                                        onClick={handleRerecordBaseline}
                                                        size="sm"
                                                        variant="outline"
                                                        className="h-6 shrink-0 px-2 text-[10px]"
                                                    >
                                                        <RotateCcw className="mr-1 h-3 w-3" />
                                                        Rerecord
                                                    </Button>
                                                </div>
                                            )}

                                            {/* Recording — baseline protocol phase + countdown */}
                                            {baselineState === "recording" && (
                                                <div>
                                                    <div className="mb-2 flex items-center gap-2">
                                                        <Loader2 className="h-4 w-4 animate-spin text-[color:var(--ciq-accent-blue)]" />
                                                        <span className="text-xs font-medium text-[color:var(--ciq-accent-blue)]">{baselinePhaseLabel}</span>
                                                        {baselineProtocol.state.stage === "recording" && (
                                                            <span className="font-data ml-auto text-xs text-[color:var(--ciq-text-strong)]">
                                                                {formatCountdown(baselineProtocol.secondsLeft)} left
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="h-2 w-full rounded-full bg-[color:var(--ciq-track)]">
                                                        <div
                                                            className="h-2 rounded-full bg-blue-500 transition-all duration-1000"
                                                            style={{ width: `${baselinePhaseProgress}%` }}
                                                        />
                                                    </div>
                                                    <div className="mt-1.5 flex items-center justify-between gap-2">
                                                        <p className="text-[11px] text-[color:var(--ciq-text-60)]">{baselineStepNote}</p>
                                                        <Button
                                                            onClick={baselineProtocol.skip}
                                                            size="sm"
                                                            variant="outline"
                                                            className="h-6 shrink-0 px-2 text-[10px]"
                                                        >
                                                            Skip
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}

                                            {/* None — idle, no baseline yet */}
                                            {baselineState === "none" && (
                                                <p className="text-xs text-[color:var(--ciq-text-60)]">
                                                    No baseline recorded yet. When you start, a 3-minute eyes-open baseline is recorded (plus 3 minutes eyes
                                                    closed if an EEG headband is connected) before the questions begin.
                                                </p>
                                            )}
                                        </div>

                                        <EegConnectPanel
                                            status={eegStatus}
                                            device={eegDevice}
                                            error={eegError}
                                            available={eegAvailable}
                                            hasRecording={eegHasRecording}
                                            // The baseline protocol records EEG too (eyes open / closed), so the
                                            // live waveform shows from the baseline onwards, not only once the
                                            // questions begin.
                                            assessmentStarted={eegSurveyStarted || baselineProtocol.isActive}
                                            channels={eegChannels}
                                            getChannelSamples={getEegChannelSamples}
                                            onConnect={connectEeg}
                                            onDisconnect={disconnectEeg}
                                            onSave={saveEeg}
                                        />

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
                                                        label="Blink Count"
                                                        accent="var(--ciq-accent-blue)"
                                                        value={currentBiometrics.metrics.blinkCount}
                                                        sub={`in ${formatValidTime(currentBiometrics.metrics.blinkValidMs)} face time`}
                                                    />
                                                    <MetricCell
                                                        label="Blink Change"
                                                        accent={
                                                            !liveBlinkChangeReady
                                                                ? "var(--ciq-text-60)"
                                                                : currentBiometrics.metrics.blinkRateChangePercent >= 0
                                                                  ? "var(--ciq-accent-red)"
                                                                  : "var(--ciq-accent-green)"
                                                        }
                                                        valueClassName={
                                                            !liveBlinkChangeReady
                                                                ? "text-[color:var(--ciq-text-60)]"
                                                                : currentBiometrics.metrics.blinkRateChangePercent >= 0
                                                                  ? "text-[color:var(--ciq-accent-red)]"
                                                                  : "text-[color:var(--ciq-accent-green)]"
                                                        }
                                                        value={
                                                            liveBlinkChangeReady
                                                                ? `${currentBiometrics.metrics.blinkRateChangePercent >= 0 ? "+" : ""}${currentBiometrics.metrics.blinkRateChangePercent.toFixed(1)}%`
                                                                : "—"
                                                        }
                                                        sub={liveBlinkChangeReady ? undefined : "not enough data"}
                                                    />
                                                    <div
                                                        className="ciq-metric"
                                                        style={{ ["--ciq-metric-accent" as string]: "var(--ciq-accent-purple)" } as React.CSSProperties}
                                                    >
                                                        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--ciq-text-60)]">
                                                            Gaze — Left Eye
                                                        </p>
                                                        <div className="mt-0.5 flex items-center gap-1.5">
                                                            <GazeIndicator gaze={currentBiometrics.metrics.leftGaze} />
                                                            <span className="font-data text-base font-bold text-[color:var(--ciq-text-strong)]">
                                                                {currentBiometrics.metrics.leftGaze.label}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <div
                                                        className="ciq-metric"
                                                        style={{ ["--ciq-metric-accent" as string]: "var(--ciq-accent-purple)" } as React.CSSProperties}
                                                    >
                                                        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--ciq-text-60)]">
                                                            Gaze — Right Eye
                                                        </p>
                                                        <div className="mt-0.5 flex items-center gap-1.5">
                                                            <GazeIndicator gaze={currentBiometrics.metrics.rightGaze} />
                                                            <span className="font-data text-base font-bold text-[color:var(--ciq-text-strong)]">
                                                                {currentBiometrics.metrics.rightGaze.label}
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
                                                                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-petroleum-flare/20">
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
                                                            className="h-full rounded-full bg-[color:var(--ciq-accent-blue)] transition-all duration-500"
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
                                                        {!reportLoading && (
                                                            <ErrorBoundary label="recovery-window-launcher">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setRecoveryWindowOpen(true)}
                                                                    className="mb-4 flex w-full items-center justify-between gap-3 rounded-2xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4 text-left transition-colors hover:bg-[color:var(--ciq-tile)]"
                                                                >
                                                                    <div className="flex items-center gap-3">
                                                                        <HeartHandshake className="h-5 w-5 shrink-0 text-[color:var(--ciq-accent-purple)]" />
                                                                        <div>
                                                                            <p className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">
                                                                                Recovery Window
                                                                            </p>
                                                                            <p className="text-xs text-[color:var(--ciq-text-muted)]">
                                                                                A short, voice-guided check-in tailored to how you're doing right now.
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                    <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--ciq-text-muted)]" />
                                                                </button>
                                                            </ErrorBoundary>
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

            <ConsentModal
                isOpen={showConsent}
                onAgree={() => {
                    setConsentGiven(true);
                    setShowConsent(false);
                    apiFetch("/consent", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ version: CONSENT_VERSION, surveyType: surveyTypeConfig?.activeSurveyType })
                    }).catch(err => console.error("Failed to record consent:", err));
                    pendingStartActionRef.current?.();
                    pendingStartActionRef.current = null;
                }}
                onDecline={() => {
                    // Didn't agree: leave the assessment page for the user's own landing
                    // page (Home for employees; managers/admins have no Home tab).
                    setShowConsent(false);
                    pendingStartActionRef.current = null;
                    setActiveTab(isGuest ? "home" : isManager ? "dashboard" : "admin");
                }}
            />
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
