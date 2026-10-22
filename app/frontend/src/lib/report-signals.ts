// "Your signals, compared with your past check-ins" (GET /me/reports/{runId}/signal-comparison —
// ciq/reports/signal_comparison.py). Descriptive only: each sentence states what was recorded
// against the person's own history and stops — no numbers, no meaning, no judgement of the answer.

import { apiFetch } from "@/lib/api";
import type { SignalChange, SignalComparison, SignalQuestion } from "@/types";

/** The comparison, or null (not PILOT / first check-in / nothing moved / request failed). Never throws. */
export async function fetchSignalComparison(surveyRunId: string): Promise<SignalComparison | null> {
    try {
        const res = await apiFetch(`/me/reports/${encodeURIComponent(surveyRunId)}/signal-comparison`);
        if (!res.ok) return null;
        return ((await res.json()) as { signalComparison: SignalComparison | null }).signalComparison;
    } catch {
        return null;
    }
}

const SENTIMENT_ORDER = ["negative", "neutral", "positive"];

/** Rekognition label in plain words; NEUTRAL and CALM both read as "calm". */
function faceWord(label: SignalChange["today"]): string {
    const word = String(label ?? "").toLowerCase();
    return word === "neutral" ? "calm" : word;
}

const TODAY_CLAUSE: Partial<Record<SignalChange["id"], Partial<Record<NonNullable<SignalChange["todaySupport"]>, string>>>> = {
    blink: { above_baseline: "above your calm reading at the start", below_baseline: "below your calm reading at the start" },
    latency: { above_run_median: "longer than your other answers today", below_run_median: "quicker than your other answers today" },
    pitch: { above_run_median: "higher than your other answers today", below_run_median: "lower than your other answers today" }
};

/** The sentence for one signal, in the wording of the design spec (section 7). */
export function describeSignal(change: SignalChange, referenceCount: number): string {
    const notably = change.tier === "strong" ? "notably " : "";
    const recent = referenceCount > 1;
    const inLast = recent ? "in your recent check-ins" : "in your last check-in";
    const lastTime = recent ? "in your recent check-ins" : "last time";

    let sentence: string;
    switch (change.id) {
        case "blink":
            sentence = `Your blink rate was ${notably}${change.direction === "lower" ? "lower" : "higher"} than ${inLast}`;
            break;
        case "latency":
            sentence =
                change.direction === "shorter"
                    ? `You answered ${notably}more quickly than ${lastTime}`
                    : `You took ${notably}longer before answering than ${lastTime}`;
            break;
        case "pitch":
            sentence = `Your voice was ${notably}${change.direction === "lower" ? "lower" : "higher"} in pitch than ${lastTime}`;
            break;
        case "intensity":
            sentence = `You spoke ${notably}${change.direction === "quieter" ? "more quietly" : "more loudly"} on this one than on your other answers today`;
            break;
        case "sentiment": {
            const more = SENTIMENT_ORDER.indexOf(String(change.today)) < SENTIMENT_ORDER.indexOf(String(change.past)) ? "more negative" : "more positive";
            sentence = `The tone of your words read as ${more} than last time`;
            break;
        }
        case "face":
            sentence = `Your expression read as ${faceWord(change.past)} last time and as ${faceWord(change.today)} this time`;
            break;
    }
    const clause = change.todaySupport ? TODAY_CLAUSE[change.id]?.[change.todaySupport] : undefined;
    return `${sentence}${clause ? `, and ${clause}` : ""}.`;
}

/** "Rarely → Often" / "Often, same as last time" / just "Often" with no earlier answer; null with no answer. */
export function answerLine(q: SignalQuestion): string | null {
    const { previousLabel, currentLabel, changed } = q.answer;
    if (!currentLabel) return null;
    if (changed && previousLabel) return `${previousLabel} → ${currentLabel}`;
    if (previousLabel) return `${currentLabel}, same as last time`;
    return currentLabel;
}

/** The one line for a question with nothing notable to list; null for a "changed" question. */
export function statusLine(q: SignalQuestion, referenceCount: number): string | null {
    if (q.status === "steady") {
        return `No notable change in your signals compared with ${referenceCount > 1 ? "your recent check-ins" : "your last check-in"}.`;
    }
    if (q.status === "no_data") return "Not enough readings to compare this one.";
    return null;
}

const NUMBER_WORDS = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty"
];

/** A count as a word ("seven"), so the card shows no digits; digits only past twenty (never for PILOT). */
export function numberWord(n: number): string {
    return NUMBER_WORDS[n] ?? String(n);
}

const plural = (n: number, noun: string) => `${numberWord(n)} ${n === 1 ? noun : `${noun}s`}`;

/** One headline for the "at a glance" card: how many answers changed, and on how many
 *  questions the person's own signals showed a notable change. Counts are words. */
export function overviewHeadline(comparison: SignalComparison): string {
    const qs = comparison.questions;
    const parts: string[] = [];

    const withEarlier = qs.filter(q => q.answer.previousLabel);
    const answersChanged = withEarlier.filter(q => q.answer.changed).length;
    if (answersChanged > 0) parts.push(`Your answers changed on ${numberWord(answersChanged)} of ${plural(qs.length, "question")}.`);
    else if (withEarlier.length === qs.length) parts.push("Your answers were the same as last time on every question.");
    else if (withEarlier.length > 0) parts.push("Your answers were the same as last time.");

    const signalsChanged = qs.filter(q => q.status === "changed").length;
    if (qs.every(q => q.status === "no_data")) parts.push("There weren't enough readings to compare your signals.");
    else if (signalsChanged > 0) parts.push(`Your signals showed a notable change on ${plural(signalsChanged, "question")}.`);
    else parts.push("Your signals showed no notable change on any question.");

    return parts.join(" ");
}

/** The short phrase for one signal in the at-a-glance table — no numbers, no meaning. */
export function overviewPhrase(s: SignalChange): string {
    switch (s.id) {
        case "blink":
            return `Blink rate ${s.direction === "lower" ? "lower" : "higher"}`;
        case "latency":
            return s.direction === "shorter" ? "Answered more quickly" : "Took longer to answer";
        case "pitch":
            return `Voice ${s.direction === "lower" ? "lower" : "higher"}`;
        case "intensity":
            return `${s.direction === "quieter" ? "Quieter" : "Louder"} than your other answers`;
        case "sentiment":
            return `Tone more ${SENTIMENT_ORDER.indexOf(String(s.today)) < SENTIMENT_ORDER.indexOf(String(s.past)) ? "negative" : "positive"}`;
        case "face":
            return "Expression changed";
    }
}

export type OverviewRow = { questionId: string; label: string; answer: string; signals: string };

/** One row per question, in survey order: short name, answer then → now, signals in brief. */
export function overviewRows(comparison: SignalComparison): OverviewRow[] {
    return comparison.questions.map(q => {
        const { previousLabel, currentLabel, changed } = q.answer;
        const answer = !currentLabel
            ? "—"
            : changed && previousLabel
              ? `${previousLabel} → ${currentLabel}`
              : previousLabel
                ? `${currentLabel} (same)`
                : currentLabel;
        const signals =
            q.status === "changed" ? q.signals.map(overviewPhrase).join(" · ") : q.status === "steady" ? "No notable change" : "Not enough readings";
        return { questionId: q.questionId, label: q.shortLabel || q.label, answer, signals };
    });
}
