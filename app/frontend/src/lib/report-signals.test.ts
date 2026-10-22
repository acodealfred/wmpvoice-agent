import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignalChange, SignalComparison, SignalQuestion } from "@/types";
import { answerLine, describeSignal, fetchSignalComparison, numberWord, overviewHeadline, overviewPhrase, overviewRows, statusLine } from "./report-signals";

const change = (over: Partial<SignalChange>): SignalChange => ({
    id: "blink",
    direction: "higher",
    tier: "moved",
    reference: "past",
    today: 22,
    past: -3,
    delta: 25,
    unit: "pp",
    todaySupport: null,
    ...over
});

describe("describeSignal — spec section 7 wording, one previous check-in", () => {
    it.each<[Partial<SignalChange>, string]>([
        [{ id: "blink", direction: "higher" }, "Your blink rate was higher than in your last check-in."],
        [{ id: "blink", direction: "lower", tier: "strong" }, "Your blink rate was notably lower than in your last check-in."],
        [{ id: "latency", direction: "longer" }, "You took longer before answering than last time."],
        [{ id: "latency", direction: "longer", tier: "strong" }, "You took notably longer before answering than last time."],
        [{ id: "latency", direction: "shorter" }, "You answered more quickly than last time."],
        [{ id: "latency", direction: "shorter", tier: "strong" }, "You answered notably more quickly than last time."],
        [{ id: "pitch", direction: "higher" }, "Your voice was higher in pitch than last time."],
        [{ id: "pitch", direction: "lower", tier: "strong" }, "Your voice was notably lower in pitch than last time."],
        [{ id: "intensity", direction: "louder", reference: "today" }, "You spoke more loudly on this one than on your other answers today."],
        [
            { id: "intensity", direction: "quieter", tier: "strong", reference: "today" },
            "You spoke notably more quietly on this one than on your other answers today."
        ],
        [{ id: "sentiment", direction: "changed", today: "negative", past: "neutral" }, "The tone of your words read as more negative than last time."],
        [{ id: "sentiment", direction: "changed", today: "positive", past: "negative" }, "The tone of your words read as more positive than last time."],
        [{ id: "face", direction: "changed", today: "SURPRISED", past: "CALM" }, "Your expression read as calm last time and as surprised this time."],
        [{ id: "face", direction: "changed", today: "HAPPY", past: "NEUTRAL" }, "Your expression read as calm last time and as happy this time."]
    ])("%o", (over, sentence) => {
        expect(describeSignal(change(over), 1)).toBe(sentence);
    });
});

describe("describeSignal — references and today clause", () => {
    it("says 'your recent check-ins' with more than one previous check-in", () => {
        expect(describeSignal(change({ id: "blink" }), 3)).toBe("Your blink rate was higher than in your recent check-ins.");
        expect(describeSignal(change({ id: "latency", direction: "longer" }), 2)).toBe("You took longer before answering than in your recent check-ins.");
    });

    it("appends the today clause only when todaySupport is set", () => {
        expect(describeSignal(change({ todaySupport: "above_baseline" }), 1)).toBe(
            "Your blink rate was higher than in your last check-in, and above your calm reading at the start."
        );
        expect(describeSignal(change({ id: "latency", direction: "longer", todaySupport: "above_run_median" }), 1)).toBe(
            "You took longer before answering than last time, and longer than your other answers today."
        );
        expect(describeSignal(change({ id: "pitch", todaySupport: "above_run_median" }), 1)).toBe(
            "Your voice was higher in pitch than last time, and higher than your other answers today."
        );
        expect(describeSignal(change({ todaySupport: null }), 1)).not.toContain(", and");
    });

    it("never prints a number", () => {
        for (const id of ["blink", "latency", "pitch", "intensity"] as const) {
            expect(describeSignal(change({ id, today: 212.4, past: 196.1, delta: 1.37, tier: "strong" }), 3)).not.toMatch(/\d/);
        }
    });
});

const question = (answer: Partial<SignalQuestion["answer"]>): SignalQuestion => ({
    questionId: "bat_q1",
    label: "Emotional Exhaustion",
    prompt: "At work, I feel mentally exhausted.",
    answer: { previousLabel: "Rarely", currentLabel: "Often", previousValue: 2, currentValue: 4, changed: true, ...answer },
    status: "changed",
    surfacedBy: "strong",
    signals: []
});

describe("answerLine", () => {
    it("shows the change, or that it stayed the same", () => {
        expect(answerLine(question({}))).toBe("Rarely → Often");
        expect(answerLine(question({ previousLabel: "Often", previousValue: 4, changed: false }))).toBe("Often, same as last time");
    });

    it("has no 'same as last time' without an earlier answer, and nothing without a current one", () => {
        expect(answerLine(question({ previousLabel: null, previousValue: null, changed: false }))).toBe("Often");
        expect(answerLine(question({ currentLabel: null, currentValue: null, changed: false }))).toBeNull();
    });
});

describe("statusLine", () => {
    it("says nothing for a changed question", () => {
        expect(statusLine(question({}), 1)).toBeNull();
    });

    it("says 'no notable change', naming the reference", () => {
        const steady = { ...question({}), status: "steady" as const, surfacedBy: null };
        expect(statusLine(steady, 1)).toBe("No notable change in your signals compared with your last check-in.");
        expect(statusLine(steady, 3)).toBe("No notable change in your signals compared with your recent check-ins.");
    });

    it("says there weren't enough readings when nothing could be compared", () => {
        expect(statusLine({ ...question({}), status: "no_data", surfacedBy: null }, 2)).toBe("Not enough readings to compare this one.");
    });
});

