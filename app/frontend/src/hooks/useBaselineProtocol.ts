import { useCallback, useEffect, useRef, useState } from "react";

import { BaselineProtocol, type BaselineProtocolOptions, type BaselineProtocolState } from "@/session/baseline-protocol";

/**
 * React wrapper around BaselineProtocol (session/baseline-protocol.ts). Callbacks are
 * read through a ref, so callers can pass fresh closures every render without
 * restarting a protocol that is already running. `secondsLeft` ticks once a second
 * while a phase is recording, for the baseline card's countdown.
 */
export function useBaselineProtocol(options: Omit<BaselineProtocolOptions, "onChange">) {
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const [state, setState] = useState<BaselineProtocolState>({ stage: "idle", phase: null, phaseEndsAt: null, phaseSeconds: 0 });
    const [now, setNow] = useState(() => Date.now());

    const protocolRef = useRef<BaselineProtocol | null>(null);
    if (protocolRef.current === null) {
        protocolRef.current = new BaselineProtocol({
            get eyesOpenSeconds() {
                return optionsRef.current.eyesOpenSeconds;
            },
            get eyesClosedSeconds() {
                return optionsRef.current.eyesClosedSeconds;
            },
            sendCue: cue => optionsRef.current.sendCue(cue),
            onPhaseStart: phase => optionsRef.current.onPhaseStart(phase),
            onPhaseEnd: phase => optionsRef.current.onPhaseEnd(phase),
            onComplete: result => optionsRef.current.onComplete(result),
            onChange: next => {
                setState(next);
                setNow(Date.now());
            }
        });
    }
    const protocol = protocolRef.current;

    useEffect(() => {
        if (state.stage !== "recording") return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [state.stage]);

    // Never leave timers running after unmount.
    useEffect(() => () => protocol.cancel(), [protocol]);

    const secondsLeft = state.phaseEndsAt === null ? state.phaseSeconds : Math.max(0, Math.ceil((state.phaseEndsAt - now) / 1000));

    return {
        state,
        secondsLeft,
        isActive: state.stage === "cue" || state.stage === "recording",
        start: useCallback(() => protocol.start(), [protocol]),
        skip: useCallback(() => protocol.skip(), [protocol]),
        cancel: useCallback(() => protocol.cancel(), [protocol]),
        notifyAudioDelta: useCallback((base64: string) => protocol.notifyAudioDelta(base64), [protocol]),
        notifyResponseDone: useCallback(() => protocol.notifyResponseDone(), [protocol])
    };
}
