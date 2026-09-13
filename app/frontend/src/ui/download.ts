export function sessionFilename(when: Date, deviceName: string): string {
    const stamp = when
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z")
        .replace(/:/g, "-");
    const safe = deviceName.replace(/[^A-Za-z0-9_-]+/g, "_");
    return `muse-session-${stamp}-${safe}.json`;
}

interface Env {
    doc: { createElement(tag: "a"): { href: string; download: string; click(): void } };
    url: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void };
    blob: (parts: string[], type: string) => Blob;
}

const browserEnv = (): Env => ({
    doc: document,
    url: URL,
    blob: (parts, type) => new Blob(parts, { type })
});

/** Hands the viewer a JSON file to save. `env` is injectable for tests. */
export function downloadJson(data: unknown, filename: string, env: Env = browserEnv()): void {
    const blob = env.blob([JSON.stringify(data)], "application/json");
    const href = env.url.createObjectURL(blob);
    const a = env.doc.createElement("a");
    a.href = href;
    a.download = filename;
    a.click();
    env.url.revokeObjectURL(href);
}
