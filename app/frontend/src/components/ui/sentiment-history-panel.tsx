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
            return <Smile className="h-4 w-4 text-green-500" />;
        case "neutral":
            return <Meh className="h-4 w-4 text-yellow-500" />;
        case "negative":
            return <Frown className="h-4 w-4 text-red-500" />;
    }
}

function getSentimentColor(sentiment: "positive" | "neutral" | "negative") {
    switch (sentiment) {
        case "positive":
            return "text-green-600";
        case "neutral":
            return "text-yellow-600";
        case "negative":
            return "text-red-600";
    }
}

function getEmotionEmoji(emotion: string) {
    return emotionIcons[emotion.toUpperCase()] || "😐";
}

export function SentimentHistoryPanel({ history, timeFrameSeconds }: SentimentHistoryPanelProps) {
    const timeFrameLabel = useMemo(() => `${timeFrameSeconds}s`, [timeFrameSeconds]);

    if (history.length === 0) {
        return (
            <div className="rounded bg-gray-800 px-2 py-1.5">
                <p className="text-center text-[10px] text-gray-500">No sentiment data</p>
            </div>
        );
    }

    const latestItem = history[history.length - 1];

    return (
        <div className="rounded bg-gray-800 px-2 py-1.5" title={`Sentiment ${timeFrameLabel}: ${latestItem.voiceSentiment}`}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-gray-500">{latestItem.timeFrameLabel}</span>
                    <span className="text-sm">{getEmotionEmoji(latestItem.faceEmotion)}</span>
                    <span className="text-[10px] text-gray-300 uppercase truncate max-w-[4rem]">{latestItem.faceEmotion || "N/A"}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {getSentimentIcon(latestItem.voiceSentiment)}
                    <span className={`text-[10px] font-medium capitalize ${getSentimentColor(latestItem.voiceSentiment)}`}>
                        {latestItem.voiceSentiment}
                    </span>
                </div>
            </div>
        </div>
    );
}
