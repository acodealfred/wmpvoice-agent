import { useMemo } from "react";
import { Smile, Meh, Frown, Clock } from "lucide-react";
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
            <div className="rounded-lg bg-gray-800 p-4">
                <h3 className="mb-2 flex items-center text-sm font-medium text-gray-300">
                    <Clock className="mr-2 h-4 w-4" />
                    Sentiment History ({timeFrameLabel})
                </h3>
                <p className="text-center text-sm text-gray-500">No data yet</p>
            </div>
        );
    }

    return (
        <div className="rounded-lg bg-gray-800 p-4">
            <h3 className="mb-3 flex items-center text-sm font-medium text-gray-300">
                <Clock className="mr-2 h-4 w-4" />
                Sentiment History ({timeFrameLabel})
            </h3>
            <div className="max-h-64 space-y-2 overflow-y-auto">
                {history.map(item => (
                    <div key={item.id} className="flex items-center justify-between rounded bg-gray-700 p-2">
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">{item.timeFrameLabel}</span>
                        </div>
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-1">
                                <span className="text-lg">{getEmotionEmoji(item.faceEmotion)}</span>
                                <span className="text-xs text-gray-300">{item.faceEmotion || "N/A"}</span>
                            </div>
                            <div className="flex items-center gap-1">
                                {getSentimentIcon(item.voiceSentiment)}
                                <span className={`text-xs font-medium ${getSentimentColor(item.voiceSentiment)}`}>{item.voiceSentiment}</span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
