export type GroundingFile = {
    id: string;
    name: string;
    content: string;
};

export type HistoryItem = {
    id: string;
    transcript: string;
    groundingFiles: GroundingFile[];
};

/** One turn of the live voice conversation, surfaced as a text chat in the
 * Recovery Window screen. `text` is streamed in for agent turns (empty at first)
 * and filled in late for user turns (whisper lags the spoken response). */
export type ChatTurn = {
    id: string;
    role: "user" | "agent";
    text: string;
};

export type SessionUpdateCommand = {
    type: "session.update";
    session: {
        turn_detection?: {
            type: "server_vad" | "none";
            // Tuning knobs for server_vad — raising `threshold` makes the model require
            // a louder signal before it counts as speech, so ambient noise below that
            // level is ignored instead of triggering a turn.
            threshold?: number;
            prefix_padding_ms?: number;
            silence_duration_ms?: number;
        };
        input_audio_transcription?: {
            model: "whisper-1";
        };
    };
};

export type InputAudioBufferAppendCommand = {
    type: "input_audio_buffer.append";
    audio: string;
};

export type InputAudioBufferClearCommand = {
    type: "input_audio_buffer.clear";
};

export type Message = {
    type: string;
};

export type ResponseAudioDelta = {
    type: "response.audio.delta";
    delta: string;
    item_id?: string;
};

export type ResponseAudioTranscriptDelta = {
    type: "response.audio_transcript.delta";
    delta: string;
};

export type ResponseInputAudioTranscriptionCompleted = {
    type: "conversation.item.input_audio_transcription.completed";
    event_id: string;
    item_id: string;
    content_index: number;
    transcript: string;
};

export type ResponseDone = {
    type: "response.done";
    event_id: string;
    response: {
        id: string;
        output: { id: string; content?: { transcript: string; type: string }[] }[];
    };
};

export type ExtensionMiddleTierToolResponse = {
    type: "extension.middle_tier_tool.response";
    previous_item_id: string;
    tool_name: string;
    tool_result: string; // JSON string that needs to be parsed into ToolResult
};

export type SentimentUpdate = {
    type: "sentiment.update";
    sentiment: "positive" | "neutral" | "negative";
    reason: string;
};

export type SurveyOption = {
    value: number;
    label: string;
};

export type SurveyUpdate = {
    type: "survey.update";
    question_id: string;
    question_text?: string;
    options?: SurveyOption[];
    score: number;
    completed: number;
    total: number;
};

export interface BiometricSnapshot {
    questionId: string;
    domain: string;
    // Absent for a qualitative (open-ended, no numeric scale) question — e.g. the
    // READINESS survey type. See userResponse for the natural-language answer instead.
    score?: number;
    userResponse?: string;
    voiceSentiment: "positive" | "neutral" | "negative";
    // null = not enough data (no baseline / too little face-visible time) — never a real 0%.
    blinkRateChange: number | null;
    pupilMmChange?: number;
    leftGazePosition: string;
    rightGazePosition: string;
    responseLatencyMs?: number | null;
}

// Assessment lifecycle (backend ciq/assessments/): a run is active, paused,
// closed or completed. GET /me/assessment returns the user's one open run.
export type ResumableAssessment = {
    surveyRunId: string;
    surveyType: string;
    // "active" with no live connection = the tab was closed / the network dropped.
    status: "active" | "paused";
    answered: number;
    total: number;
    startedAt: string;
    pausedAt: string;
    snapshots: BiometricSnapshot[];
};

export type AssessmentStarted = {
    surveyRunId: string;
    surveyType: string;
    segmentIndex: number;
    closedRunIds: string[];
    // Always true: every new assessment records its own baseline.
    baselineRequired: boolean;
};

// A run's own baseline (survey_records.baseline_*), reused on every Continue. Values are
// null when the protocol ran without usable camera data (camera off / no face).
export type AssessmentBaseline = { blinkRate: number | null; pupilSize: number | null };

