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
import { AnimatePresence } from "framer-motion";

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
import { DataValidationPanel } from "@/components/ui/data-validation-panel";
import { ReportProgress } from "@/components/ui/report-progress";
import { MusePanel } from "@/components/ui/muse-panel";
import { EegConnectPanel } from "@/components/ui/eeg-connect-panel";
import EegPairModal, { type EegPairVariant } from "@/components/ui/eeg-pair-modal";
import { UserHistory } from "@/components/ui/user-history";
import { ManagerLanding } from "@/components/ui/manager-landing";
import { GuestLanding } from "@/components/ui/guest-landing";
import { ReportScreen } from "@/components/ui/report-screen";
import { Button } from "@/components/ui/button";
import ConsentModal, { CONSENT_VERSION } from "@/components/ui/consent-modal";
import { apiFetch, setAuthExpiredHandler } from "@/lib/api";
import {
    assessmentControls,
    closeAssessment,
    completeAssessmentBaseline,
    continueAssessment,
    fetchResumableAssessment,
    pauseAssessment,
    startAssessment
} from "@/lib/assessment";
import { applyFontScale, getFontScale } from "@/lib/fontScale";

import useRealTime from "@/hooks/useRealtime";
import useAudioRecorder from "@/hooks/useAudioRecorder";
import useAudioPlayer from "@/hooks/useAudioPlayer";
import { MicGate } from "@/lib/mic-gate";
import { ReportSpeech, type ReportSpeechState } from "@/lib/report-speech";
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
    AssessmentBaseline,
    AssessmentContinued,
    ReportCue,
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
    { id: "validation", label: "Data Validation", adminOnly: true, managerOnly: false, guestOnly: false },
    { id: "test", label: "Test Generator", adminOnly: true, managerOnly: false, guestOnly: false },
    { id: "eeg", label: "Muse EEG", adminOnly: true, managerOnly: false, guestOnly: false },
    { id: "history", label: "History", adminOnly: false, managerOnly: false, guestOnly: false }
] as const;

// Baseline protocol phase lengths (see useBaselineProtocol / session/baseline-protocol.ts).
const BASELINE_EYES_OPEN_SECONDS = 180;
const BASELINE_EYES_CLOSED_SECONDS = 180;

const FINISH_CONFIRM = "Finish this assessment? Your report stays saved in History.";

