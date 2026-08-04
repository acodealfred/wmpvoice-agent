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

// Server VAD tuning shared by every session.update — the default threshold (~0.5)
// is tuned for a quiet room, so raise it here to require a louder signal before
// ambient noise (fans, hum, cross-talk) counts as speech and triggers a turn.
const VAD_TURN_DETECTION = {
    type: "server_vad" as const,
    threshold: 0.65,
    prefix_padding_ms: 300,
    silence_duration_ms: 500
};

type Parameters = {
    sessionId?: string;
    // Carried on the /realtime WS connect URL so the backend can resolve this
    // session's survey type ATOMICALLY with connection setup (see
    // RTMiddleTier._websocket_handler) instead of depending on a separate
    // POST /survey-type call having already landed first. Only takes effect the
    // FIRST time the backend sees this session_id — later reconnects (and later
    // changes to this value while already connected) are ignored server-side.
    surveyType?: string;
    // Gates the actual socket connection (default true). Callers that resolve
    // sessionId/surveyType from separate async calls (e.g. /me then /config)
    // should hold this false until BOTH have landed, so the very first
    // connection attempt already carries the right survey_type — otherwise the
    // socket opens without it, the backend binds this session_id to its default
    // survey type, and that binding is permanent for the session's lifetime
    // (see RTMiddleTier._websocket_handler's `not sess.survey_config` guard).
    ready?: boolean;
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
    // Fired every time Azure signals session.created (initial connect AND each reconnect).
    // Lets the caller know the fresh session is live — e.g. to lift a reset audio guard.
    onReceivedSessionReady?: () => void;
    onReceivedError?: (message: Message) => void;
};

export default function useRealTime({
    sessionId,
    surveyType,
    ready = true,
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
    onReceivedSessionReady,
    onReceivedError
}: Parameters) {
    const connectParams = new URLSearchParams();
    if (sessionId) connectParams.set("session_id", sessionId);
    if (surveyType) connectParams.set("survey_type", surveyType);
    const sessionParam = connectParams.toString() ? `?${connectParams.toString()}` : "";
    const wsEndpoint = useDirectAoaiApi
        ? `${aoaiEndpointOverride}/openai/realtime?api-key=${aoaiApiKeyOverride}&deployment=${aoaiModelOverride}&api-version=2024-10-01-preview`
        : `/realtime${sessionParam}`;

    // hasConnectedRef: true once startSession() has been called at least once.
    // pendingRestoreRef: set on reconnect; cleared when session.created arrives from Azure.
    // Sending session.update in onOpen is too early — the backend hasn't opened its Azure
    // connection yet. The right moment is when Azure signals it is ready via session.created.
    const hasConnectedRef = useRef(false);
    const pendingRestoreRef = useRef(false);
    // Set by startSession() so the agent opens the conversation itself instead of
    // waiting for the user to speak. Fired once the session is ready (immediately if the
    // socket is already open, otherwise after the session.created restore). NOT set by a
    // genuine dropped-socket reconnect, so reconnects never trigger an unwanted greeting.
    const pendingGreetingRef = useRef(false);

    const buildSessionUpdateCommand = (): SessionUpdateCommand => {
        const command: SessionUpdateCommand = {
            type: "session.update",
            session: { turn_detection: VAD_TURN_DETECTION }
        };
        if (enableInputAudioTranscription) {
            command.session.input_audio_transcription = { model: "whisper-1" };
        }
        return command;
    };

    const { sendJsonMessage, getWebSocket } = useWebSocket(ready ? wsEndpoint : null, {
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
        shouldReconnect: () => true,
        // The library default is 5000ms — far too slow for our intentional reset reconnects
        // (Start New Survey / post-report hard reset), which manifested as a ~5s silence
        // before the fresh agent spoke. Reopen almost immediately, backing off only if a
        // genuine network drop keeps failing.
        reconnectInterval: (attempt: number) => Math.min(250 * 2 ** attempt, 5000),
        reconnectAttempts: 20
    });

    // Send response.create so the agent produces an opening turn (greeting + warm-up).
    // Only fires while the socket is open and a greeting is pending; clears the flag so it
    // can never double-fire (e.g. on the post-baseline refresh or a later reconnect).
    const maybeSendGreeting = () => {
        const socket = getWebSocket();
        if (pendingGreetingRef.current && socket && socket.readyState === WebSocket.OPEN) {
            pendingGreetingRef.current = false;
            console.log("[Realtime] Triggering agent opening turn (response.create)");
            sendJsonMessage({ type: "response.create" });
        }
    };

    const startSession = () => {
        hasConnectedRef.current = true;
        sendJsonMessage(buildSessionUpdateCommand());
    };

    // Ask the agent to open the conversation itself. Call this AFTER the caller has armed
    // audio playback/recording so the opening turn isn't dropped. Fires immediately if the
    // socket is open; if it is still reopening (new-survey reset reconnects first), it is
    // deferred to the next session.created.
    const requestGreeting = () => {
        pendingGreetingRef.current = true;
        maybeSendGreeting();
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
                turn_detection: VAD_TURN_DETECTION
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
                // Fire any deferred opening turn now the session is ready (new-survey path,
                // where startSession ran while the socket was mid-reconnect). A no-op unless
                // startSession armed it, so genuine reconnects stay silent.
                maybeSendGreeting();
                // The fresh session is live: any audio from here on belongs to the new
                // conversation, so the caller can lift its reset audio guard.
                onReceivedSessionReady?.();
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

    return { startSession, requestGreeting, refreshSession, reconnect, addUserAudio, inputAudioBufferClear };
}
