import { useState } from "react";
import { BiometricSnapshot, AnalysisResult } from "@/types";
import { Loader2, AlertCircle } from "lucide-react";

interface DetailedReportProps {
    snapshots: BiometricSnapshot[];
    totalScore: number;
    onClose?: () => void;
    onAgentSpeaking?: (text: string) => void;
}

export function DetailedReport({ snapshots, totalScore, onClose, onAgentSpeaking }: DetailedReportProps) {
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [analysisError, setAnalysisError] = useState<string | null>(null);
    const [agentResponse, setAgentResponse] = useState<string | null>(null);

    const getStressLevel = (blinkRateChange: number): string => {
        if (blinkRateChange > 30) return "High";
        if (blinkRateChange < -30) return "Low";
        return "Normal";
    };

    const getSentimentColor = (sentiment: string): string => {
        switch (sentiment) {
            case "positive":
                return "text-green-600";
            case "negative":
                return "text-red-600";
            default:
                return "text-yellow-600";
        }
    };

    const getStressColor = (blinkRateChange: number): string => {
        if (blinkRateChange > 30) return "text-red-600";
        if (blinkRateChange < -30) return "text-green-600";
        return "text-gray-600";
    };

    const getConfidenceBadge = (confidence: string) => {
        switch (confidence) {
            case "high":
                return <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">High</span>;
            case "medium":
                return <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">Medium</span>;
            case "low":
                return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Low</span>;
            default:
                return null;
        }
    };

    const handleAnalyzeReport = async () => {
        setIsAnalyzing(true);
        setAnalysisError(null);
        setAnalysisResult(null);

        try {
            const response = await fetch("/analyze-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ snapshots })
            });

            if (!response.ok) {
                throw new Error(`Analysis failed: ${response.statusText}`);
            }

            const data = await response.json();

            if (data.analysis) {
                try {
                    const parsed = JSON.parse(data.analysis);
                    setAnalysisResult(parsed);
                } catch {
                    setAnalysisResult({
                        correlations: [],
                        contradictions: [],
                        patterns: [],
                        summary: data.analysis
                    });
                }
            } else if (data.error) {
                setAnalysisError(data.error);
            }

            // If there's an agent response, display it and notify parent
            if (data.agentResponse) {
                setAgentResponse(data.agentResponse);
                onAgentSpeaking?.(data.agentResponse);
            }
        } catch (err) {
            setAnalysisError(err instanceof Error ? err.message : "Unknown error occurred");
        } finally {
            setIsAnalyzing(false);
        }
    };

    return (
        <div className="w-full max-w-4xl rounded-lg bg-white p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-gray-800">Detailed Burnout Assessment Report</h2>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleAnalyzeReport}
                        disabled={isAnalyzing || snapshots.length === 0}
                        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
                    >
                        {isAnalyzing ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Analyzing...
                            </>
                        ) : (
                            "Analyze Report"
                        )}
                    </button>
                    {onClose && (
                        <button onClick={onClose} className="rounded-full p-2 hover:bg-gray-100" aria-label="Close report">
                            ✕
                        </button>
                    )}
                </div>
            </div>

            {analysisError && (
                <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-50 p-3 text-red-700">
                    <AlertCircle className="h-5 w-5" />
                    <span>{analysisError}</span>
                </div>
            )}

            {agentResponse && (
                <div className="mb-4 rounded-lg bg-green-50 p-4">
                    <h3 className="mb-2 text-lg font-semibold text-green-800">Consultant Response</h3>
                    <p className="whitespace-pre-line text-sm text-gray-700">{agentResponse}</p>
                </div>
            )}

            {analysisResult && (
                <div className="mb-6 rounded-lg bg-blue-50 p-4">
                    <h3 className="mb-3 text-lg font-semibold text-blue-800">Behavioral Analysis</h3>

                    {analysisResult.summary && (
                        <div className="mb-4 rounded-lg bg-white p-3">
                            <p className="text-sm text-gray-700">{analysisResult.summary}</p>
                        </div>
                    )}

                    {analysisResult.correlations && analysisResult.correlations.length > 0 && (
                        <div className="mb-3">
                            <h4 className="mb-2 text-sm font-medium text-blue-700">Correlations</h4>
                            <div className="space-y-2">
                                {analysisResult.correlations.map((item, idx) => (
                                    <div key={idx} className="rounded border border-blue-200 bg-white p-2">
                                        <div className="flex items-start justify-between">
                                            <p className="text-sm text-gray-700">{item.insight}</p>
                                            {getConfidenceBadge(item.confidence)}
                                        </div>
                                        <p className="mt-1 text-xs text-gray-500">Rule: {item.rule}</p>
                                        <p className="text-xs text-gray-500">Data: {item.dataPoint}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {analysisResult.contradictions && analysisResult.contradictions.length > 0 && (
                        <div className="mb-3">
                            <h4 className="mb-2 text-sm font-medium text-orange-700">Contradictions</h4>
                            <div className="space-y-2">
                                {analysisResult.contradictions.map((item, idx) => (
                                    <div key={idx} className="rounded border border-orange-200 bg-white p-2">
                                        <div className="flex items-start justify-between">
                                            <p className="text-sm text-gray-700">{item.insight}</p>
                                            {getConfidenceBadge(item.confidence)}
                                        </div>
                                        <p className="mt-1 text-xs text-gray-500">Rule: {item.rule}</p>
                                        <p className="text-xs text-gray-500">Data: {item.dataPoint}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {analysisResult.patterns && analysisResult.patterns.length > 0 && (
                        <div>
                            <h4 className="mb-2 text-sm font-medium text-purple-700">Patterns</h4>
                            <div className="space-y-2">
                                {analysisResult.patterns.map((item, idx) => (
                                    <div key={idx} className="rounded border border-purple-200 bg-white p-2">
                                        <div className="flex items-start justify-between">
                                            <p className="text-sm text-gray-700">{item.insight}</p>
                                            {getConfidenceBadge(item.confidence)}
                                        </div>
                                        <p className="mt-1 text-xs text-gray-500">Rule: {item.rule}</p>
                                        <p className="text-xs text-gray-500">Data: {item.dataPoint}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            <div className="mb-6 rounded-lg bg-purple-50 p-4">
                <div className="text-center">
                    <span className="text-lg font-medium text-gray-700">Total Burnout Score</span>
                    <div className="mt-2 text-4xl font-bold text-purple-600">{totalScore} / 25</div>
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