// Recovery Window launcher on the report — hidden in the UI for now (the feature itself
// is untouched; flip back to true to show the button again).
const SHOW_RECOVERY_WINDOW_LAUNCHER = false;

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
    const [activeTab, setActiveTab] = useState<"home" | "dashboard" | "assessment" | "admin" | "validation" | "test" | "eeg" | "history">("assessment");
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
    // True once /analyze-report has resolved; the ReportProgress screen then ticks its
    // last card and clears reportLoading, so the report appears only after 100%.
    const [reportDataReady, setReportDataReady] = useState(false);
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
    // Recovery Window screen. Agent turns stream in via response.output_audio_transcript.delta;
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
    // Drops stale response.output_audio.delta chunks from the OLD turn so the agent doesn't keep
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

    // Optional Muse EEG headband, self-paired via EegPairModal when a start action finds
    // it disconnected (live status in EegConnectPanel below). Raw recording only — no derived stress/burnout
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
        getEegRateHz,
        recordContactSnapshot,
        contactChannels: eegContactChannels,
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

    // Half-duplex mic (lib/mic-gate.ts): the user's mic audio isn't sent while the agent
    // is speaking, so it can't hear its own voice or be interrupted. On reopening, the
    // server's input buffer is cleared so no leftover echo becomes a user turn.
    const inputAudioBufferClearRef = useRef<() => void>(() => {});
    const micGateRef = useRef<MicGate | null>(null);
    if (micGateRef.current === null) {
        micGateRef.current = new MicGate(open => {
            if (open) inputAudioBufferClearRef.current();
        });
    }
    const micGate = micGateRef.current;

    // PILOT report screen (components/ui/report-screen.tsx): after the last answer the
    // agent only closes the survey; the report is explained when the user presses Start,
    // and Pause / Continue resume it from where it stopped (lib/report-speech.ts).
    const isPilot = surveyTypeConfig?.activeSurveyType === "PILOT";
    const isPilotRef = useRef(isPilot);
    isPilotRef.current = isPilot;
    const [reportSpeechState, setReportSpeechState] = useState<ReportSpeechState>("idle");
    const reportSpeechRef = useRef<ReportSpeech | null>(null);
    if (reportSpeechRef.current === null) reportSpeechRef.current = new ReportSpeech(setReportSpeechState);
    const reportSpeech = reportSpeechRef.current;
    // Set once the PILOT report is saved: the strict report-only reconnect is done when
    // Start is pressed (before the explanation), not on the next response.done.
    const reportResetPendingRef = useRef(false);
    // PILOT: the agent's closing line is cued once per assessment, when the report
    // progress screen's last card starts (the middle tier skipped the automatic reply).
    const closingCueSentRef = useRef(false);
    // PILOT: from the last answer until Start is pressed on the report screen, the user's
    // mic audio isn't sent at all — the agent has told them to press Start, so speaking
    // shouldn't open a conversation before the report has been explained.
    const reportMicLockedRef = useRef(false);

    const {
        startSession,
        requestGreeting,
        sendBaselineCue,
        sendReportCue,
        truncateItem,
        cancelResponse,
        reconnect,
        refreshSession,
        addUserAudio,
        inputAudioBufferClear
    } = useRealTime({
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
            micGate.responseDone();
            reportSpeech.responseDone();
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
            if (isRecording) {
                playAudio(message.delta, message.item_id);
                micGate.agentAudio();
                reportSpeech.agentAudio(message.item_id);
            }
            baselineProtocol.notifyAudioDelta(message.delta);
        },
        onReceivedSessionReady: () => {
            // Fresh session is live — let the new agent be heard again.
            suppressAgentAudioRef.current = false;
            // A new Azure session has no memory of a paused explanation's item.
            reportSpeech.sessionReset();
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
                setReportDataReady(false);
                closingCueSentRef.current = false;
                setShowDetailedReport(true);
                if (isPilotRef.current) reportMicLockedRef.current = true;
                eegSegmentLiveRef.current = false; // this last segment is uploaded right here
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

    inputAudioBufferClearRef.current = inputAudioBufferClear;
    const {
        reset: resetPlayer,
        play: playAudio,
        stop: stopPlayer,
        getAnalyser: getAudioAnalyser
    } = useAudioPlayer({
        onDrained: () => {
            micGate.drained();
            reportSpeech.drained();
        }
    });
    // Any stop/reset of agent playback (stop, pause, new survey, reconnect, barge-in)
    // also reopens the mic straight away.
    const stopAudioPlayer = () => {
        const position = stopPlayer();
        micGate.reset();
        return position;
    };
    const resetAudioPlayer = () => {
        resetPlayer();
        micGate.reset();
    };
    const { start: startAudioRecording, stop: stopAudioRecording } = useAudioRecorder({
        onAudioRecorded: chunk => {
            if (micGateRef.current?.isOpen() && !reportMicLockedRef.current) addUserAudio(chunk);
        }
    });

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
        setReportDataReady(false);
        closingCueSentRef.current = false;
        setSentiment(null);
        setStressResult(null);
        setEnableBiometrics(true);
        reportSpeech.reset();
        reportResetPendingRef.current = false;
        reportMicLockedRef.current = false;
        // The run id itself is set by the caller: minted by the backend on Start, or
        // the paused run's id on Continue.
    }, []);

    // Loads a run's own baseline (from /me/assessment/continue) into the biometrics state,
    // or clears it for a run that has none yet — blink change is always computed against
    // THIS assessment's baseline, never another run's.
    const applyRunBaseline = useCallback(
        (baseline: AssessmentBaseline | null) => {
            if (baseline?.blinkRate != null) {
                setBaseline({ pupilSize: baseline.pupilSize ?? 0, blinkRate: baseline.blinkRate, timestamp: Date.now() });
            } else {
                clearBaseline();
            }
        },
        [setBaseline, clearBaseline]
    );

    // ── Baseline protocol (every new assessment; again after a pause mid-baseline) ──
    // 3 min eyes open (camera biometrics + EEG), then 3 min eyes closed (EEG when a
    // headband is recording) — both phases always run, with or without a headband.
    // The agent is silent apart from one spoken cue per
    // phase (the backend drops mic audio while the session is in the "baseline" phase).
    // The EEG recording and the 1Hz timeline both run straight through it: the segment's
    // EEG file holds the baseline (marked baseline_eyes_open / baseline_eyes_closed) then
    // the survey (marked from survey_start), and its timeline rows carry a matching
    // `stage`. On completion the run's baseline is recorded and the survey phase unlocked.
    const baselineCameraRef = useRef<{ pupilSize: number; blinkRate: number } | null>(null);
    const baselinePhaseStartTMsRef = useRef(0);
    // Set once this assessment's baseline is done (completed here, or already completed
    // before a pause), so a stop/resume never runs the protocol a second time.
    const baselineDoneRef = useRef(false);

    const finishBaselineProtocol = async ({ eyesClosed }: { eyesClosed: boolean }) => {
        baselineDoneRef.current = true;
        // …and whether it slipped during the baseline.
        recordContactSnapshot("baseline_end");
        const surveyStartTMs = getEegSessionTMs();
        addEegMarker("survey_start", surveyStartTMs, surveyStartTMs);

        // Recorded even without usable camera data (values null): the protocol — and the
        // EEG baseline in this segment — happened, so a resume must not repeat it.
        const camera = baselineCameraRef.current;
        if (!camera) console.warn("[App] Baseline protocol finished without usable camera data — no blink baseline");
        completeAssessmentBaseline(camera?.blinkRate ?? null, camera?.pupilSize ?? null).catch(err =>
            console.warn("[App] Failed to record the assessment baseline:", err)
        );

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
            // The headband fit the baseline is recorded with (saved in the EEG file).
            if (phase === "eyes_open") recordContactSnapshot("baseline_start");
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
        baselineProtocol.start();
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

    // Pre-start EEG prompt (EegPairModal): shown by Start / Start new / Continue only when
    // the headband isn't connected and Web Bluetooth is available. Resolves true to
    // proceed (paired in the modal, or "Continue without EEG") and false on Cancel. EEG
    // stays optional — this is a reminder with a pairing shortcut, not a gate.
    const [eegPromptVariant, setEegPromptVariant] = useState<EegPairVariant | null>(null);
    const eegPromptResolveRef = useRef<((proceed: boolean) => void) | null>(null);
    const eegConnected = eegStatus === "streaming" || eegStatus === "paused";
    const confirmEegOrPair = (variant: EegPairVariant): Promise<boolean> => {
        if (eegConnected || !eegAvailable) return Promise.resolve(true);
        return new Promise(resolve => {
            eegPromptResolveRef.current = resolve;
            setEegPromptVariant(variant);
        });
    };
    const closeEegPrompt = useCallback((proceed: boolean) => {
        setEegPromptVariant(null);
        eegPromptResolveRef.current?.(proceed);
        eegPromptResolveRef.current = null;
    }, []);

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
        if (!hasAssessment && !(await confirmEegOrPair("start"))) return;
        setIsRecording(true);
        // Make sure any survey-type selection has actually landed server-side before
        // we send session.update — otherwise the agent's question script can be built
        // from the PREVIOUS survey type (see surveyTypeChangeRef above).
        if (surveyTypeChangeRef.current) {
            await surveyTypeChangeRef.current;
        }
        startSession();
        resetAudioPlayer();
        // Anchors the EEG recording's "the assessment actually started here" instant —
        // distinct from whenever the headband happened to pair (see markSurveyStarted
        // in useMuse.ts). No-ops if EEG isn't connected, or on a later resume (idempotent
        // on the Recorder itself, so only this genuinely-first call takes effect). The
        // baseline is part of the recording, so this is Start — not the protocol's end.
        markEegSurveyStarted();
        // This assessment's own baseline decides how the conversation opens: until it is
        // done (e.g. stopped mid-baseline) the protocol runs (its first cue replaces the
        // greeting); resumes and post-report Q&A get the normal greeting.
        if (enableSurvey && !hasAssessment && !baselineDoneRef.current) {
            await startAudioRecording();
            startBaselineProtocol();
            return;
        }
        requestGreeting();
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

    // True while the current EEG recorder belongs to a live segment of a bound run — set
    // on Start / Continue, cleared once that segment's file is uploaded (Pause, Start new
    // over it, or completion). Whatever streams while paused is never uploaded.
    const eegSegmentLiveRef = useRef(false);

    // Finish the live segment's EEG recording, upload it as that segment's file, and keep
    // the headband streaming into a fresh recorder (replaced on Continue / Start new).
    const uploadLiveEegSegment = () => {
        if (!eegSegmentLiveRef.current) return;
        eegSegmentLiveRef.current = false;
        if (!eegHasRecording) return;
        const file = splitEegRecording();
        if (!file) return;
        apiFetch("/eeg-sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId, survey_run_id: surveyRunId, segment_index: eegSegmentRef.current, file })
        }).catch(err => console.error("Failed to upload EEG segment:", err));
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
        if (!(await confirmEegOrPair("new"))) return;
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
        // The run being replaced mid-way: keep its EEG — this segment's recording is
        // uploaded like a Pause would, before the new run's fresh recorder replaces it.
        uploadLiveEegSegment();
        let newRunId: string;
        try {
            const started = await startAssessment(surveyTypeConfig?.activeSurveyType);
            newRunId = started.surveyRunId;
            eegSegmentLiveRef.current = true;
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
        // Anchors this run's "assessment actually started here" instant on that fresh
        // Recorder — Start, since the baseline is now part of the same recording.
        markEegSurveyStarted();

        // Every new assessment records its own baseline — agreeing with the phase the
        // backend resolves for the new (baseline-less) run on the fresh connection below.
        clearBaseline();

        setIsRecording(true);
        reconnect();
        startSession();
        resetAudioPlayer();
        // Arm the opening turn now (deferred until the reconnect's session.created, since
        // the socket is mid-reopen here) so the agent opens the fresh conversation the
        // instant the session is ready — the baseline protocol's first cue (survey mode),
        // or a greeting.
        if (enableSurvey) {
            startBaselineProtocol();
        } else {
            requestGreeting();
        }
        await startAudioRecording();
    };

    // Pause: stop listening and park the run server-side. The backend persists this
    // segment's timeline frames (answers were persisted as each was scored); the EEG
    // recorded so far is uploaded as this segment's own file. After the report, the
    // run is already complete — Pause then just stops the post-report conversation.
    const onPauseAssessment = async () => {
        await onStopListening();
        if (assessmentComplete) return;
        // Upload this segment's recording as it is — paused mid-baseline included: that
        // partial baseline is real data (marked baseline_eyes_open in the file, stage =
        // baseline_* in the timeline); Continue then records a full baseline in the next
        // segment.
        uploadLiveEegSegment();
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
    // its reconnect instructions; the run's own baseline is reused when it has one.
    const onContinueAssessment = async () => {
        if (!resumable) {
            // Nothing paused — Continue after a finished report resumes the conversation.
            await onStartListening();
            return;
        }
        stopAudioPlayer();
        if (!(await confirmEegOrPair("continue"))) return;
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
        eegSegmentLiveRef.current = true;
        // This segment's recording starts here (a re-run baseline included).
        markEegSurveyStarted();

        // This run's own baseline: reused when it was completed before the pause (no time
        // limit); recorded again in this segment when the pause came mid-baseline. Agrees
        // with the phase the backend resolves from the same row.
        applyRunBaseline(run.baseline);
        const runBaseline = enableSurvey && run.baselineRequired;
        baselineDoneRef.current = !runBaseline;

        setIsRecording(true);
        reconnect();
        startSession();
        resetAudioPlayer();
        if (runBaseline) {
            startBaselineProtocol();
        } else {
            requestGreeting();
        }
        await startAudioRecording();
    };

    // Finish: end a completed assessment's session and return the page to its starting
    // state. The report is already saved (History); the run's status isn't touched.
    // Resets the server session too, so the post-report Q&A context doesn't linger.
    const onFinishAssessment = async () => {
        if (!window.confirm(FINISH_CONFIRM)) return;
        await finishAssessment();
    };
    const finishAssessment = async () => {
        void stopAudioPlayer();
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

    // ── PILOT report screen controls ──
    // Turn the mic + agent audio back on for the report conversation without the usual
    // greeting turn, then send the report cue (if any). The cue waits for a live session,
    // so it also fires correctly right after the report-only reconnect.
    const listenForReport = async (cue: ReportCue | null) => {
        reportMicLockedRef.current = false;
        if (!isRecording) {
            setIsRecording(true);
            startSession();
            resetAudioPlayer();
            await startAudioRecording();
        }
        if (cue) {
            // Keep the mic closed until the explanation has played: otherwise any sound
            // (a word, echo, background noise) lets server VAD start its own reply first —
            // a generic "ask me anything" turn — and Azure then rejects the cue's
            // response.create because a response is already active.
            micGate.hold();
            sendReportCue(cue);
        }
    };

    // Start: switch to the strict report-only session first (once the report is saved),
    // then ask the agent to explain the report from the beginning.
    const onReportStart = async () => {
        const cue = reportSpeech.start();
        if (reportResetPendingRef.current) {
            reportResetPendingRef.current = false;
            void stopAudioPlayer(); // cut the closing line if it's still playing
            suppressAgentAudioRef.current = true;
            reconnect();
        }
        await listenForReport(cue);
    };

    // Pause: stop the agent mid-sentence and tell the model exactly how much was heard,
    // so Continue resumes from there instead of skipping ahead.
    const onReportPause = async () => {
        cancelResponse();
        const cut = reportSpeech.pause(await stopAudioPlayer());
        if (cut) truncateItem(cut.itemId, cut.playedMs);
        await onStopListening();
    };

    // Continue: resume the explanation where it stopped, or (once it's done) just reopen
    // the conversation for questions about the report.
    const onReportContinue = () => listenForReport(reportSpeech.resume());

    // Finish: stop everything and return the assessment page to its Start state (no new
    // survey is started — the user presses Start when ready).
    const onReportFinish = async () => {
        if (!window.confirm(FINISH_CONFIRM)) return;
        await onStopListening();
        await finishAssessment();
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
        // The progress screen finishes its last card, then clears reportLoading (onDone).
        setReportDataReady(true);
        if (isPilotRef.current) reportResetPendingRef.current = true;
        else pendingGuardrailResetRef.current = true;
    }, []);

    // PILOT only (other surveys read their result out in-script): the progress screen's
    // last card has started — ask the agent for its closing line, once per assessment.
    const sendClosingCue = () => {
        if (!isPilotRef.current || closingCueSentRef.current) return;
        closingCueSentRef.current = true;
        sendBaselineCue("survey_complete");
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
    // Shown in the survey card before its first question arrives (replaces a bare "No active
    // survey", which read as an error while the assessment was actually starting up).
    const surveyStatusNote = assessmentComplete
        ? "Assessment complete. Your results are below."
        : isRecording && baselineState === "recording"
          ? "Recording your baseline. The questions start right after."
          : isRecording && surveyCompleted > 0
            ? // Continued after a pause: progress is restored, the question text arrives with
              // the agent's next question.
              `Picking up where you left off: ${surveyCompleted} of ${surveyTotal} answered. Getting your next question ready…`
            : isRecording
              ? "Getting your first question ready…"
              : resumable
                ? "Assessment paused. Press Continue to pick up where you left off."
                : "Press Start to begin your assessment.";
    const baselinePhaseLabel = baselineProtocol.state.phase === "eyes_closed" ? "Eyes closed" : "Eyes open";
    const baselineStepNote =
        baselineProtocol.state.stage === "cue"
            ? "Listen to the instruction…"
            : baselineProtocol.state.phase === "eyes_closed"
              ? "Keep your eyes closed and relax — you'll be told when to open them."
              : "Keep your eyes open, look at the screen and stay still.";

    // The written report (loader overlay, Recovery Window launcher, DetailedReport). Shown in
    // ONE place only — the PILOT report screen, or the results panel for other surveys —
    // because mounting DetailedReport fires POST /analyze-report (which saves the run).
    const reportBody = (
        <div className={`relative mt-4 ${reportLoading ? "min-h-[560px]" : ""}`}>
            {/* DetailedReport renders underneath while post-processing so Recharts
                                                        sizes correctly; the progress screen covers it until /analyze-report
                                                        resolves AND its last card has ticked (onDone). */}
            {reportLoading && (
                <div className="absolute inset-0 z-10 flex justify-center overflow-y-auto rounded-xl bg-[color:var(--ciq-card)] p-4">
                    <ReportProgress ready={reportDataReady} onDone={() => setReportLoading(false)} onLastStep={sendClosingCue} />
                </div>
            )}
            {SHOW_RECOVERY_WINDOW_LAUNCHER && !reportLoading && (
                <ErrorBoundary label="recovery-window-launcher">
                    <button
                        type="button"
                        onClick={() => setRecoveryWindowOpen(true)}
                        className="mb-4 flex w-full items-center justify-between gap-3 rounded-2xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4 text-left transition-colors hover:bg-[color:var(--ciq-tile)]"
                    >
                        <div className="flex items-center gap-3">
                            <HeartHandshake className="h-5 w-5 shrink-0 text-[color:var(--ciq-accent-purple)]" />
                            <div>
                                <p className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">Recovery Window</p>
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
                        compact={isPilot}
                    />
                </Suspense>
            </ErrorBoundary>
        </div>
    );
    const pilotReportMode = isPilot && showDetailedReport && biometricSnapshots.length > 0;
    // PILOT's assessment page must fit the screen (no page scroll) on desktop.
    const fitScreen = isPilot;

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

            {/* ── Data Validation ── (admin-only; wider column — table + details side by side) */}
            {activeTab === "validation" && isAdmin && (
                <main className="flex-1 overflow-y-auto p-4">
                    <div className="mx-auto w-full max-w-[1360px]">
                        <DataValidationPanel />
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
                // PILOT on desktop: the page fits the screen and never scrolls — each card
                // fills the available height, the video shrinks to fit, and the controls stay
                // visible; Biometrics / Report scroll inside their own card. (Smaller screens
                // stack the cards and scroll as before.)
                <main className={`min-h-0 flex-1 p-4 ${fitScreen ? "overflow-y-auto lg:flex lg:flex-col lg:overflow-hidden" : "overflow-y-auto"}`}>
                    <div className={`grid w-full grid-cols-12 gap-4 ${fitScreen ? "lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)]" : ""}`}>
                        {/* Video with biometrics to its right (stacked below it on small screens) */}
                        <div
                            className={`col-span-12 grid grid-cols-1 gap-4 lg:grid-cols-12 ${fitScreen ? "items-start lg:h-full lg:min-h-0 lg:items-stretch" : "items-start"}`}
                        >
                            {/* Camera Feed Panel */}
                            <section
                                className={`ciq-glass-card lg:col-span-7 ${fitScreen ? "lg:min-h-0 lg:overflow-hidden" : ""} ${pilotReportMode ? "hidden" : ""}`}
                            >
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
                                    <div className={`relative p-4 ${fitScreen ? "lg:min-h-0 lg:flex-1" : ""}`}>
                                        {/* The camera stays mounted underneath in avatar mode so MediaPipe
                                            biometric capture is never interrupted — the avatar just overlays it. */}
                                        {/* The report hides this card, so release the device camera there
                                            too — except while the Recovery Window (which mirrors this
                                            stream) is open over it. */}
                                        <VideoPanel
                                            isRecording={isRecording && (!pilotReportMode || recoveryWindowOpen)}
                                            expanded={videoExpanded}
                                            fitHeight={fitScreen}
                                            onVideoReady={setVideoElement}
                                            onStreamReady={setCameraStream}
                                        />
                                        {cameraView === "avatar" && (
                                            <div className="absolute inset-0 p-4">
                                                <div
                                                    className={`mx-auto aspect-video w-full ${fitScreen ? "lg:aspect-auto lg:h-full" : ""} ${videoExpanded ? "max-w-none" : "max-w-xl"}`}
                                                >
                                                    <CyberAvatar getAnalyser={getAudioAnalyser} className="border border-[color:var(--ciq-border)]" />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <div className={`shrink-0 border-t border-[color:var(--ciq-divider)] px-5 py-4 ${pilotReportMode ? "hidden" : ""}`}>
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
                                                            <div className="text-xs text-[color:var(--ciq-text-60)]" role="status">
                                                                {surveyStatusNote}
                                                            </div>
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

                            {/* Right of the video on lg+, below it on small screens: the Biometrics &
                                Sentiment panel during the survey, then (PILOT) the report screen. */}
                            <AnimatePresence mode="wait" initial={false}>
                                {pilotReportMode ? (
                                    <ReportScreen
                                        key="report"
                                        report={reportBody}
                                        reportReady={!reportLoading}
                                        speechState={reportSpeechState}
                                        isListening={isRecording}
                                        onStart={() => void onReportStart()}
                                        onPause={() => void onReportPause()}
                                        onContinue={() => void onReportContinue()}
                                        onFinish={() => void onReportFinish()}
                                    />
                                ) : (
                                    <section key="biometrics" className={`ciq-glass-card lg:col-span-5 ${fitScreen ? "lg:min-h-0 lg:overflow-hidden" : ""}`}>
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
                                                <h2 className="font-display text-base font-semibold text-[color:var(--ciq-text-strong)]">
                                                    Biometrics &amp; Sentiment
                                                </h2>
                                            </button>
                                            <div
                                                id="biometrics-sentiment-panel"
                                                className={`min-h-0 flex-1 space-y-4 overflow-y-auto p-4 ${isBiometricsPanelExpanded ? "" : "hidden"}`}
                                            >
                                                {/* Biometric Baseline — always visible; its inner content
                                            reflects baselineState (recorded / recording / needed / none). */}
                                                <div className="rounded-xl border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] p-3">
                                                    <div className="mb-2 flex items-center justify-between">
                                                        <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[color:var(--ciq-text-60)]">
                                                            Baseline
                                                        </p>
                                                        <span
                                                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${
                                                                baselineState === "recorded"
                                                                    ? "text-[color:var(--ciq-accent-green)]"
                                                                    : baselineState === "recording"
                                                                      ? "text-[color:var(--ciq-accent-blue)]"
                                                                      : "text-[color:var(--ciq-text-60)]"
                                                            }`}
                                                        >
                                                            {baselineState === "recorded"
                                                                ? "RECORDED"
                                                                : baselineState === "recording"
                                                                  ? "RECORDING"
                                                                  : "NOT SET"}
                                                        </span>
                                                    </div>

                                                    {/* Recorded — this assessment's own baseline values */}
                                                    {baselineState === "recorded" && baselineData && (
                                                        <div className="flex items-center gap-4 text-[11px]">
                                                            <div className="flex items-center gap-1">
                                                                <span className="text-[color:var(--ciq-text-68)]">Blink:</span>
                                                                <span className="font-data font-semibold text-[color:var(--ciq-text-strong)]">
                                                                    {baselineData.blinkRate.toFixed(1)}/min
                                                                </span>
                                                            </div>
                                                            <span className="text-[color:var(--ciq-text-60)]">for this assessment</span>
                                                        </div>
                                                    )}

                                                    {/* Recording — baseline protocol phase only; deliberately no countdown or
                                                progress bar. The voice cue tells the user when each phase ends. */}
                                                    {baselineState === "recording" && (
                                                        <div>
                                                            <div className="mb-2 flex items-center gap-2">
                                                                <Loader2 className="h-4 w-4 animate-spin text-[color:var(--ciq-accent-blue)]" />
                                                                <span className="text-xs font-medium text-[color:var(--ciq-accent-blue)]">
                                                                    {baselinePhaseLabel}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center justify-between gap-2">
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
                                                            Every assessment records its own baseline. When you start, a 3-minute eyes-open baseline is recorded
                                                            then 3 minutes with eyes closed, before the questions begin.
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
                                                    // Fit lights while fitting the band (not recording yet) and through
                                                    // the baseline; hidden once the questions begin.
                                                    showContact={!isRecording || baselineState === "recording"}
                                                    contactChannels={eegContactChannels}
                                                    getEegRateHz={getEegRateHz}
                                                    onDisconnect={disconnectEeg}
                                                    onSave={saveEeg}
                                                />

                                                {/* Idle state — keeps the panel feeling alive before signals arrive */}
                                                {!isRecording && (
                                                    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[color:var(--ciq-border)] py-10 text-center">
                                                        <Activity className="h-7 w-7 text-[color:var(--ciq-text-40)]" />
                                                        <p className="text-sm font-medium text-[color:var(--ciq-text-68)]">Biometric stream idle</p>
                                                        <p className="text-xs text-[color:var(--ciq-text-40)]">
                                                            Start the conversation to capture live signals
                                                        </p>
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
                                                                        <span className="ml-0.5 text-[12px] font-medium text-[color:var(--ciq-text-60)]">
                                                                            /min
                                                                        </span>
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
                                                                value={
                                                                    <span className="text-base">
                                                                        {getHeadPoseLabel(currentBiometrics.metrics.headPose.yaw)}
                                                                    </span>
                                                                }
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
                                                            <div
                                                                className={`w-full rounded-xl border p-3 sm:w-[16rem] ${getStressBgColor(stressResult.state)}`}
                                                            >
                                                                <div className="flex items-center justify-between">
                                                                    <h4 className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">
                                                                        Blink Rate Stress
                                                                    </h4>
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
                                )}
                            </AnimatePresence>
                        </div>

                        {/* Centered 8-of-12 column for the results (not for PILOT — its report
                            has its own screen and the page must not scroll) */}
                        {!isPilot && (
                            <div className="col-span-12 flex flex-col gap-4 lg:col-span-8 lg:col-start-3">
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
                                                    {/* No progress indicator while the baseline is recording */}
                                                    {baselineState !== "recording" && (
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
                                                    )}

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

                                                    {showDetailedReport && biometricSnapshots.length > 0 && reportBody}
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
                        )}
                    </div>
                </main>
            )}

            <EegPairModal
                variant={eegPromptVariant}
                status={eegStatus}
                error={eegError}
                contactChannels={eegContactChannels}
                getChannelSamples={getEegChannelSamples}
                getEegRateHz={getEegRateHz}
                onConnect={connectEeg}
                onProceed={() => closeEegPrompt(true)}
                onCancel={() => closeEegPrompt(false)}
            />

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
