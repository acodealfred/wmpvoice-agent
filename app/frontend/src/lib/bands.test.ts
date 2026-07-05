import { describe, it, expect } from "vitest";
import { blinkBandLevel, pupilBandLevel } from "./bands";

// Boundary table — MUST match app/backend/tests/unit/test_survey_loader.py
describe("blinkBandLevel (mirrors BE survey_loader.blink_band)", () => {
    it.each([
        [null, "Unknown"],
        [0, "Normal"], [15, "Normal"], [-15, "Normal"],
        [15.1, "Elevated"], [40, "Elevated"], [-40, "Elevated"],
        [40.1, "High"], [-41, "High"],
    ] as const)("%s → %s", (input, expected) => {
        expect(blinkBandLevel(input)).toBe(expected);
    });
});

describe("pupilBandLevel (mirrors BE survey_loader.pupil_band)", () => {
    it.each([
        [null, "Unknown"],
        [-0.5, "Low"], [0.1, "Low"],
        [0.11, "Medium"], [0.3, "Medium"],
        [0.31, "High"], [1.0, "High"],
    ] as const)("%s → %s", (input, expected) => {
        expect(pupilBandLevel(input)).toBe(expected);
    });
});
