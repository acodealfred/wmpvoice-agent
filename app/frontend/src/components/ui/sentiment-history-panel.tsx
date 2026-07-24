import { useMemo } from "react";
import { Smile, Meh, Frown } from "lucide-react";
import { SentimentHistoryItem } from "../../types";

interface SentimentHistoryPanelProps {
    history: SentimentHistoryItem[];
    timeFrameSeconds: number;
}

const emotionIcons: Record<string, string> = {
    HAPPY: "😊",
    SAD: "😢",
    ANGRY: "😠",
    FEAR: "😨",
    DISGUSTED: "🤢",
    SURPRISED: "😲",
    CALM: "😌",
    CONFUSED: "😕"
};

function getSentimentIcon(sentiment: "positive" | "neutral" | "negative") {
    switch (sentiment) {
        case "positive":
            return <Smile className="h-4 w-4 text-petroleum-vapour" />;
        case "neutral":
            return <Meh className="h-4 w-4 text-petroleum-sodium" />;
        case "negative":
            return <Frown className="h-4 w-4 text-petroleum-flare" />;
    }
}

function getSentimentColor(sentiment: "positive" | "neutral" | "negative") {
    switch (sentiment) {
        case "positive":
            return "text-petroleum-vapour";
        case "neutral":
            return "text-petroleum-sodium";
        case "negative":
            return "text-petroleum-flare";
    }
}

function getEmotionEmoji(emotion: string) {
    return emotionIcons[emotion.toUpperCase()] || "😐";
}

export function SentimentHistoryPanel({ history, timeFrameSeconds }: SentimentHistoryPanelProps) {
    const timeFrameLabel = useMemo(() => `${timeFrameSeconds}s`, [timeFrameSeconds]);

    if (history.length === 0) {
        return (
            <div className="rounded bg-[color:var(--ciq-card-2)] px-2 py-1.5">
                <p className="text-center text-[10px] text-[color:var(--ciq-text-muted)]">No sentiment data</p>
            </div>
        );
    }

    const latestItem = history[history.length - 1];

    return (
        <div className="rounded bg-[color:var(--ciq-card-2)] px-2 py-1.5" title={`Sentiment ${timeFrameLabel}: ${latestItem.voiceSentiment}`}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-[color:var(--ciq-text-muted)]">{latestItem.timeFrameLabel}</span>
                    <span className="text-sm">{getEmotionEmoji(latestItem.faceEmotion)}</span>
                    <span className="max-w-[4rem] truncate text-[10px] uppercase text-[color:var(--ciq-text-faint)]">{latestItem.faceEmotion || "N/A"}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {getSentimentIcon(latestItem.voiceSentiment)}
                    <span className={`text-[10px] font-medium capitalize ${getSentimentColor(latestItem.voiceSentiment)}`}>{latestItem.voiceSentiment}</span>
                </div>
            </div>
        </div>
    );
}
