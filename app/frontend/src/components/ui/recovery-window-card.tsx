import { useEffect, useState } from "react";
import { HeartHandshake, Loader2, ShieldAlert, Sparkles } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { RecoveryTrackId, RecoveryWindowSession } from "@/types";

// Labels only — full track descriptions live in the voice agent's guided-track
// scripts (app/backend/ciq/recovery/track_scripts.py). Keep in sync with
// app/backend/ciq/recovery/tracks.py's TRACKS ids.
const TRACK_LABELS: Record<RecoveryTrackId, string> = {
    cbt_reframe_reset: "CBT Reframe Reset",
    mindfulness_downshift: "Mindfulness Downshift",
    act_values_recalibration: "ACT Values Recalibration",
    practical_recovery_plan: "Practical Recovery Plan"
};
const ALL_TRACKS = Object.keys(TRACK_LABELS) as RecoveryTrackId[];

// Same copy as ciq/recovery/guardrails.py's STATIC_CRISIS_MESSAGE / STATIC_GROUNDING_MESSAGE
// — kept as duplicated constants (not fetched) since they're static and the card doesn't
// otherwise learn the exact message text once resuming an already-halted session.
const STATIC_CRISIS_MESSAGE =
    "It sounds like things may be harder than usual right now, and that matters. You are more " +
    "than this score, and this tool isn't equipped to support you with that directly — but you " +
    "deserve real support. Please consider reaching out to a crisis line, your EAP, or someone " +
    "you trust as soon as you can. If you're in immediate danger, contact local emergency services.";
const STATIC_GROUNDING_MESSAGE =
    "Thank you for letting us know, and it's completely okay not to say more. Support resources " +
    "— including your EAP and a crisis line — are always available to you, any time, not just right now.";

const cardClass = "rounded-2xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4";

type RecoveryWindowCardProps = {
    surveyRunId?: string;
    sessionId?: string;
    /** Gate the CTA until the deterministic report has actually persisted. */
    scoreReady: boolean;
    /** Bumped by App.tsx on every recovery.* realtime message — triggers a refetch. */
    updateSignal?: number;
    /** Resends session.update so the agent picks up a freshly-started flow. */
    refreshRealtimeSession?: () => void;
    /**
     * Triggers the agent's next turn (response.create) so it actually SPEAKS the
     * fresh recovery-window instructions. refreshRealtimeSession alone only updates
     * what the agent will say on its *next* turn — after a report is delivered the
     * agent goes quiet (qa_mode) waiting for the user, and clicking this card's
     * button is a pure UI action with no accompanying speech, so nothing would
     * otherwise prompt a new turn. Same mechanism App.tsx uses for onStartListening/
     * onStartNewSurvey's opening line (useRealtime's requestGreeting).
     */
    requestAgentTurn?: () => void;
    /** "card" (default) renders the usual bordered card with its own header — used
     * inline in the report panel. "bare" drops both, for embedding inside a container
     * that already provides its own chrome (see recovery-window-screen.tsx). */
    variant?: "card" | "bare";
};

/**
 * A read-only mirror of the voice-driven Recovery Window flow, plus one
 * "Choose Another Track" fallback for non-voice access. The 9-question intake
 * and guided track session are conducted by the voice agent (see
 * ciq/realtime/tools/recovery_handlers.py) — this card never collects answers
 * itself; it only shows a CTA to start the flow and reflects its current
 * status via GET /api/recovery-window/sessions/latest.
 */
