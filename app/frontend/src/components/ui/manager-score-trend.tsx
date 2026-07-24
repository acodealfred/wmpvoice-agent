import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
} from "recharts";

// ── Mirrors the /manager/score-trend payload (see db.get_manager_score_trend) ──
interface TrendPoint {
    month: string;      // YYYY-MM
    avgScore: number;
    assessed: number;
}
interface TrendData {
    points: TrendPoint[];
    filterOptions: { department: string[]; shift: string[]; jobTitle: string[] };
}

type MonthsKey = "6" | "12" | "24" | "all";
const MONTHS_LABEL: Record<MonthsKey, string> = {
    "6": "Last 6 months",
    "12": "Last 12 months",
    "24": "Last 24 months",
    all: "All time",
};

interface Filters {
    department: string;
    shift: string;
    jobTitle: string;
    months: MonthsKey;
}
const EMPTY_FILTERS: Filters = { department: "", shift: "", jobTitle: "", months: "12" };

// "2026-07" → "Jul '26" for the x-axis.
function monthLabel(m: string): string {
    const [y, mo] = m.split("-");
    const d = new Date(Number(y), Number(mo) - 1, 1);
    return `${d.toLocaleString("en", { month: "short" })} '${y.slice(2)}`;
}

function Select({ label, value, onChange, options }: {
    label: string; value: string; onChange: (v: string) => void; options: { v: string; t: string }[];
}) {
    return (
        <label className="ml-an-field">
            <span>{label}</span>
            <select value={value} onChange={e => onChange(e.target.value)}>
                {options.map(o => <option key={o.v} value={o.v}>{o.t}</option>)}
            </select>
        </label>
    );
}

export function ManagerScoreTrend() {
    const [data, setData] = useState<TrendData | null>(null);
    const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const q = new URLSearchParams({ months: filters.months });
        if (filters.department) q.set("department", filters.department);
        if (filters.shift) q.set("shift", filters.shift);
        if (filters.jobTitle) q.set("jobTitle", filters.jobTitle);

        let alive = true;
        setLoading(true);
        apiFetch(`/manager/score-trend?${q.toString()}`, { credentials: "same-origin" })
            .then(r => r.json())
            .then((d: TrendData) => { if (alive) { setData(d); setLoading(false); } })
            .catch(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [filters]);

    const opts = data?.filterOptions ?? { department: [], shift: [], jobTitle: [] };
    const points = (data?.points ?? []).map(p => ({ ...p, label: monthLabel(p.month) }));
    const set = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));

    return (
        <div className="ml-card ml-pad ml-chart">
            <div className="ml-sec-h">
                <h2>Monthly Burnout Score</h2>
                <span className="ml-badge ml-b-cyan">Org average · trend</span>
            </div>

            {/* ── Filter toolbar ──────────────────────────────────────── */}
            <div className="ml-an-filters">
                <Select label="Department" value={filters.department}
                    onChange={v => set({ department: v })}
                    options={[{ v: "", t: "All" }, ...opts.department.map(d => ({ v: d, t: d }))]} />
                <Select label="Shift" value={filters.shift}
                    onChange={v => set({ shift: v })}
                    options={[{ v: "", t: "All" }, ...opts.shift.map(s => ({ v: s, t: s }))]} />
                <Select label="Job title" value={filters.jobTitle}
                    onChange={v => set({ jobTitle: v })}
                    options={[{ v: "", t: "All" }, ...opts.jobTitle.map(j => ({ v: j, t: j }))]} />
                <Select label="Period" value={filters.months}
                    onChange={v => set({ months: v as MonthsKey })}
                    options={(["6", "12", "24", "all"] as MonthsKey[]).map(m => ({ v: m, t: MONTHS_LABEL[m] }))} />
            </div>

            {/* ── Line chart ──────────────────────────────────────────── */}
            <div className="ml-chart-body">
                {loading && <p className="ml-an-note">Loading trend…</p>}
                {!loading && points.length === 0 && (
                    <p className="ml-an-empty">No scored assessments in this window.</p>
                )}
                {!loading && points.length > 0 && (
                    <div className="ml-chart-fill">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                            <CartesianGrid stroke="var(--line)" vertical={false} />
                            <XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 11 }}
                                axisLine={{ stroke: "var(--line2)" }} tickLine={false} />
                            <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }}
                                axisLine={false} tickLine={false} width={44} allowDecimals={false} />
                            <Tooltip
                                contentStyle={{
                                    background: "var(--panel)", border: "1px solid var(--glassBorder)",
                                    borderRadius: 10, color: "var(--bright)", fontSize: 12,
                                }}
                                labelStyle={{ color: "var(--muted)" }}
                                formatter={(v: number, _n, p) => [`${v}  ·  ${p.payload.assessed} assessed`, "Avg score"]} />
                            <Line type="linear" dataKey="avgScore" stroke="var(--cyan)" strokeWidth={2.5}
                                dot={{ r: 3, fill: "var(--cyan)", strokeWidth: 0 }}
                                activeDot={{ r: 5, fill: "var(--cyan)" }} />
                        </LineChart>
                    </ResponsiveContainer>
                    </div>
                )}
            </div>

            <p className="ml-an-foot">
                Mean of the deterministic BAT total score across all assessments in each month —
                aggregate and de-identified.
            </p>
        </div>
    );
}
