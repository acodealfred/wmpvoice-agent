import { BiometricSnapshot } from "@/types";

interface DetailedReportProps {
    snapshots: BiometricSnapshot[];
    totalScore: number;
    onClose?: () => void;
}

export function DetailedReport({ snapshots, totalScore, onClose }: DetailedReportProps) {
    const getStressLevel = (blinkRateChange: number): string => {
        if (blinkRateChange > 30) return "High";
        if (blinkRateChange < -30) return "Low";
        return "Normal";
    };

    const getSentimentColor = (sentiment: string): string => {
        switch (sentiment) {
            case "positive": return "text-green-600";
            case "negative": return "text-red-600";
            default: return "text-yellow-600";
        }
    };

    const getStressColor = (blinkRateChange: number): string => {
        if (blinkRateChange > 30) return "text-red-600";
        if (blinkRateChange < -30) return "text-green-600";
        return "text-gray-600";
    };

    return (
        <div className="w-full max-w-4xl rounded-lg bg-white p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-800">Detailed Burnout Assessment Report</h2>
                {onClose && (
                    <button
                        onClick={onClose}
                        className="rounded-full p-2 hover:bg-gray-100"
                        aria-label="Close report"
                    >
                        ✕
                    </button>
                )}
            </div>

            <div className="mb-6 rounded-lg bg-purple-50 p-4">
                <div className="text-center">
                    <span className="text-lg font-medium text-gray-700">Total Burnout Score</span>
                    <div className="mt-2 text-4xl font-bold text-purple-600">
                        {totalScore} / 25
                    </div>
                    <div className="mt-2 text-sm">
                        {totalScore <= 12 && <span className="text-green-600">Low burnout risk</span>}
                        {totalScore > 12 && totalScore <= 22 && <span className="text-yellow-600">Moderate burnout risk</span>}
                        {totalScore > 22 && <span className="text-red-600">High burnout risk</span>}
                    </div>
                </div>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr className="bg-gray-100">
                            <th className="border border-gray-200 px-3 py-2 text-left font-semibold">Question ID</th>
                            <th className="border border-gray-200 px-3 py-2 text-left font-semibold">Domain</th>
                            <th className="border border-gray-200 px-3 py-2 text-center font-semibold">Score</th>
                            <th className="border border-gray-200 px-3 py-2 text-center font-semibold">Voice Sentiment</th>
                            <th className="border border-gray-200 px-3 py-2 text-center font-semibold">Blink Rate Change</th>
                            <th className="border border-gray-200 px-3 py-2 text-center font-semibold">BR Stress Level</th>
                            <th className="border border-gray-200 px-3 py-2 text-center font-semibold">Face Emotion</th>
                        </tr>
                    </thead>
                    <tbody>
                        {snapshots.map((snapshot, index) => (
                            <tr key={snapshot.questionId} className={index % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                <td className="border border-gray-200 px-3 py-2">{snapshot.questionId}</td>
                                <td className="border border-gray-200 px-3 py-2">{snapshot.domain}</td>
                                <td className="border border-gray-200 px-3 py-2 text-center">{snapshot.score}/5</td>
                                <td className={`border border-gray-200 px-3 py-2 text-center capitalize ${getSentimentColor(snapshot.voiceSentiment)}`}>
                                    {snapshot.voiceSentiment}
                                </td>
                                <td className="border border-gray-200 px-3 py-2 text-center">
                                    <span className={snapshot.blinkRateChange >= 0 ? "text-green-600" : "text-red-600"}>
                                        {snapshot.blinkRateChange >= 0 ? "+" : ""}
                                        {snapshot.blinkRateChange.toFixed(1)}%
                                    </span>
                                </td>
                                <td className={`border border-gray-200 px-3 py-2 text-center ${getStressColor(snapshot.blinkRateChange)}`}>
                                    {getStressLevel(snapshot.blinkRateChange)}
                                </td>
                                <td className="border border-gray-200 px-3 py-2 text-center">{snapshot.faceEmotion}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="mt-4 text-xs text-gray-500">
                <p>Note: This is a demonstration only. Results should be validated by a healthcare professional.</p>
            </div>
        </div>
    );
}