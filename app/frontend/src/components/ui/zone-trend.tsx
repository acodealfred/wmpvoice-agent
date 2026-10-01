import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea } from "recharts";
import { ZONE_BANDS, ZONE_LABEL } from "@/lib/zone";
import type { ZonePoint } from "@/types";

const BAND_FILL: Record<string, string> = {
    well: "var(--ciq-accent-green)", mild: "var(--ciq-accent-blue)",
    moderate: "var(--ciq-accent-amber)", high: "var(--ciq-accent-red)",
};

function label(date: string): string {
    return new Date(`${date}T00:00:00`).toLocaleString("en", { month: "short", day: "numeric" });
}

/** Strain over time, one point per complete PILOT check-in, zone bands shaded. Lower is better. */
export function ZoneTrendChart({ points }: { points: ZonePoint[] }) {
    if (points.length < 2) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-center text-sm text-[color:var(--ciq-text-60)]">
                    Your trend line appears after your next check-in.
                </p>
            </div>
        );
    }
    const data = points.map(p => ({ ...p, label: label(p.date) }));
    return (
        <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                {ZONE_BANDS.map(b => (
                    <ReferenceArea key={b.zone} y1={b.from} y2={b.to} fill={BAND_FILL[b.zone]} fillOpacity={0.07} stroke="none" />
                ))}
                <CartesianGrid stroke="var(--ciq-divider)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "var(--ciq-text-60)", fontSize: 11 }}
                    axisLine={{ stroke: "var(--ciq-divider)" }} tickLine={false} />
                <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: "var(--ciq-text-60)", fontSize: 11 }}
                    axisLine={false} tickLine={false} width={40} />
                <Tooltip
                    contentStyle={{ background: "var(--ciq-card)", border: "1px solid var(--ciq-border)", borderRadius: 12, fontSize: 12 }}
                    formatter={(v: number, _n, p) => [`${v} · ${ZONE_LABEL[p.payload.zone as ZonePoint["zone"]]}`, "Strain"]} />
                <Line type="linear" dataKey="severity" stroke="var(--ciq-accent-blue)" strokeWidth={2.5} dot={{ r: 3.5 }} activeDot={{ r: 5 }} />
            </LineChart>
        </ResponsiveContainer>
    );
}