export default function RecoveryWindowCard({ surveyRunId, sessionId, scoreReady, updateSignal, refreshRealtimeSession, requestAgentTurn, variant = "card" }: RecoveryWindowCardProps) {
    const [session, setSession] = useState<RecoveryWindowSession | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [choosingTrack, setChoosingTrack] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [showResources, setShowResources] = useState(false);

    const fetchLatest = () => {
        if (!surveyRunId) return;
        setLoading(true);
        setError(null);
        apiFetch(`/api/recovery-window/sessions/latest?survey_run_id=${encodeURIComponent(surveyRunId)}`)
            .then(res => res.json())
            .then(data => setSession(data.session ?? null))
            .catch(() => setError("Couldn't load your Recovery Window status."))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        fetchLatest();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [surveyRunId, updateSignal]);

    const handleStart = async () => {
        setError(null);
        setStarting(true);
        try {
            const res = await apiFetch("/api/recovery-window/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ surveyRunId, sessionId })
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? `Couldn't start your Recovery Window (HTTP ${res.status}).`);
                return;
            }
            // Let the agent pick up the new recovery_flow_state (no WS reconnect
            // needed), THEN explicitly prompt it to speak — the user just clicked a
            // button, not spoken, so nothing else would trigger the agent's opening
            // line for the intake script.
            refreshRealtimeSession?.();
            requestAgentTurn?.();
            fetchLatest();
        } catch {
            setError("Couldn't start your Recovery Window — check your connection and try again.");
        } finally {
            setStarting(false);
        }
    };

    const handleSelectTrack = async (trackId: RecoveryTrackId) => {
        if (!session) return;
        setSelecting(true);
        setError(null);
        try {
            const res = await apiFetch(`/api/recovery-window/sessions/${session.recoverySessionId}/select-track`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trackId })
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? `Couldn't switch tracks (HTTP ${res.status}).`);
                return;
            }
            setChoosingTrack(false);
            fetchLatest();
        } catch {
            setError("Couldn't switch tracks — check your connection and try again.");
        } finally {
            setSelecting(false);
        }
    };

    const trackChoiceUi = (currentTrack: RecoveryTrackId | null) => (
        <div className="mt-2 space-y-2">
            {choosingTrack ? (
                <div className="space-y-1.5">
                    {ALL_TRACKS.filter(t => t !== currentTrack).map(t => (
                        <button
                            key={t}
                            type="button"
                            disabled={selecting}
                            onClick={() => handleSelectTrack(t)}
                            className="w-full rounded-lg border border-[color:var(--ciq-line)] px-3 py-2 text-left text-sm text-[color:var(--ciq-text-body)] hover:bg-[color:var(--ciq-card)] disabled:opacity-50"
                        >
                            {TRACK_LABELS[t]}
                        </button>
                    ))}
                    <button
                        type="button"
                        className="text-xs font-semibold text-[color:var(--ciq-text-muted)] underline underline-offset-2"
                        onClick={() => setChoosingTrack(false)}
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <button
                    type="button"
                    className="text-xs font-semibold text-[color:var(--ciq-text-muted)] underline underline-offset-2"
                    onClick={() => setChoosingTrack(true)}
                >
                    Choose Another Track
                </button>
            )}
        </div>
    );

    const renderBody = () => {
        if (!surveyRunId || !scoreReady) {
            return <p className="text-sm text-[color:var(--ciq-text-muted)]">Your Recovery Window will be available once your report finishes generating.</p>;
        }
        if (loading && !session) {
            return (
                <div className="flex items-center gap-2 text-sm text-[color:var(--ciq-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Checking your Recovery Window…
                </div>
            );
        }
        if (!session) {
            return (
                <div className="space-y-2">
                    <p className="text-sm text-[color:var(--ciq-text-body)]">
                        Before we begin, this is here to support you, not judge you. A short, voice-guided check-in that
                        suggests a guided recovery track tailored to how you're doing right now.
                    </p>
                    <button
                        type="button"
                        className="ciq-btn-primary ciq-touch rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60"
                        disabled={starting}
                        onClick={handleStart}
                    >
                        {starting ? "Starting…" : "Start your Recovery Window"}
                    </button>
                </div>
            );
        }

        switch (session.status) {
            case "urgent_support":
                return (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        <p>{STATIC_CRISIS_MESSAGE}</p>
                    </div>
                );
            case "grounding_only":
                return (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        <p>{STATIC_GROUNDING_MESSAGE}</p>
                        <button
                            type="button"
                            className="mt-2 text-xs font-semibold underline underline-offset-2"
                            onClick={handleStart}
                        >
                            Start again
                        </button>
                    </div>
                );
            case "not_started":
            case "intake_in_progress":
                return (
                    <div className="flex items-center gap-2 text-sm text-[color:var(--ciq-text-body)]">
                        <Loader2 className="h-4 w-4 animate-spin" /> Listen for the agent — your Recovery Window check-in is
                        under way.
                    </div>
                );
            case "track_recommended":
            case "session_in_progress":
            case "completed": {
                const track = session.selectedTrack ?? session.recommendedTrack;
                return (
                    <div className="space-y-2">
                        {track && (
                            <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--ciq-text-strong)]">
                                <Sparkles className="h-4 w-4" /> {TRACK_LABELS[track]}
                            </div>
                        )}
                        {session.recommendationRationale && (
                            <p className="text-sm text-[color:var(--ciq-text-body)]">{session.recommendationRationale}</p>
                        )}
                        {session.status === "session_in_progress" && (
                            <p className="text-xs text-[color:var(--ciq-text-muted)]">Follow along with the agent to complete this track.</p>
                        )}
                        {session.status === "completed" && (
                            <p className="text-xs text-[color:var(--ciq-text-muted)]">Recovery Window complete — take care of yourself.</p>
                        )}
                        {session.status === "track_recommended" && trackChoiceUi(session.recommendedTrack)}
                    </div>
                );
            }
            default:
                return null;
        }
    };

    const body = (
        <>
            {renderBody()}

            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

            {/* Always available, independent of intake state — access to support
                resources shouldn't depend on the voice flow reaching the safety
                question first. */}
            <div className="mt-3 border-t border-[color:var(--ciq-line)] pt-2">
                <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-[color:var(--ciq-text-muted)] underline underline-offset-2"
                    onClick={() => setShowResources(v => !v)}
                >
                    <ShieldAlert className="h-3 w-3" /> Not sure this is the right time? Get support resources
                </button>
                {showResources && <p className="mt-2 text-xs text-[color:var(--ciq-text-body)]">{STATIC_CRISIS_MESSAGE}</p>}
            </div>
        </>
    );

    if (variant === "bare") {
        return body;
    }

    return (
        <div className={`mb-4 ${cardClass}`}>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                <HeartHandshake className="h-5 w-5" /> Recovery Window
            </div>
            {body}
        </div>
    );
}
