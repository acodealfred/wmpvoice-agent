import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { HeartHandshake, Mic, MicOff, VideoOff, X } from "lucide-react";

import RecoveryWindowCard from "@/components/ui/recovery-window-card";

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
    refreshRealtimeSession?: () => void;
    requestAgentTurn?: () => void;
};

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
                <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
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
 * Docked to the bottom rather than a full-bleed modal, and carries its own
 * camera panel (mirroring the same stream as the main Camera Feed card) so the
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
                    <motion.div
                        initial={{ opacity: 0, y: 24 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 24 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="recovery-window-title"
                        tabIndex={-1}
                        className="fixed inset-x-0 bottom-0 z-[100] flex max-h-[80vh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-[color:var(--ciq-border)] bg-[color:var(--ciq-card)] shadow-2xl outline-none sm:inset-x-auto sm:right-3 sm:bottom-3 sm:max-h-[85vh] sm:w-full sm:max-w-md sm:rounded-2xl sm:border"
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

                        <div className="overflow-y-auto px-6 py-5">
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
                </>
            )}
        </AnimatePresence>
    );
}
