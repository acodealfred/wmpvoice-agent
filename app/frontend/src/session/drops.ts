// Counts missing packets per stream from the headband's 16-bit sequence numbers.

export class DropCounter {
    private last = new Map<string, number>();
    private drops = new Map<string, number>();

    /** Make a stream appear in dropped() with 0 before any packet arrives. */
    register(key: string): void {
        if (!this.drops.has(key)) this.drops.set(key, 0);
    }

    /** Record a packet; returns how many packets were missed just before it. */
    observe(key: string, seq: number): number {
        const prev = this.last.get(key);
        this.last.set(key, seq);
        if (prev === undefined) {
            this.register(key);
            return 0;
        }
        const gap = (seq - prev - 1) & 0xffff;
        // A duplicate or late packet shows up as a huge "gap"; treat it as none.
        if (gap > 0x8000) return 0;
        this.drops.set(key, (this.drops.get(key) ?? 0) + gap);
        return gap;
    }

    dropped(): Record<string, number> {
        return Object.fromEntries(this.drops);
    }
}
