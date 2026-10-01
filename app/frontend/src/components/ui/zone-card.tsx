import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ZONE_EMPTY_TEXT } from "@/lib/zone";
import type { ZoneTrendResponse } from "@/types";
import { ZoneScale } from "./zone-scale";
import { ZoneTrendChart } from "./zone-trend";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: ZoneTrendResponse };

/** Home-screen card: the signed-in employee's own Fatigue ↔ Burnout zone and trend. */
export function ZoneCard() {
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        apiFetch("/api/zone-trend")
            .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data: ZoneTrendResponse) => alive && setState({ kind: "ready", data }))
            .catch(() => alive && setState({ kind: "error" }));
        return () => {
            alive = false;
        };
    }, []);

    return (
        <div className="bg-[color:var(--ciq-card)]/70 rounded-2xl border border-[color:var(--ciq-border)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl">
            <div className="mb-4 flex items-center gap-2">
                <Gauge className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" />
                <h2 className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">Fatigue ↔ Burnout</h2>
            </div>

            {state.kind === "loading" && <p className="text-sm text-[color:var(--ciq-text-60)]">Loading your zone…</p>}
            {state.kind === "error" && <p className="text-sm text-[color:var(--ciq-text-60)]">Zone unavailable right now.</p>}
            {state.kind === "ready" && !state.data.latest && (
                <p className="text-sm text-[color:var(--ciq-text-60)]">{ZONE_EMPTY_TEXT}</p>
            )}
            {state.kind === "ready" && state.data.latest && (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
                    <div className="lg:col-span-2">
                        <ZoneScale zone={state.data.latest} trend={state.data.trend} />
                    </div>
                    <div className="h-[220px] lg:col-span-3">
                        <ZoneTrendChart points={state.data.trend.points} />
                    </div>
                </div>
            )}
        </div>
    );
}
