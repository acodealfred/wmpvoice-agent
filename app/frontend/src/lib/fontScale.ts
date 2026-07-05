// App-wide text-size control. Scales the root font-size so every rem-based
// Tailwind size grows together (like browser zoom). Persisted in localStorage.

export type FontScale = "small" | "medium" | "large";

const KEY = "ciq-font-scale";

export const FONT_SCALES: FontScale[] = ["small", "medium", "large"];

export const FONT_SCALE_PCT: Record<FontScale, string> = {
    small: "100%", // current / default
    medium: "150%",
    large: "200%"
};

export const FONT_SCALE_LABEL: Record<FontScale, string> = {
    small: "Small",
    medium: "Medium",
    large: "Large"
};

export function getFontScale(): FontScale {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return v === "medium" || v === "large" ? v : "small";
}

export function applyFontScale(scale: FontScale): void {
    document.documentElement.style.fontSize = FONT_SCALE_PCT[scale];
}

export function setFontScale(scale: FontScale): void {
    localStorage.setItem(KEY, scale);
    applyFontScale(scale);
}
