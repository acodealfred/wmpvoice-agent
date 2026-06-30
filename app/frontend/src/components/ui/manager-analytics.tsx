import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

// ── Types mirror the /manager/analytics payload (see db.get_manager_analytics) ──
interface Group {
    key: string;
    total: number;
    riskCounts: { Low: number; Moderate: number; High: number };
    atRiskPct: number;
}
interface AnalyticsData {
    groupBy: string;
    groups: Group[];
    riskTotals: { Low: number; Moderate: number; High: number };
    totalAssessed: number;
    atRiskPct: number;
    filterOptions: { department: string[]; shift: string[]; jobTitle: string[] };
}

type RangeKey = "30" | "90" | "365" | "all";

const RANGE_LABEL: Record<RangeKey, string> = {
    "30": "Last 30 days",
    "90": "Last 90 days",
    "365": "Last 12 months",
    all: "All time",
};
const RISK_COLOR = { Low: "var(--green)", Moderate: "var(--amber)", High: "var(--rose)" } as const;
const BANDS = ["Low", "Moderate", "High"] as const;

// `from` date (YYYY-MM-DD) for a range, or "" for all-time.
function rangeStart(range: RangeKey): string {
    if (range === "all") return "";
    const d = new Date();
    d.setDate(d.getDate() - parseInt(range, 10));
    return d.toISOString().slice(0, 10);
}

interface Filters {
    department: string;
    shift: string;
    jobTitle: string;
    range: RangeKey;
}
const EMPTY_FILTERS: Filters = { department: "", shift: "", jobTitle: "", range: "90" };

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

export function ManagerAnalytics() {
    const [data, setData] = useState<AnalyticsData | null>(null);
    const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
    const [loading, setLoading] = useState(true);

    // Rows are always grouped by department — the most intuitive lens for a
    // manager; the dropdowns slice within that view.
    useEffect(() => {
        const q = new URLSearchParams({ groupBy: "department" });
        if (filters.department) q.set("department", filters.department);
        if (filters.shift) q.set("shift", filters.shift);
        if (filters.jobTitle) q.set("jobTitle", filters.jobTitle);
        const from = rangeStart(filters.range);
        if (from) q.set("from", from);

        let alive = true;
        setLoading(true);
        apiFetch(`/manager/analytics?${q.toString()}`, { credentials: "same-origin" })
            .then(r => r.json())
            .then((d: AnalyticsData) => { if (alive) { setData(d); setLoading(false); } })
            .catch(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [filters]);

    const opts = data?.filterOptions ?? { department: [], shift: [], jobTitle: [] };
    const groups = data?.groups ?? [];

    const set = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));
    const isFiltered = filters.department || filters.shift || filters.jobTitle || filters.range !== "90";

    return (
        <div className="ml-card ml-pad ml-span12 ml-an">
            <div className="ml-sec-h">
                <h2>Assessment Analytics</h2>
                <span className="ml-badge ml-b-cyan">Interactive · filterable</span>
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
                <Select label="Period" value={filters.range}
                    onChange={v => set({ range: v as RangeKey })}
                    options={(["30", "90", "365", "all"] as RangeKey[]).map(r => ({ v: r, t: RANGE_LABEL[r] }))} />
                {isFiltered && (
                    <button className="ml-an-clear" onClick={() => setFilters(EMPTY_FILTERS)}>Reset filters</button>
                )}
            </div>

            {/* ── Lede + legend ───────────────────────────────────────── */}
            <div className="ml-an-lede">
                <p className="ml-an-headline">
                    <span className="ml-an-pct" style={{ color: (data?.atRiskPct ?? 0) > 0 ? "var(--rose)" : "var(--green)" }}>
                        {data?.atRiskPct ?? 0}%
                    </span>
                    <span className="ml-an-headline-txt">
                        at-risk across <b>{data?.totalAssessed ?? 0}</b> assessments
                        in <b>{groups.length}</b> {groups.length === 1 ? "department" : "departments"} — ranked by burnout concentration.
                    </span>
                </p>
                <div className="ml-an-legend">
                    {(["High", "Moderate", "Low"] as const).map(b => (
                        <span key={b}><i style={{ background: RISK_COLOR[b] }} />{b}</span>
                    ))}
                </div>
            </div>

            {loading && <p className="ml-an-note">Loading analytics…</p>}

            {!loading && groups.length === 0 && (
                <p className="ml-an-empty">No assessments match these filters.</p>
            )}

            {/* ── Full-width risk ledger (the hero) ───────────────────── */}
            {!loading && groups.length > 0 && (
                <ol className="ml-an-ledger">
                    {groups.map((g, i) => (
                        <li className="ml-an-row" key={g.key}>
                            <span className="ml-an-rank">{String(i + 1).padStart(2, "0")}</span>
                            <div className="ml-an-row-main">
                                <div className="ml-an-row-top">
                                    <span className="ml-an-dept">{g.key}</span>
                                    <span className="ml-an-rmeta">
                                        <b style={{ color: g.atRiskPct > 0 ? "var(--rose)" : "var(--green)" }}>{g.atRiskPct}%</b> at-risk
                                        <em>· {g.total} assessed</em>
                                    </span>
                                </div>
                                <div className="ml-an-ribbon" role="img"
                                    aria-label={`${g.key}: ${g.riskCounts.Low} low, ${g.riskCounts.Moderate} moderate, ${g.riskCounts.High} high`}>
                                    {BANDS.map(band => {
                                        const c = g.riskCounts[band];
                                        if (c <= 0) return null;
                                        return (
                                            <i key={band}
                                                className={`ml-an-seg ml-an-seg-${band.toLowerCase()}`}
                                                style={{ flexGrow: c, background: RISK_COLOR[band] }}
                                                title={`${band}: ${c} (${Math.round(c / g.total * 100)}%)`} />
                                        );
                                    })}
                                </div>
                            </div>
                        </li>
                    ))}
                </ol>
            )}

            <p className="ml-an-foot">
                Aggregate, de-identified signal — grouped counts only, never individual reports.
                Risk bands come from the deterministic BAT scoring pipeline.
            </p>
        </div>
    );
}