describe("fetchSignalComparison", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("returns null on a non-OK response without throwing", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("nope", { status: 500 }))
        );
        await expect(fetchSignalComparison("run-1")).resolves.toBeNull();
    });

    it("returns null when the request itself fails", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("offline");
            })
        );
        await expect(fetchSignalComparison("run-1")).resolves.toBeNull();
    });
});

describe("numberWord", () => {
    it("writes small counts as words", () => {
        expect(numberWord(0)).toBe("zero");
        expect(numberWord(1)).toBe("one");
        expect(numberWord(7)).toBe("seven");
        expect(numberWord(21)).toBe("21");
    });
});

const sq = (
    status: SignalQuestion["status"],
    signals: Partial<SignalChange>[] = [],
    answer: Partial<SignalQuestion["answer"]> = { changed: false }
): SignalQuestion => ({
    ...question({ previousLabel: "Often", currentLabel: "Often", previousValue: 4, currentValue: 4, changed: false, ...answer }),
    status,
    surfacedBy: status === "changed" ? "corroborated" : null,
    signals: signals.map(over => change(over))
});

const comparisonOf = (...questions: SignalQuestion[]): SignalComparison => ({
    surveyRunId: "r",
    referenceRunIds: ["a"],
    referenceCount: 1,
    latestReferenceDate: null,
    daysSinceLatest: null,
    tier: "fixed",
    questions
});

const POSITIVE = { id: "sentiment" as const, direction: "changed" as const, today: "positive", past: "negative" };
const FORBIDDEN = /\b(lie|honest|mismatch|contradict\w*|verdict|pass|fail\w*|detect\w*|stress\w*|pupil|gaze|should|try|consider)\b/i;

describe("overviewHeadline", () => {
    it("says how many answers changed and on how many questions the signals moved", () => {
        const c = comparisonOf(
            sq("changed", [{ id: "blink", direction: "higher" }, POSITIVE], { changed: true, previousLabel: "Never", currentLabel: "Sometimes" }),
            sq("changed", [{ id: "blink", direction: "lower", tier: "strong" }], { changed: true }),
            sq("steady", [], { changed: true }),
            sq("steady"),
            sq("no_data", [], { changed: true })
        );
        expect(overviewHeadline(c)).toBe("Your answers changed on four of five questions. Your signals showed a notable change on two questions.");
    });

    it("covers no signal change, every answer the same, and nothing comparable", () => {
        expect(overviewHeadline(comparisonOf(sq("steady"), sq("steady")))).toBe(
            "Your answers were the same as last time on every question. Your signals showed no notable change on any question."
        );
        expect(overviewHeadline(comparisonOf(sq("changed", [{ id: "pitch", direction: "lower", tier: "strong" }])))).toBe(
            "Your answers were the same as last time on every question. Your signals showed a notable change on one question."
        );
        expect(overviewHeadline(comparisonOf(sq("no_data", [], { previousLabel: null, previousValue: null })))).toBe(
            "There weren't enough readings to compare your signals."
        );
    });
});

describe("overviewPhrase", () => {
    it.each<[Partial<SignalChange>, string]>([
        [{ id: "blink", direction: "higher" }, "Blink rate higher"],
        [{ id: "blink", direction: "lower" }, "Blink rate lower"],
        [{ id: "latency", direction: "longer" }, "Took longer to answer"],
        [{ id: "latency", direction: "shorter" }, "Answered more quickly"],
        [{ id: "pitch", direction: "higher" }, "Voice higher"],
        [{ id: "pitch", direction: "lower" }, "Voice lower"],
        [{ id: "intensity", direction: "louder" }, "Louder than your other answers"],
        [{ id: "intensity", direction: "quieter" }, "Quieter than your other answers"],
        [POSITIVE, "Tone more positive"],
        [{ id: "sentiment", direction: "changed", today: "negative", past: "neutral" }, "Tone more negative"],
        [{ id: "face", direction: "changed", today: "HAPPY", past: "CALM" }, "Expression changed"]
    ])("%o", (over, phrase) => {
        expect(overviewPhrase(change(over))).toBe(phrase);
    });
});

describe("overviewRows", () => {
    it("one row per question in order: short name, answer then → now, signals in brief", () => {
        const rows = overviewRows(
            comparisonOf(
                {
                    ...sq("changed", [{ id: "blink", direction: "higher" }, POSITIVE], { changed: true, previousLabel: "Never", currentLabel: "Sometimes" }),
                    shortLabel: "Mental exhaustion"
                },
                { ...sq("steady"), questionId: "q2", shortLabel: "Morning exhaustion" },
                { ...sq("no_data", [], { previousLabel: null, previousValue: null }), questionId: "q3", shortLabel: undefined, label: "Fallback label" }
            )
        );
        expect(rows).toEqual([
            { questionId: "bat_q1", label: "Mental exhaustion", answer: "Never → Sometimes", signals: "Blink rate higher · Tone more positive" },
            { questionId: "q2", label: "Morning exhaustion", answer: "Often (same)", signals: "No notable change" },
            { questionId: "q3", label: "Fallback label", answer: "Often", signals: "Not enough readings" }
        ]);
    });

    it("has no digits and no forbidden words", () => {
        const c = comparisonOf(
            sq(
                "changed",
                [
                    { id: "blink", direction: "higher" },
                    { id: "latency", direction: "shorter", tier: "strong" },
                    { id: "intensity", direction: "quieter" }
                ],
                { changed: true }
            ),
            sq("changed", [
                { id: "face", direction: "changed", today: "SAD", past: "CALM" },
                { id: "pitch", direction: "lower" }
            ]),
            sq("steady"),
            sq("no_data")
        );
        const text = [overviewHeadline(c), ...overviewRows(c).flatMap(r => [r.label, r.answer, r.signals])].join(" ");
        expect(text).not.toMatch(/\d/);
        expect(text).not.toMatch(FORBIDDEN);
    });
});
