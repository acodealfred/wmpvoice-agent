// Participant-facing alert: the EEG headband dropped out while the assessment is running.
//
// Only raised when EEG was actually streaming during this stretch (Start / Continue);
// someone who chose "Continue without EEG" never sees it. Not raised once the survey is
// complete — the headband is disconnected on purpose when the report starts.

export type EegAlert = null | "baseline" | "survey";

export function eegDisconnectAlert(state: {
    isRecording: boolean;
    /** EEG streamed at some point since this stretch started. */
    eegExpected: boolean;
    eegStatus: string;
    assessmentComplete: boolean;
    inBaseline: boolean;
}): EegAlert {
    if (!state.isRecording || !state.eegExpected || state.assessmentComplete) return null;
    if (state.eegStatus === "streaming") return null;
    return state.inBaseline ? "baseline" : "survey";
}
