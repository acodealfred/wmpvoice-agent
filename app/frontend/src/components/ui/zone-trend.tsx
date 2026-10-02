import { useEffect, useMemo, useState } from "react";
import { Gauge } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { ZoneTrendPoint, ZoneTrendResponse } from "@/types";
import { ZONE_BANDS, ZONE_EMPTY_TEXT, ZONE_UNAVAILABLE_TEXT, fetchZoneTrend, formatZoneDate, zoneColor, zoneLabel } from "@/lib/zone";
import { ZoneScale } from "./zone-scale";

/** Severity over time with the four zones shaded. Lower is better. */
export function ZoneTrendChart({ points }: { points: ZoneTrendPoint[] }) {
    const data = useMemo(() => points.map(p => ({ ...p, label: formatZoneDate(p.date) })), [points]);

    if (data.length < 2) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-center text-sm text-[color:var(--ciq-text-60)]">Your trend line appears after your next check-in.</p>
            </div>
        );
    }

    return (
        <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                {ZONE_BANDS.map(b => (
                    <ReferenceArea key={b.zone} y1={b.from} y2={b.to} fill={zoneColor(b.zone)} fillOpacity={0.08} stroke="none" ifOverflow="hidden" />
                ))}
                <CartesianGrid stroke="var(--ciq-divider)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "var(--ciq-text-60)", fontSize: 11 }} axisLine={{ stroke: "var(--ciq-divider)" }} tickLine={false} />
                <YAxis
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tick={{ fill: "var(--ciq-text-60)", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={40}
                />
                <Tooltip
                    contentStyle={{ background: "var(--ciq-card)", border: "1px solid var(--ciq-border)", borderRadius: 12, fontSize: 12 }}
                    formatter={(v: number, _n, p) => [`${v} · ${zoneLabel(p.payload.zone)}`, "Strain"]}
                />
                <Line
                    type="linear"
                    dataKey="severity"
                    stroke="var(--ciq-accent-blue)"
                    strokeWidth={2.5}
                    isAnimationActive={false}
                    dot={props => {
                        const { cx, cy, payload } = props;
                        return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={3.5} fill={zoneColor(payload.zone)} stroke="none" />;
                    }}
                    activeDot={{ r: 5 }}
                />
            </LineChart>
        </ResponsiveContainer>
    );
}

/** Home-screen card: the latest zone on the Fatigue ↔ Burnout line plus the severity trend. */
export function ZoneHomeCard() {
    const [data, setData] = useState<ZoneTrendResponse | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        fetchZoneTrend()
            .then(d => alive && setData(d))
            .catch(() => alive && setFailed(true));
        return () => {
            alive = false;
        };
    }, []);

    const message = failed ? ZONE_UNAVAILABLE_TEXT : data && !data.latest ? ZONE_EMPTY_TEXT : null;

    return (
        <div className="bg-[color:var(--ciq-card)]/70 overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl">
            <div className="mb-4 flex items-center gap-2">
                <Gauge className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" />
                <h2 className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">Fatigue ↔ Burnout Zone</h2>
            </div>

            {!data && !failed && <p className="text-sm text-[color:var(--ciq-text-60)]">Loading your zone…</p>}
            {message && <p className="text-sm text-[color:var(--ciq-text-60)]">{message}</p>}

            {data?.latest && (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
                    <div className="lg:col-span-2">
                        <ZoneScale latest={data.latest} trend={data.trend} />
                    </div>
                    <div className="flex flex-col lg:col-span-3">
                        <div className="relative h-56 min-h-0">
                            <div className="absolute inset-0">
                                <ZoneTrendChart points={data.trend.points} />
                            </div>
                        </div>
                        <p className="mt-2 text-xs text-[color:var(--ciq-text-40)]">Strain per check-in. Lower is better. Your data only.</p>
                    </div>
                </div>
            )}
        </div>
    );
}
