// Admin "Live Monitor" tab — watch the data of assessments while they run, instead of
// discovering gaps in the exports afterwards. Shows health only (is each stream
// arriving, is it valid), never the data itself. Backend: ciq/monitoring/.
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, Check, Loader2, Radio, X } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { BANNER, PILL } from "@/lib/badges";
import {
    CONNECTION_LABEL,
    EEG_CHANNELS,
    LEVEL_LABEL,
    LEVEL_SWATCH,
    LEVEL_TONE,
    PHASE_STEPS,
    STREAM_LABEL,
    formatDuration,
    issueLog,
    phaseStepIndex,
    type MonitorLevel,
    type MonitorSecond,
    type MonitorSession,
    type MonitorSessionsResponse,
    type MonitorStream
} from "@/lib/live-monitor";

const POLL_MS = 2000;
const STREAMS: MonitorStream[] = ["eeg", "camera", "mic", "timeline"];
const BADGE = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wider";
const CARD = "rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)]";

const clockTime = (epochS: number) => new Date(epochS * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Polls `fn` every POLL_MS while the page is visible; one request in flight at a time. */
function usePolling(fn: () => Promise<void>, enabled: boolean) {
    const fnRef = useRef(fn);
    fnRef.current = fn;
    useEffect(() => {
        if (!enabled) return;
        let stopped = false;
        let timer = 0;
        const run = async () => {
            if (stopped) return;
            if (document.visibilityState === "visible") await fnRef.current().catch(() => undefined);
            if (!stopped) timer = window.setTimeout(run, POLL_MS);
        };
        void run();
        const onVisible = () => {
            if (document.visibilityState === "visible") {
                window.clearTimeout(timer);
                void run();
            }
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            stopped = true;
            window.clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [enabled]);
}

function LevelPill({ level, label }: { level: MonitorLevel; label?: string }) {
    return (
        <span className={`${BADGE} ${PILL[LEVEL_TONE[level]]}`}>
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {label ?? LEVEL_LABEL[level]}
        </span>
    );
}

function PhaseStepper({ session }: { session: MonitorSession }) {
    const current = phaseStepIndex(session.phase);
    return (
        <ol className="flex items-center gap-1" aria-label="Assessment phase">
            {PHASE_STEPS.map((step, i) => {
                const done = i < current;
                const active = i === current;
                const label = step.phase === "survey" && session.total ? `Survey ${session.answered}/${session.total}` : step.label;
                return (
                    <li key={step.phase} className="flex min-w-0 flex-1 flex-col gap-1" aria-current={active ? "step" : undefined}>
                        <span
                            className={`h-1.5 rounded-full ${
                                active ? "bg-[color:var(--ciq-accent-blue)]" : done ? "bg-[color:var(--ciq-accent-green)]" : "bg-[color:var(--ciq-tile-strong)]"
                            }`}
                        />
                        <span
                            className={`truncate text-[10px] ${active ? "font-semibold text-[color:var(--ciq-text-strong)]" : "text-[color:var(--ciq-text-muted)]"}`}
                        >
                            {label}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

function StreamLights({ levels }: { levels: MonitorSession["levels"] }) {
    return (
        <div className="grid grid-cols-4 gap-1.5">
            {STREAMS.map(stream => {
                const level = levels[stream] ?? "off";
                return (
                    <div
                        key={stream}
                        title={`${STREAM_LABEL[stream]}: ${LEVEL_LABEL[level]}`}
                        className={`flex items-center justify-center gap-1 rounded-md px-1 py-1 text-[10px] font-semibold ${PILL[LEVEL_TONE[level]]}`}
                    >
                        {level === "ok" ? <Check className="h-3 w-3" /> : level === "off" ? null : <AlertTriangle className="h-3 w-3" />}
                        {STREAM_LABEL[stream]}
                    </div>
                );
            })}
        </div>
    );
}

export function SessionCard({
    session,
    serverTime,
    selected,
    onSelect
}: {
    session: MonitorSession;
    serverTime: number;
    selected: boolean;
    onSelect: () => void;
}) {
    const borderTone =
        session.overall === "bad"
            ? "border-[color:var(--ciq-accent-red)]"
            : session.overall === "warn"
              ? "border-[color:var(--ciq-accent-amber)]"
              : "border-[color:var(--ciq-line)]";
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            className={`${CARD} ${borderTone} flex flex-col gap-3 p-4 text-left transition hover:opacity-95 focus-visible:ring-2 focus-visible:ring-[color:var(--ciq-accent-blue)] ${
                selected ? "ring-2 ring-[color:var(--ciq-accent-blue)]" : ""
            }`}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[color:var(--ciq-text-strong)]">{session.userName ?? "Unknown user"}</p>
                    <p className="font-data truncate text-[11px] text-[color:var(--ciq-text-muted)]">
                        {session.surveyType ?? "—"} · {formatDuration(session.startedAt ? serverTime - session.startedAt : null)} elapsed
                        {session.phaseSeconds !== null && ` · ${formatDuration(session.phaseSeconds)} in phase`}
                    </p>
                </div>
                <LevelPill
                    level={session.connection === "live" ? session.overall : "bad"}
                    label={session.connection === "live" ? LEVEL_LABEL[session.overall] : CONNECTION_LABEL[session.connection]}
                />
            </div>
            <PhaseStepper session={session} />
            <StreamLights levels={session.levels} />
            {session.issues.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-xs text-[color:var(--ciq-text-body)]">
                    {session.issues.slice(0, 3).map(issue => (
                        <li key={issue} className="flex gap-1.5">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-[color:var(--ciq-accent-amber)]" />
                            <span>{issue}</span>
                        </li>
                    ))}
                    {session.issues.length > 3 && <li className="text-[color:var(--ciq-text-muted)]">+{session.issues.length - 3} more</li>}
                </ul>
            ) : (
                <p className="text-xs text-[color:var(--ciq-text-muted)]">All data arriving normally.</p>
            )}
        </button>
    );
}

/** One row of coloured seconds, oldest left — the newest second is at the right edge. */
function SecondsStrip({ label, levels }: { label: string; levels: MonitorLevel[] }) {
    return (
        <div className="flex items-center gap-2">
            <span className="font-data w-20 shrink-0 text-[11px] text-[color:var(--ciq-text-muted)]">{label}</span>
            <div className="flex h-4 min-w-0 flex-1 gap-px overflow-hidden rounded" role="img" aria-label={`${label}: last ${levels.length} seconds`}>
                {levels.map((level, i) => (
                    <span key={i} className={`h-full min-w-0 flex-1 ${LEVEL_SWATCH[level]}`} title={LEVEL_LABEL[level]} />
                ))}
            </div>
        </div>
    );
}

function SessionDetail({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const [session, setSession] = useState<MonitorSession | null>(null);
    const [gone, setGone] = useState(false);

    const load = useCallback(async () => {
        const res = await apiFetch(`/admin/monitor/sessions/${encodeURIComponent(sessionId)}`);
        if (res.status === 404) {
            setGone(true);
            return;
        }
        if (!res.ok) return;
        setGone(false);
        setSession((await res.json()).session);
    }, [sessionId]);
    usePolling(load, true);

    const history: MonitorSecond[] = session?.history ?? [];
    const log = issueLog(history);
    const eeg = session?.eeg;

    return (
        <section className={`${CARD} flex flex-col gap-4 p-4`} aria-labelledby="lm-detail-h">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 id="lm-detail-h" className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">
                        {session?.userName ?? "Session"} — last {history.length} s
                    </h2>
                    <p className="font-data break-all text-[11px] text-[color:var(--ciq-text-muted)]">run {session?.surveyRunId ?? "—"}</p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close details"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[color:var(--ciq-line)] text-[color:var(--ciq-text-strong)] hover:opacity-90"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            {gone && <p className={`rounded-lg px-3 py-2 text-sm ${BANNER.neutral}`}>This session is no longer live.</p>}

            {session && (
                <>
                    <div className="flex flex-col gap-1.5">
                        <p className="text-xs font-semibold text-[color:var(--ciq-text-body)]">EEG per channel</p>
                        {EEG_CHANNELS.map(ch => (
                            <SecondsStrip key={ch} label={ch} levels={history.map(s => s.channels[ch] ?? "off")} />
                        ))}
                        <p className="mt-2 text-xs font-semibold text-[color:var(--ciq-text-body)]">Other streams</p>
                        {(["camera", "mic", "timeline"] as const).map(stream => (
                            <SecondsStrip key={stream} label={STREAM_LABEL[stream]} levels={history.map(s => s.levels[stream] ?? "off")} />
                        ))}
                        <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-[color:var(--ciq-text-muted)]">
                            {(["ok", "warn", "bad", "off"] as const).map(level => (
                                <span key={level} className="inline-flex items-center gap-1">
                                    <span className={`h-2.5 w-2.5 rounded-sm ${LEVEL_SWATCH[level]}`} />
                                    {LEVEL_LABEL[level]}
                                </span>
                            ))}
                        </div>
                    </div>

                    {eeg && eeg.status && (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {EEG_CHANNELS.map(ch => (
                                <div key={ch} className="rounded-lg bg-[color:var(--ciq-tile)] p-2">
                                    <p className="font-data text-[11px] text-[color:var(--ciq-text-muted)]">{ch}</p>
                                    <p className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">{eeg.samples[ch] ?? 0}/256 per s</p>
                                    <p className="text-[11px] capitalize text-[color:var(--ciq-text-muted)]">contact: {eeg.contact[ch] ?? "—"}</p>
                                </div>
                            ))}
                            <p className="col-span-2 text-[11px] text-[color:var(--ciq-text-muted)] sm:col-span-4">
                                Headband {eeg.status}
                                {eeg.battery !== null && ` · battery ${eeg.battery}%`}
                                {eeg.rate_hz !== null && ` · ${eeg.rate_hz} Hz`}
                                {eeg.recorder_packets !== null && ` · ${eeg.recorder_packets.toLocaleString()} packets in this recording`}
                            </p>
                        </div>
                    )}

                    <div>
                        <p className="mb-1 text-xs font-semibold text-[color:var(--ciq-text-body)]">Issue log</p>
                        {log.length === 0 ? (
                            <p className="text-xs text-[color:var(--ciq-text-muted)]">No issues in this window.</p>
                        ) : (
                            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto text-xs text-[color:var(--ciq-text-body)]">
                                {log.map(entry => (
                                    <li key={`${entry.t}-${entry.issue}`} className="flex gap-2">
                                        <span className="font-data shrink-0 text-[color:var(--ciq-text-muted)]">{clockTime(entry.t)}</span>
                                        <span>{entry.issue}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </>
            )}
            {!session && !gone && <Loader2 className="h-5 w-5 animate-spin text-[color:var(--ciq-text-muted)]" />}
        </section>
    );
}

export function LiveMonitorPanel() {
    const [data, setData] = useState<MonitorSessionsResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<number | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await apiFetch("/admin/monitor/sessions");
            if (!res.ok) throw new Error(`Live monitor request failed (${res.status})`);
            setData(await res.json());
            setError(null);
            setLastUpdated(Date.now());
        } catch (err) {
            setError(err instanceof Error ? err.message : "Live monitor request failed");
        }
    }, []);
    usePolling(load, true);

    const sessions = data?.sessions ?? [];
    const serverTime = data?.serverTime ?? Date.now() / 1000;
    const problems = sessions.filter(s => s.overall === "bad").length;

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex max-w-2xl flex-col gap-1">
                    <span className="font-data text-xs tracking-widest text-[color:var(--ciq-text-muted)]">LIVE DATA HEALTH</span>
                    <h1 className="font-display text-3xl font-bold text-[color:var(--ciq-text-strong)]">Live Monitor</h1>
                    <p className="text-sm text-[color:var(--ciq-text-muted)]">
                        Running assessments, checked every second: is each data stream arriving, and is it valid? Shows health only, never the data itself.
                    </p>
                </div>
                <div className="flex flex-col items-end">
                    <span className="inline-flex items-center gap-1.5 text-xs text-[color:var(--ciq-text-muted)]">
                        <Radio className={`h-3.5 w-3.5 ${error ? "" : "text-[color:var(--ciq-accent-green)]"}`} />
                        {error ? "Not updating" : "Updating every 2 s"}
                    </span>
                    <span className="font-data text-sm text-[color:var(--ciq-text-body)]">
                        {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "—"}
                    </span>
                </div>
            </div>

            {error && <p className={`rounded-lg px-3 py-2 text-sm ${BANNER.red}`}>{error}</p>}
            {data && !data.enabled && (
                <p className={`rounded-lg px-3 py-2 text-sm ${BANNER.neutral}`}>The live monitor is turned off on the server (ENABLE_LIVE_MONITOR=false).</p>
            )}

            {data?.enabled && (
                <div className="flex flex-wrap gap-2">
                    <span className={`${BADGE} ${PILL.blue}`}>{sessions.length} running</span>
                    {problems > 0 && <span className={`${BADGE} ${PILL.red}`}>{problems} with problems</span>}
                </div>
            )}

            {data?.enabled && sessions.length === 0 && (
                <div className={`${CARD} flex flex-col items-center gap-2 py-12 text-center`}>
                    <Activity className="h-7 w-7 text-[color:var(--ciq-text-muted)]" />
                    <p className="text-sm font-medium text-[color:var(--ciq-text-body)]">No assessments running right now</p>
                    <p className="text-xs text-[color:var(--ciq-text-muted)]">A session appears here as soon as someone presses Start.</p>
                </div>
            )}

            {sessions.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {sessions.map(s => (
                        <SessionCard
                            key={s.sessionId}
                            session={s}
                            serverTime={serverTime}
                            selected={s.sessionId === selectedId}
                            onSelect={() => setSelectedId(id => (id === s.sessionId ? null : s.sessionId))}
                        />
                    ))}
                </div>
            )}

            {selectedId && <SessionDetail key={selectedId} sessionId={selectedId} onClose={() => setSelectedId(null)} />}

            {!data && !error && <Loader2 className="h-5 w-5 animate-spin text-[color:var(--ciq-text-muted)]" />}
        </div>
    );
}
