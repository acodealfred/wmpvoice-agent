import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { HeartHandshake, Mic, MicOff, MessageSquare, VideoOff, X } from "lucide-react";

import RecoveryWindowCard from "@/components/ui/recovery-window-card";
import { ChatTurn } from "@/types";

type RecoveryWindowScreenProps = {
    open: boolean;
    onClose: () => void;
    surveyRunId?: string;
    sessionId?: string;
    scoreReady: boolean;
    updateSignal?: number;
    /** Whether the voice session's mic is currently live — drives the status strip. */
    isRecording: boolean;
    /** Resumes listening if the user paused/stopped it before opening this screen. */
    onResumeListening?: () => void;
    /** The SAME MediaStream backing the main Camera Feed panel (see App.tsx's
     * onStreamReady wiring) — mirrored into this screen's own <video> element so the
     * camera panel shows here too, matching the survey, without a second getUserMedia
     * capture. */
    cameraStream?: MediaStream | null;
    /** Live text transcript of the voice conversation, rendered as a chat panel. */
    chatTranscript?: ChatTurn[];
    refreshRealtimeSession?: () => void;
    requestAgentTurn?: () => void;
};

/** Text mirror of the spoken conversation so the user can read along with the
 * voice agent while the Recovery Window check-in runs. */
function ChatTranscriptPanel({ turns }: { turns: ChatTurn[] }) {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Keep the newest turn in view as the agent's reply streams in.
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, [turns]);

    return (
        <div className="flex min-h-0 flex-col border-b border-[color:var(--ciq-divider)]">
            <p className="flex items-center gap-1.5 px-6 pb-2 pt-4 text-xs font-medium uppercase tracking-wider text-[color:var(--ciq-text-60)]">
                <MessageSquare className="h-3.5 w-3.5" /> Conversation
            </p>
            <div ref={scrollRef} className="max-h-52 space-y-2 overflow-y-auto px-6 pb-4">
                {turns.length === 0 ? (
                    <p className="text-xs text-[color:var(--ciq-text-muted)]">The conversation will appear here as you and the agent speak.</p>
                ) : (
                    turns.map(turn => (
                        <div key={turn.id} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
                            <div
                                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                                    turn.role === "user"
                                        ? "bg-[color:var(--ciq-accent-blue)] text-[#0a0c0e]"
                                        : "bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-body)]"
                                }`}
                            >
                                {turn.text || <span className="opacity-60">…</span>}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

/** Small camera panel matching the survey's "Camera Feed" card, bound to the shared
 * stream mirrored down from App.tsx's main VideoPanel. */
function MiniCameraPanel({ stream }: { stream?: MediaStream | null }) {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.srcObject = stream ?? null;
        }
    }, [stream]);

    return (
        <div className="border-b border-[color:var(--ciq-divider)] px-6 py-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-[color:var(--ciq-text-60)]">Camera Feed</p>
            <div className="relative mx-auto aspect-video w-full overflow-hidden rounded-lg bg-[color:var(--ciq-card-2)]">
                <video ref={videoRef} autoPlay muted playsInline className="h-full w-full origin-center scale-x-[-1] object-cover" />
                {!stream && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[color:var(--ciq-card-2)]">
                        <VideoOff className="h-8 w-8 text-[color:var(--ciq-text-muted)]" />
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * The dedicated home for the Recovery Window — separated from the report panel
 * (where a small inline card used to live) so the voice-guided check-in reads
 * as its own place rather than one more tile among the report stats.
 *
 * A centered modal dialog (not full-bleed), carrying its own camera panel
 * (mirroring the same stream as the main Camera Feed card) so the
 * experience matches the survey's always-visible camera instead of relying on
 * whatever happens to still be on screen behind it. The underlying realtime
 * WebSocket/audio session is unaffected by this screen opening or closing
 * either way — it lives in App.tsx regardless of which screen is showing, so
 * voice interaction continues uninterrupted underneath.
 */
export default function RecoveryWindowScreen({
    open,
    onClose,
    surveyRunId,
    sessionId,
    scoreReady,
    updateSignal,
    isRecording,
    onResumeListening,
    cameraStream,
    chatTranscript = [],
    refreshRealtimeSession,
    requestAgentTurn
}: RecoveryWindowScreenProps) {
    return (
        <AnimatePresence>
            {open && (
                <>
                    {/* Dimmed/blurred backdrop + click-outside-to-close. Safe to obscure the
                        rest of the page now — this screen carries its own camera panel
                        (MiniCameraPanel below), so nothing behind it needs to stay visible. */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[99] bg-black/60 backdrop-blur-sm"
                        onClick={onClose}
                    />
                    {/* Centered dialog — the container fills the viewport and centers the
                        panel; clicking its padding (outside the panel) still closes. */}
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
                    <motion.div
                        initial={{ opacity: 0, y: 24, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 24, scale: 0.98 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="recovery-window-title"
                        tabIndex={-1}
                        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-card)] shadow-2xl outline-none"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-4 border-b border-[color:var(--ciq-divider)] px-6 py-5">
                            <div className="flex items-center gap-3">
                                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[color:var(--ciq-accent-purple)]">
                                    <HeartHandshake className="h-5 w-5 text-[#0a0c0e]" />
                                </span>
                                <h2 id="recovery-window-title" className="text-lg font-semibold text-[color:var(--ciq-text-strong)]">
                                    Recovery Window
                                </h2>
                            </div>
                            <button
                                type="button"
                                aria-label="Close Recovery Window"
                                onClick={onClose}
                                className="rounded-md p-1 text-[color:var(--ciq-text-muted)] transition-colors hover:bg-[color:var(--ciq-hover)] hover:text-[color:var(--ciq-text-body)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <MiniCameraPanel stream={cameraStream} />

                        <div className="flex items-center gap-2 border-b border-[color:var(--ciq-divider)] px-6 py-3 text-xs">
                            {isRecording ? (
                                <>
                                    <span className="relative flex h-2 w-2">
                                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--ciq-accent-green)] opacity-75" />
                                        <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--ciq-accent-green)]" />
                                    </span>
                                    <Mic className="h-3.5 w-3.5 text-[color:var(--ciq-text-muted)]" />
                                    <span className="text-[color:var(--ciq-text-muted)]">Live — the agent can hear you, speak naturally.</span>
                                </>
                            ) : (
                                <>
                                    <MicOff className="h-3.5 w-3.5 text-amber-500" />
                                    <span className="text-[color:var(--ciq-text-muted)]">Voice session paused.</span>
                                    {onResumeListening && (
                                        <button
                                            type="button"
                                            onClick={onResumeListening}
                                            className="ml-auto rounded-full bg-[color:var(--ciq-accent-blue)] px-3 py-1 text-xs font-semibold text-[#0a0c0e]"
                                        >
                                            Resume Listening
                                        </button>
                                    )}
                                </>
                            )}
                        </div>

                        <ChatTranscriptPanel turns={chatTranscript} />

                        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                            <RecoveryWindowCard
                                variant="bare"
                                surveyRunId={surveyRunId}
                                sessionId={sessionId}
                                scoreReady={scoreReady}
                                updateSignal={updateSignal}
                                refreshRealtimeSession={refreshRealtimeSession}
                                requestAgentTurn={requestAgentTurn}
                            />
                        </div>
                    </motion.div>
                    </div>
                </>
            )}
        </AnimatePresence>
    );
}