export type AssessmentContinued = {
    surveyRunId: string;
    surveyType: string;
    segmentIndex: number;
    // This run hasn't completed its baseline (paused mid-baseline): run the protocol again.
    baselineRequired: boolean;
    // The baseline this run already completed (null when baselineRequired).
    baseline: AssessmentBaseline | null;
    answered: number;
    total: number;
    snapshots: BiometricSnapshot[];
};

export type SurveyBiometricUpdate = {
    type: "survey.biometric.update";
    snapshot: BiometricSnapshot;
    totalScore: number;
    completed: number;
    total: number;
};

export type SurveyQuestion = {
    id: string;
    text: string;
    score: number;
};

export type SurveyResult = {
    questions: SurveyQuestion[];
    totalScore: number;
    interpretation: string;
};

export type ToolResult = {
    sources: { chunk_id: string; title: string; chunk: string }[];
};

export type EmotionResult = {
    emotion: string;
    confidence: number;
    allEmotions?: { type: string; confidence: number }[];
};

export interface BiometricMetrics {
    headPose: {
        pitch: number;
        roll: number;
        yaw: number;
    };
    blinkRate: number;
    // False until the trailing window has enough face-visible time for a real rate;
    // blinkRate (0) and blinkRateChangePercent (0) are placeholders while false.
    blinkRateReady: boolean;
    // Cumulative detector totals since analysis started — the backend differences
    // these to get a per-question blink rate.
    blinkCount: number;
    blinkValidMs: number;
    eyeOpenness: number;
    mouthOpenness: number;
    smileIntensity: number;
    faceWidth: number;
    faceHeight: number;
    interocularDistance: number;
    irisPosition: { x: number; y: number };
    // Binocular — each eye tracked independently (see useBiometrics.ts). No combined
    // `gaze` field: the two eyes can disagree (e.g. one occluded), so collapsing them
    // into one signal would hide that rather than surface it.
    leftGaze: { x: number; y: number; label: string };
    rightGaze: { x: number; y: number; label: string };
    pupilSize: number;
    pupilSizeMm: number;
    pupilSizeChangePercent: number;
    blinkRateChangePercent: number;
    smoothedBlinkRate: number;
    baselineRateForChange: number;
}

export type BiometricResult = {
    metrics: BiometricMetrics;
    timestamp: number;
    faceDetected: boolean;
    analysisDuration?: number;
};

export type FaceLandmarks = {
    positions: { x: number; y: number }[];
    confidence: number;
};

export type StressState = "stressed" | "relaxed" | "normal";

export type StressResult = {
    state: StressState;
    confidence: number;
    trend: "increasing" | "decreasing" | "stable";
    blink_rate_change_percent?: number;
};

export type SentimentHistoryItem = {
    id: string;
    timestamp: number;
    timeFrameLabel: string;
    faceEmotion: string;
    faceEmotionConfidence: number;
    voiceSentiment: "positive" | "neutral" | "negative";
    voiceSentimentReason?: string;
    stressState?: StressState;
    stressConfidence?: number;
    stressTrend?: "increasing" | "decreasing" | "stable";
};

export type AnalysisInsight = {
    insight: string;
    rule: string;
    dataPoint: string;
    confidence: "high" | "medium" | "low";
};

export type AnalysisResult = {
    correlations?: AnalysisInsight[];
    contradictions?: AnalysisInsight[];
    patterns?: AnalysisInsight[];
    summary?: string;
    // Present only for a qualitative (e.g. READINESS) report — see build_readiness_analysis_prompt.
    assessment_summary?: string;
    readiness_score?: number;
    topic_feedback?: { domain: string; user_response_excerpt: string; comment: string }[];
    user_experience_feedback?: string;
    actionable_recommendations?: string[];
    // Fallback when the LLM returns prose / markdown-wrapped JSON the backend
    // couldn't parse into the structured groups above.
    raw?: string;
};

