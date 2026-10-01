import { describe, expect, it } from "vitest";

import { LEFT_EYE_LANDMARKS, RIGHT_EYE_LANDMARKS } from "./eye-landmarks";

// MediaPipe face-mesh index sets (face_mesh_connections: FACEMESH_LEFT_EYE /
// FACEMESH_RIGHT_EYE contours, FACEMESH_LEFT_IRIS / FACEMESH_RIGHT_IRIS + centre).
const LEFT_EYE = new Set([263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398]);
const RIGHT_EYE = new Set([33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173]);
const LEFT_IRIS = new Set([473, 474, 475, 476, 477]);
const RIGHT_IRIS = new Set([468, 469, 470, 471, 472]);

describe("eye landmark sets", () => {
    it("pairs the left iris only with the left eye's own lids and corners", () => {
        const { iris, ...rest } = LEFT_EYE_LANDMARKS;
        expect(LEFT_IRIS.has(iris)).toBe(true);
        for (const idx of Object.values(rest)) expect(LEFT_EYE.has(idx), `left ${idx}`).toBe(true);
    });

    it("pairs the right iris only with the right eye's own lids and corners", () => {
        const { iris, ...rest } = RIGHT_EYE_LANDMARKS;
        expect(RIGHT_IRIS.has(iris)).toBe(true);
        for (const idx of Object.values(rest)) expect(RIGHT_EYE.has(idx), `right ${idx}`).toBe(true);
    });

    it("uses distinct upper and lower lid points on each eye", () => {
        expect(LEFT_EYE_LANDMARKS.upperLid).not.toBe(LEFT_EYE_LANDMARKS.lowerLid);
        expect(RIGHT_EYE_LANDMARKS.upperLid).not.toBe(RIGHT_EYE_LANDMARKS.lowerLid);
    });
});
