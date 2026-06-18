import { useRef } from "react";
import useWebSocket from "react-use-websocket";

import {
    InputAudioBufferAppendCommand,
    InputAudioBufferClearCommand,
    Message,
    ResponseAudioDelta,
    ResponseAudioTranscriptDelta,
    ResponseDone,
    SessionUpdateCommand,
    ExtensionMiddleTierToolResponse,
    ResponseInputAudioTranscriptionCompleted,
    SentimentUpdate,
    SurveyUpdate,
    SurveyBiometricUpdate
} from "@/types";

type Parameters = {
    sessionId?: string;
    useDirectAoaiApi?: boolean;
    aoaiEndpointOverride?: string;
    aoaiApiKeyOverride?: string;
    aoaiModelOverride?: string;

    enableInputAudioTranscription?: boolean;
    onWebSocketOpen?: () => void;
    onWebSocketClose?: () => void;
    onWebSocketError?: (event: Event) => void;
    onWebSocketMessage?: (event: MessageEvent<any>) => void;

    onReceivedResponseAudioDelta?: (message: ResponseAudioDelta) => void;
    onReceivedInputAudioBufferSpeechStarted?: (message: Message) => void;
    onReceivedResponseDone?: (message: ResponseDone) => void;
    onReceivedExtensionMiddleTierToolResponse?: (message: ExtensionMiddleTierToolResponse) => void;
    onReceivedResponseAudioTranscriptDelta?: (message: ResponseAudioTranscriptDelta) => void;
    onReceivedInputAudioTranscriptionCompleted?: (message: ResponseInputAudioTranscriptionCompleted) => void;
    onReceivedSentimentUpdate?: (message: SentimentUpdate) => void;
    onReceivedSurveyUpdate?: (message: SurveyUpdate) => void;
    onReceivedSurveyBiometricUpdate?: (message: SurveyBiometricUpdate) => void;
    onReceivedError?: (message: Message) => void;
};