// A survey can score as one combined total (totalScore/maxScore/riskLevel/interpretation)
// OR as independent subscales declared by the survey's own `scoringSections` config (e.g.
// PILOT's BAT-4 + CBI-WRB3) — never both. `sections` is present only for the latter.
export type SectionScore = {
    id: string;
    label: string;
    score: number;
    scoreRange: [number, number];
    riskLevel: "Low" | "Moderate" | "High";
    interpretation: string;
};

// Response from POST /analyze-report — the data-driven technical report.
export type AnalyzeReportResponse = {
    analysis: AnalysisResult;
    agentResponse: string;
    domainTotals: Record<string, number>;
    totalScore?: number;
    maxScore?: number;
    riskLevel?: "Low" | "Moderate" | "High";
    interpretation?: string;
    sections?: SectionScore[];
};

export type KBDocument = {
    paperId: string;
    title: string;
    uploadedAt: string;
    lifeCycleState?: string;
    sizeSi?: string;
    fileType?: string;
};

export type Citation = {
    paperId: string;
    paperTitle: string;
    paperPage: number;
};

export type SSoTReport = {
    answer: string;
    citations: Citation[];
};

export type SurveyTypeConfig = {
    surveyTypeOverridden: boolean;
    activeSurveyType: "TEST" | "BATFULL" | "PILOT" | "CBTFULL" | "READINESS";
    availableSurveyTypes: string[];
};

export type UserRole = "admin" | "manager" | "employee";

export type AuthUser = {
    user_id: string;
    name: string;
    session_id: string;
    role: UserRole;
};

export type AuthState = "checking" | "unauthenticated" | "authenticated";

export type AdminUser = {
    user_id: string;
    name: string;
    created_at: string;
    session_count: number;
    last_active_at: string | null;
    last_session_id: string | null;
};

export type SurveyRunSummary = {
    survey_run_id: string;
    survey_type: string | null;
    created_at: string;
    // completed | closed | paused | active — anything but "completed" is a partial run.
    status: string;
    has_eeg_session: boolean;
    // Recorded EEG segments (one per Start/Continue stretch of a paused-and-continued
    // run; [0] for a single recording). More than one → per-segment downloads.
    eeg_segments: number[];
};

export type SurveyRecord = {
    survey_run_id: string;
    session_id: string;
    survey_type: string | null;
    created_at: string;
    updated_at: string;
    survey_results: Record<
        string,
        {
            score: number;
            domain: string;
            voiceSentiment: string;
            blinkRateChange: number | null;
            leftGazePosition: string;
            rightGazePosition: string;
            responseLatencyMs?: number | null;
        }
    > | null;
    technical_report: {
        domainTotals: Record<string, number>;
        analysis: Record<string, unknown>;
        totalScore?: number;
        riskLevel?: "Low" | "Moderate" | "High";
        interpretation?: string;
        sections?: SectionScore[];
    } | null;
    prompt_info: {
        snapshotCount: number;
        agentResponse?: string;
        ssotReport?: { answer: string; citations: Array<{ paperId: string; paperTitle: string; paperPage: number }> } | { error: string };
    } | null;
};

// ── Recovery Window (see docs/recovery-window.md, ciq/recovery/) ───────────

export type RecoveryTrackId = "cbt_reframe_reset" | "mindfulness_downshift" | "act_values_recalibration" | "practical_recovery_plan";

export type RecoverySessionStatus =
    | "not_started"
    | "intake_in_progress"
    | "track_recommended"
    | "session_in_progress"
    | "completed"
    | "urgent_support"
    | "grounding_only";

export type RecoveryWindowSession = {
    recoverySessionId: string;
    status: RecoverySessionStatus;
    surveyRunId: string | null;
    preliminaryTrack: RecoveryTrackId | null;
    preliminaryRationale: string | null;
    recommendedTrack: RecoveryTrackId | null;
    recommendationRationale: string | null;
    selectedTrack: RecoveryTrackId | null;
    groundingOnlyMode: boolean;
    createdAt: string;
    updatedAt: string;
};

