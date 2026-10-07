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

/**
 * The filename the server chose (Content-Disposition) — per-run exports carry the
 * owner's user id and run id there (ciq.common.export_names) — else `fallback`.
 */
export function filenameFromResponse(resp: { headers: { get(name: string): string | null } }, fallback: string): string {
    const match = /filename="([^"]+)"/.exec(resp.headers.get("Content-Disposition") ?? "");
    return match?.[1] ?? fallback;
}

/** Hands the viewer a fetched file (CSV / XLSX / ZIP / JSON) to save. */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

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
