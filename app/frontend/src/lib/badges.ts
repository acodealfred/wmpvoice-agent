// Theme-aware badge / banner / text colour helpers, driven by the CIQ accent
// tokens so they read correctly in both light and dark mode. The class strings
// are written out in full (no runtime interpolation) so Tailwind's JIT can see
// and generate the arbitrary `color-mix(...)` utilities.

export type Tone = "green" | "amber" | "red" | "blue" | "purple" | "neutral";

// Soft tinted pill: low-opacity accent background + accent text.
export const PILL: Record<Tone, string> = {
    green: "bg-[color-mix(in_srgb,var(--ciq-accent-green)_16%,transparent)] text-[color:var(--ciq-accent-green)]",
    amber: "bg-[color-mix(in_srgb,var(--ciq-accent-amber)_16%,transparent)] text-[color:var(--ciq-accent-amber)]",
    red: "bg-[color-mix(in_srgb,var(--ciq-accent-red)_16%,transparent)] text-[color:var(--ciq-accent-red)]",
    blue: "bg-[color-mix(in_srgb,var(--ciq-accent-blue)_16%,transparent)] text-[color:var(--ciq-accent-blue)]",
    purple: "bg-[color-mix(in_srgb,var(--ciq-accent-purple)_16%,transparent)] text-[color:var(--ciq-accent-purple)]",
    neutral: "bg-[color:var(--ciq-tile-strong)] text-[color:var(--ciq-text-muted)]"
};

// Banner: tinted background + visible border + accent text (for status messages).
export const BANNER: Record<Tone, string> = {
    green: "border border-[color-mix(in_srgb,var(--ciq-accent-green)_32%,transparent)] bg-[color-mix(in_srgb,var(--ciq-accent-green)_12%,transparent)] text-[color:var(--ciq-accent-green)]",
    amber: "border border-[color-mix(in_srgb,var(--ciq-accent-amber)_32%,transparent)] bg-[color-mix(in_srgb,var(--ciq-accent-amber)_12%,transparent)] text-[color:var(--ciq-accent-amber)]",
    red: "border border-[color-mix(in_srgb,var(--ciq-accent-red)_32%,transparent)] bg-[color-mix(in_srgb,var(--ciq-accent-red)_12%,transparent)] text-[color:var(--ciq-accent-red)]",
    blue: "border border-[color-mix(in_srgb,var(--ciq-accent-blue)_32%,transparent)] bg-[color-mix(in_srgb,var(--ciq-accent-blue)_12%,transparent)] text-[color:var(--ciq-accent-blue)]",
    purple: "border border-[color-mix(in_srgb,var(--ciq-accent-purple)_32%,transparent)] bg-[color-mix(in_srgb,var(--ciq-accent-purple)_12%,transparent)] text-[color:var(--ciq-accent-purple)]",
    neutral: "border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] text-[color:var(--ciq-text-body)]"
};

// Just the accent text colour.
export const TEXT_TONE: Record<Tone, string> = {
    green: "text-[color:var(--ciq-accent-green)]",
    amber: "text-[color:var(--ciq-accent-amber)]",
    red: "text-[color:var(--ciq-accent-red)]",
    blue: "text-[color:var(--ciq-accent-blue)]",
    purple: "text-[color:var(--ciq-accent-purple)]",
    neutral: "text-[color:var(--ciq-text-muted)]"
};

export const riskTone = (risk: string): Tone => (risk === "Low" ? "green" : risk === "Moderate" ? "amber" : "red");
export const confidenceTone = (c: string): Tone => (c === "high" ? "green" : c === "medium" ? "amber" : "neutral");
export const sentimentTone = (s: string): Tone => (s === "positive" ? "green" : s === "negative" ? "red" : "amber");