export default function useRealTime({
    sessionId,
    useDirectAoaiApi,
    aoaiEndpointOverride,
    aoaiApiKeyOverride,
    aoaiModelOverride,
    enableInputAudioTranscription,
    onWebSocketOpen,
    onWebSocketClose,
    onWebSocketError,
    onWebSocketMessage,
    onReceivedResponseDone,
    onReceivedResponseAudioDelta,
    onReceivedResponseAudioTranscriptDelta,
    onReceivedInputAudioBufferSpeechStarted,
    onReceivedExtensionMiddleTierToolResponse,
    onReceivedInputAudioTranscriptionCompleted,
    onReceivedSentimentUpdate,
    onReceivedSurveyUpdate,
    onReceivedSurveyBiometricUpdate,
    onReceivedError
}: Parameters) {
    const sessionParam = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
    const wsEndpoint = useDirectAoaiApi
        ? `${aoaiEndpointOverride}/openai/realtime?api-key=${aoaiApiKeyOverride}&deployment=${aoaiModelOverride}&api-version=2024-10-01-preview`
        : `/realtime${sessionParam}`;

    // hasConnectedRef: true once startSession() has been called at least once.
    // pendingRestoreRef: set on reconnect; cleared when session.created arrives from Azure.
    // Sending session.update in onOpen is too early — the backend hasn't opened its Azure
    // connection yet. The right moment is when Azure signals it is ready via session.created.
    const hasConnectedRef = useRef(false);
    const pendingRestoreRef = useRef(false);

    const buildSessionUpdateCommand = (): SessionUpdateCommand => {
        const command: SessionUpdateCommand = {
            type: "session.update",
            session: { turn_detection: { type: "server_vad" } }
        };
        if (enableInputAudioTranscription) {
            command.session.input_audio_transcription = { model: "whisper-1" };
        }
        return command;
    };

    const { sendJsonMessage, getWebSocket } = useWebSocket(wsEndpoint, {
        onOpen: () => {
            console.log("[Realtime] WebSocket connected");
            if (hasConnectedRef.current) {
                // Mark that this is a reconnect. We do NOT send session.update here
                // because the backend may not have its Azure WS open yet.
                // We'll send it once Azure says it's ready (session.created).
                console.log("[Realtime] Reconnect detected — will restore context after session.created");
                pendingRestoreRef.current = true;
            }
            onWebSocketOpen?.();
        },
        onClose: () => onWebSocketClose?.(),
        onError: event => onWebSocketError?.(event),
        onMessage: event => onMessageReceived(event),
        shouldReconnect: () => true
    });

    const startSession = () => {
        hasConnectedRef.current = true;
        sendJsonMessage(buildSessionUpdateCommand());
    };

    // Force a clean reconnect: close the live socket so react-use-websocket reopens
    // it (shouldReconnect is always true). The backend opens a brand-new Azure realtime
    // WS per connection, so this wipes Azure's prior conversation memory; persisted
    // context (survey results / report) is re-injected via the session.created →
    // session.update restore path. Used for the new-survey reset and the post-report
    // "answer strictly from the saved report" hard reset.
    const reconnect = () => {
        const socket = getWebSocket();
        socket?.close();
    };

    const refreshSession = () => {
        const command: SessionUpdateCommand = {
            type: "session.update",
            session: {
                turn_detection: {
                    type: "server_vad"
                }
            }
        };
        if (enableInputAudioTranscription) {
            command.session.input_audio_transcription = {
                model: "whisper-1"
            };
        }
        sendJsonMessage(command);
    };

    const addUserAudio = (base64Audio: string) => {
        const command: InputAudioBufferAppendCommand = {
            type: "input_audio_buffer.append",
            audio: base64Audio
        };

        sendJsonMessage(command);
    };

    const inputAudioBufferClear = () => {
        const command: InputAudioBufferClearCommand = {
            type: "input_audio_buffer.clear"
        };

        sendJsonMessage(command);
    };

    const onMessageReceived = (event: MessageEvent<any>) => {
        onWebSocketMessage?.(event);

        let message: Message;
        try {
            message = JSON.parse(event.data);
        } catch (e) {
            console.error("Failed to parse JSON message:", e);
            throw e;
        }

        switch (message.type) {
            case "session.created":
                // Azure Realtime session is initialised and ready to accept commands.
                // If this is a reconnect, send session.update NOW so the backend injects
                // all persisted context (survey results, report, conversation state).
                if (pendingRestoreRef.current) {
                    pendingRestoreRef.current = false;
                    console.log("[Realtime] session.created — sending session.update to restore context");
                    sendJsonMessage(buildSessionUpdateCommand());
                }
                break;
            case "response.done":
                onReceivedResponseDone?.(message as ResponseDone);
                break;
            case "response.audio.delta":
                onReceivedResponseAudioDelta?.(message as ResponseAudioDelta);
                break;
            case "response.audio_transcript.delta":
                onReceivedResponseAudioTranscriptDelta?.(message as ResponseAudioTranscriptDelta);
                break;
            case "input_audio_buffer.speech_started":
                onReceivedInputAudioBufferSpeechStarted?.(message);
                break;
            case "conversation.item.input_audio_transcription.completed":
                onReceivedInputAudioTranscriptionCompleted?.(message as ResponseInputAudioTranscriptionCompleted);
                break;
            case "extension.middle_tier_tool_response":
                onReceivedExtensionMiddleTierToolResponse?.(message as ExtensionMiddleTierToolResponse);
                break;
            case "sentiment.update":
                onReceivedSentimentUpdate?.(message as SentimentUpdate);
                break;
            case "survey.update":
                onReceivedSurveyUpdate?.(message as SurveyUpdate);
                break;
            case "survey.biometric.update":
                onReceivedSurveyBiometricUpdate?.(message as SurveyBiometricUpdate);
                break;
            case "error":
                onReceivedError?.(message);
                break;
        }
    };

    return { startSession, refreshSession, reconnect, addUserAudio, inputAudioBufferClear };
}
