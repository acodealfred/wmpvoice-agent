interface GazeIndicatorProps {
    gaze: { x: number; y: number };
}

// SVG viewBox: 40x20. Eye oval spans x=[4,36] y=[2,18] (center 20,10, rx=16, ry=8)
const EYE_X_MIN = 4;
const EYE_X_MAX = 36;
const EYE_Y_MIN = 2;
const EYE_Y_MAX = 18;

export function GazeIndicator({ gaze }: GazeIndicatorProps) {
    const cx = EYE_X_MIN + gaze.x * (EYE_X_MAX - EYE_X_MIN);
    const cy = EYE_Y_MIN + gaze.y * (EYE_Y_MAX - EYE_Y_MIN);

    return (
        <svg viewBox="0 0 40 20" width="40" height="20" className="my-0.5">
            {/* Eye outline */}
            <ellipse cx="20" cy="10" rx="16" ry="8" fill="none" stroke="rgba(255,250,242,0.3)" strokeWidth="1" />
            {/* Iris ring */}
            <circle cx={cx} cy={cy} r="4.5" fill="none" stroke="rgba(94,229,161,0.5)" strokeWidth="1" />
            {/* Pupil dot */}
            <circle cx={cx} cy={cy} r="2" fill="#5ee5a1" />
        </svg>
    );
}

export function gazeLabel(g: { x: number; y: number }): string {
    const h = g.x < 0.4 ? "Left" : g.x > 0.6 ? "Right" : "Center";
    const v = g.y < 0.35 ? "Up" : g.y > 0.65 ? "Down" : "";
    return [v, h].filter(Boolean).join("-") || "Center";
}