// Realtime WS messages pushed by the 6 recovery voice tools (see
// ciq/realtime/tools/recovery_handlers.py's client_message payloads) — a
// union rather than one loose type so each variant's fields are checked.
export type RecoveryIntakeUpdate = {
    type: "recovery.intake.update";
    questionId: string;
    completed: number;
    total: number;
};

export type RecoverySafetyInterlockUpdate = {
    type: "recovery.safety.interlock";
    mode: "urgent_support" | "grounding_only";
};

export type RecoverySafetyClearedUpdate = {
    type: "recovery.safety.cleared";
};

export type RecoveryTrackSelectedUpdate = {
    type: "recovery.track.selected";
    trackId: RecoveryTrackId;
    isOverride: boolean;
    totalSteps: number;
};

export type RecoveryTrackStepUpdate = {
    type: "recovery.track.step.update";
    stepIndex: number;
    totalSteps: number;
    isLast: boolean;
};

export type RecoveryCompletedUpdate = {
    type: "recovery.completed";
};

export type RecoveryUpdate =
    | RecoveryIntakeUpdate
    | RecoverySafetyInterlockUpdate
    | RecoverySafetyClearedUpdate
    | RecoveryTrackSelectedUpdate
    | RecoveryTrackStepUpdate
    | RecoveryCompletedUpdate;

// Admin-only row from GET /admin/recovery-window/flagged — never includes
// individual intake answers or reflection content, only the fact of a flag.
export type FlaggedRecoverySession = {
    recoverySessionId: string;
    userId: string;
    userName: string;
    status: RecoverySessionStatus;
    createdAt: string;
    reviewed: boolean;
};

// Spoken cues for the baseline calibration protocol (see useBaselineProtocol). Sent to
// the middle tier as a custom `baseline.cue` message; the wording lives server-side in
// ciq/prompts/builder.py (_BASELINE_CUES / _SURVEY_START_LEADS).
export type BaselineCue = "eyes_open_start" | "eyes_closed_start" | "survey_start_after_closed" | "survey_start_after_open";

// Fatigue ↔ Burnout zone from GET /api/zone-trend (ciq/zone.py) — the user's own
// completed PILOT runs, calculated on demand. A wellbeing guide, not a diagnosis.
export type ZoneKey = "well" | "mild" | "moderate" | "high";
export type ZoneLean = "fatigue" | "burnout" | "mixed" | "none";

export type ZoneSignal = {
    key: "blink_up" | "slower";
    label: string;
    approximate: true;
};

export type ZoneResult = {
    surveyRunId: string;
    date: string; // YYYY-MM-DD (UTC)
    fatigue: number;
    burnout: number;
    severity: number; // 0–100, higher = more strain
    zone: ZoneKey;
    lean: ZoneLean;
    leanValue: number; // burnout − fatigue, −100…+100
    marker: number | null; // 0 = Fatigue end, 100 = Burnout end; null when zone is "well"
    signals: ZoneSignal[];
};

export type ZoneTrendPoint = {
    surveyRunId: string;
    date: string;
    severity: number;
    zone: ZoneKey;
    lean: ZoneLean;
};

export type ZoneTrend =
    | { status: "none" | "first"; points: ZoneTrendPoint[] }
    | {
          status: "improving" | "steady" | "worsening";
          delta: number;
          ref: number;
          compared: number;
          points: ZoneTrendPoint[];
      };

export type ZoneTrendResponse = {
    latest: ZoneResult | null;
    trend: ZoneTrend;
};

// PILOT report screen: Start (report_explain) / Continue after a pause (report_continue).
// Sent as a custom `report.cue` message; the wording lives server-side in
// ciq/prompts/builder.py (report_cue_instructions).
export type ReportCue = "report_explain" | "report_continue";
