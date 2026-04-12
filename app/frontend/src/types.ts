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

export type SessionUpdateCommand = {
    type: "session.update";
    session: {
        turn_detection?: {
            type: "server_vad" | "none";
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
    blinkCount: number;
    eyeOpenness: number;
    mouthOpenness: number;
    smileIntensity: number;
    faceWidth: number;
    faceHeight: number;
    interocularDistance: number;
    irisPosition: { x: number; y: number };
    pupilSize: number;
    pupilSizeMm: number;
    pupilSizeChangePercent: number;
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

export type SentimentHistoryItem = {
    id: string;
    timestamp: number;
    timeFrameLabel: string;
    faceEmotion: string;
    faceEmotionConfidence: number;
    voiceSentiment: "positive" | "neutral" | "negative";
    voiceSentimentReason?: string;
};
