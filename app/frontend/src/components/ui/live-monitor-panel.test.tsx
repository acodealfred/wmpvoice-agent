import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionCard } from "./live-monitor-panel";
import type { MonitorSession } from "@/lib/live-monitor";

const session = (over: Partial<MonitorSession> = {}): MonitorSession => ({
    sessionId: "s1",
    surveyRunId: "run-1",
    userId: "u1",
    userName: "Ann",
    surveyType: "PILOT",
    connection: "live",
    phase: "survey",
    phaseSeconds: 75,
    startedAt: 1000,
    answered: 7,
    total: 22,
    segmentIndex: 0,
    lastTickAgoS: 0.4,
    levels: { eeg: "ok", camera: "ok", mic: "ok", timeline: "ok" },
    overall: "ok",
    issues: [],
    eeg: null,
    ...over
});

const render = (s: MonitorSession) => renderToStaticMarkup(<SessionCard session={s} serverTime={1600} selected={false} onSelect={() => {}} />);

describe("SessionCard", () => {
    it("shows who, phase progress and elapsed time", () => {
        const html = render(session());
        expect(html).toContain("Ann");
        expect(html).toContain("Survey 7/22");
        expect(html).toContain("10:00 elapsed");
        expect(html).toContain("All data arriving normally.");
    });

    it("lists the current issues, three at most", () => {
        const html = render(session({ overall: "bad", levels: { eeg: "bad" }, issues: ["EEG headband disconnected", "a", "b", "c"] }));
        expect(html).toContain("EEG headband disconnected");
        expect(html).toContain("+1 more");
        expect(html).toContain("Problem");
    });

    it("labels a session that stopped reporting", () => {
        expect(render(session({ connection: "stale", overall: "bad" }))).toContain("Not reporting");
        expect(render(session({ connection: "offline", overall: "bad" }))).toContain("Disconnected");
    });

    it("never renders raw EEG values", () => {
        const html = render(
            session({ eeg: { status: "streaming", battery: 80, rate_hz: 256, samples: { TP9: 256 }, contact: { TP9: "good" }, recorder_packets: 10 } })
        );
        expect(html).not.toContain("µV");
    });
});
