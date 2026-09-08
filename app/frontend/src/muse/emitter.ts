type Listener = (payload: never) => void;

export class TypedEmitter<E extends Record<string, unknown>> {
    private listeners = new Map<keyof E, Set<Listener>>();

    on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(fn as Listener);
        return () => {
            set.delete(fn as Listener);
        };
    }

    emit<K extends keyof E>(event: K, payload: E[K]): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const fn of [...set]) (fn as (p: E[K]) => void)(payload);
    }

    removeAll(): void {
        this.listeners.clear();
    }
}
