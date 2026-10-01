// Hover descriptions for the report's charts (detailed-report.tsx): what each
// domain on the Domain Profile measures, and what each risk gauge's score means.
//
// Keyed by the exact `domain` / scoringSections `label` strings in
// app/backend/surveys/*.json — a name missing here simply shows no description.
// Wording follows the published instrument definitions (BAT: Schaufeli, De Witte &
// Desart 2019; CBI: Kristensen et al. 2005); research-team edits belong here.

export const DOMAIN_DESCRIPTIONS: Record<string, string> = {
    // BAT-4 (PILOT) + the TEST survey
    "Emotional Exhaustion": "Feeling drained — a severe loss of physical and mental energy because of work.",
    "Mental Distance": "Pulling away from work: little enthusiasm, cynicism or indifference towards it.",
    "Cognitive Impairment": "Trouble with memory, attention and concentration while working.",
    "Emotional Impairment": "Intense emotional reactions at work, such as frustration, irritation or feeling overwhelmed.",
    // TEST survey
    Depersonalization: "Feeling detached or distant from work and the people it involves.",
    "Personal Accomplishment": "Feeling effective and confident in your work. Reverse-scored: a higher answer means less burnout.",
    "Physical Exhaustion": "Physical tiredness and lack of energy linked to work.",
    "Job Satisfaction": "How positive you feel about your job. Reverse-scored: a higher answer means less burnout.",
    // READINESS
    Workload: "How manageable your current workload feels.",
    "Energy & Recovery": "How well your energy holds up and recovers between work days.",
    "Support & Connection": "How supported and connected you feel at work.",
    "Confidence & Growth": "How confident you feel in your role and in growing within it.",
    "Overall Readiness": "Your overall sense of being ready for the demands ahead."
};

// CBI Work-Related Burnout items appear as one radar point per item ("… (Item 7)").
const CBI_WRB = "Work-related burnout (CBI): physical and psychological fatigue you attribute to your work.";
const CBI_ITEMS: Record<string, string> = {
    "7": "This item: “Is your work emotionally exhausting?”",
    "11": "This item: “Are you exhausted in the morning at the thought of another day at work?”",
    "13": "This item: “Do you have enough energy for family and friends during leisure time?” Reverse-scored: a higher answer here means more energy, i.e. less burnout."
};

export function describeDomain(domain: string): string | undefined {
    if (DOMAIN_DESCRIPTIONS[domain]) return DOMAIN_DESCRIPTIONS[domain];
    const cbi = /^Work-Related Burnout \(Item (\d+)\)$/.exec(domain);
    if (cbi) return [CBI_WRB, CBI_ITEMS[cbi[1]]].filter(Boolean).join(" ");
    return undefined;
}

export const SECTION_DESCRIPTIONS: Record<string, string> = {
    "BAT-4":
        "Burnout Assessment Tool, short form: 4 statements covering exhaustion, mental distance, and cognitive and emotional impairment. The score is your average answer on the 1 (Never) – 5 (Always) scale; higher means more burnout.",
    "CBI-WRB3":
        "Copenhagen Burnout Inventory, work-related burnout: 3 questions about work-related fatigue. The score is your average answer on the 0 – 100 scale, after reverse-scoring; higher means more burnout."
};

/** Description for a risk gauge: a named subscale, or the single overall score. */
export function describeGauge(label: string, isReadiness: boolean): string {
    if (SECTION_DESCRIPTIONS[label]) return SECTION_DESCRIPTIONS[label];
    return isReadiness
        ? "Your overall readiness across the conversation topics, rated from what you shared."
        : "The total of all your answers, after reverse-scoring the positively worded questions; higher means more burnout risk.";
}

/** Same bands as the report's domain colours (≤20% low, ≤60% moderate, else high). */
export function answerLevel(pctOfMax: number): "Low" | "Moderate" | "High" {
    return pctOfMax <= 20 ? "Low" : pctOfMax <= 60 ? "Moderate" : "High";
}
