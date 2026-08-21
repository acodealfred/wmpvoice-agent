import { ListChecks, MessageCircle, Sparkles } from "lucide-react";
import { AnalysisResult } from "@/types";

interface ReadinessReportViewProps {
    analysisResult: AnalysisResult;
}

const cardClass = "rounded-2xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] p-4";

// Narrative content for a READINESS report's "Behavioral Analysis" tab (see
// build_readiness_analysis_prompt) — the deterministic score/domain-chart/data-table
// above this tab already match the other survey types; this is the qualitative
// deliverable specific to READINESS: a detailed summary plus topic-by-topic feedback
// grounded in what the user actually said, not correlations/contradictions/patterns.
export function ReadinessReportView({ analysisResult }: ReadinessReportViewProps) {
    return (
        <div className="space-y-4">
            {analysisResult.assessment_summary && (
                <div className={cardClass}>
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                        <Sparkles className="h-4 w-4" /> Assessment Summary
                    </div>
                    <p className="whitespace-pre-line text-sm leading-relaxed text-[color:var(--ciq-text-strong)]">{analysisResult.assessment_summary}</p>
                </div>
            )}

            {analysisResult.topic_feedback && analysisResult.topic_feedback.length > 0 && (
                <div className={cardClass}>
                    <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">Topic-by-Topic Feedback</div>
                    <div className="space-y-2">
                        {analysisResult.topic_feedback.map((tf, i) => (
                            <div key={i} className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-3">
                                <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">{tf.domain}</p>
                                <p className="mt-1 text-sm italic text-[color:var(--ciq-text-body)]">&ldquo;{tf.user_response_excerpt}&rdquo;</p>
                                <p className="mt-1.5 text-sm leading-relaxed text-[color:var(--ciq-text-strong)]">{tf.comment}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {analysisResult.user_experience_feedback && (
                <div className={cardClass}>
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                        <MessageCircle className="h-4 w-4" /> Overall Survey Experience
                    </div>
                    <p className="text-sm leading-relaxed text-[color:var(--ciq-text-strong)]">{analysisResult.user_experience_feedback}</p>
                </div>
            )}

            {analysisResult.actionable_recommendations && analysisResult.actionable_recommendations.length > 0 && (
                <div className={cardClass}>
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                        <ListChecks className="h-4 w-4" /> Actionable Recommendations
                    </div>
                    <ul className="space-y-2">
                        {analysisResult.actionable_recommendations.map((rec, i) => (
                            <li
                                key={i}
                                className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-3 text-sm leading-relaxed text-[color:var(--ciq-text-strong)]"
                            >
                                {rec}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
