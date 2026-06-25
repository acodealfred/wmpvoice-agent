// Band thresholds — the SINGLE FE source of truth, mirroring the backend
// survey_loader.blink_band / pupil_band. Keep these numbers identical to the BE.
export type BlinkLevel = "Unknown" | "Normal" | "Elevated" | "High";
export type PupilLevel = "Unknown" | "Low" | "Medium" | "High";

/** Blink-rate %-change vs baseline → level. |Δ|≤15 Normal, ≤40 Elevated, else High. */
export function blinkBandLevel(changePct: number | null | undefined): BlinkLevel {
    if (changePct == null) return "Unknown";
    const mag = Math.abs(changePct);
    if (mag <= 15) return "Normal";
    if (mag <= 40) return "Elevated";
    return "High";
}

/** Pupil mm-change vs baseline → band. ≤0.1 Low, ≤0.3 Medium, else High. */
export function pupilBandLevel(mmChange: number | null | undefined): PupilLevel {
    if (mmChange == null) return "Unknown";
    if (mmChange <= 0.1) return "Low";
    if (mmChange <= 0.3) return "Medium";
    return "High";
}
