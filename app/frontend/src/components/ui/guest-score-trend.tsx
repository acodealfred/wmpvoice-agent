import { useMemo } from "react";
import { LineChart as LineChartIcon } from "lucide-react";
import {
    ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { SurveyRecord } from "@/types";

const RISK_COLOR: Record<string, string> = {
    Low: "#22c55e", Moderate: "#f59e0b", High: "#f43f5e",
};

function label(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("en", { month: "short", day: "numeric" });
}

/**
 * The signed-in guest's own burnout score over time — one point per assessment,
 * computed client-side from the /api/history records the landing already loads.
 * Personal data only; never org aggregates.
 */
export function GuestScoreTrend({ records }: { records: SurveyRecord[] }) {
    const points = useMemo(() => {
        return [...records]
            .filter(r => typeof r.technical_report?.totalScore === "number")
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
            .map(r => ({
                label: label(r.created_at),
                score: r.technical_report!.totalScore,
                risk: r.technical_report!.riskLevel,
            }));
    }, [records]);

    const latest = points[points.length - 1];

    return (
        <div className="bg-[color:var(--ciq-card)]/70 flex h-[460px] flex-col overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <LineChartIcon className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" />
                    <h2 className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">Your burnout score</h2>
                </div>
                <span className="rounded-full border border-[color:var(--ciq-divider)] bg-[color:var(--ciq-tile)] px-3 py-1 text-xs font-medium text-[color:var(--ciq-text-60)]">
                    Per assessment
                </span>
            </div>

            <div className="relative min-h-0 flex-1">
                {points.length < 2 ? (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-center text-sm text-[color:var(--ciq-text-60)]">
                            {points.length === 0
                                ? "No scored assessments yet."
                                : "One assessment so far — your trend line appears after your next check-in."}
                        </p>
                    </div>
                ) : (
                    <div className="absolute inset-0">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                            <CartesianGrid stroke="var(--ciq-divider)" vertical={false} />
                            <XAxis dataKey="label" tick={{ fill: "var(--ciq-text-60)", fontSize: 11 }}
                                axisLine={{ stroke: "var(--ciq-divider)" }} tickLine={false} />
                            <YAxis tick={{ fill: "var(--ciq-text-60)", fontSize: 11 }}
                                axisLine={false} tickLine={false} width={40} allowDecimals={false} />
                            <Tooltip
                                contentStyle={{
                                    background: "var(--ciq-card)", border: "1px solid var(--ciq-border)",
                                    borderRadius: 12, fontSize: 12,
                                }}
                                formatter={(v: number, _n, p) => [`${v} · ${p.payload.risk}`, "Score"]} />
                            <Line type="linear" dataKey="score" stroke="#a855f7" strokeWidth={2.5}
                                dot={(props) => {
                                    const { cx, cy, payload } = props;
                                    return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={3.5}
                                        fill={RISK_COLOR[payload.risk] ?? "#a855f7"} stroke="none" />;
                                }}
                                activeDot={{ r: 5 }} />
                        </LineChart>
                    </ResponsiveContainer>
                    </div>
                )}
            </div>

            {latest && (
                <p className="mt-3 text-xs text-[color:var(--ciq-text-40)]">
                    Latest: <b className="text-[color:var(--ciq-text-86)]">{latest.score}</b> ({latest.risk}). Lower is better —
                    a downward line means improving. Your data only.
                </p>
            )}
        </div>
    );
}
