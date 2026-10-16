// QR report download (POST /me/reports/{runId}/share — ciq/reports/share_routes.py):
// the participant confirms their username and gets a one-time link for their phone.
// Each report downloads once; after that they can ask an admin for one more
// (POST /me/reports/{runId}/download-request — ciq/reports/download_request_routes.py).

import { apiFetch } from "@/lib/api";

/** The latest "request another download" for a report, if any. */
export type DownloadRequestStatus = "pending" | "approved" | "denied";

export type ReportShareResult =
    | { ok: true; url: string; expiresInSeconds: number }
    | { ok: false; alreadyDownloaded: true; error: string; requestStatus: DownloadRequestStatus | null }
    | { ok: false; alreadyDownloaded?: false; error: string };

type Fetcher = (input: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

const OFFLINE = "Could not reach the server. Please try again.";

function errorText(data: { error?: unknown } | null, status: number): string {
    return typeof data?.error === "string" ? data.error : `Something went wrong (HTTP ${status}).`;
}

/**
 * Ask for a QR link. `origin` is where the phone will open it (this app's own
 * address); `timezoneOffset` is getTimezoneOffset() — minutes WEST of UTC — which the
 * server wants as minutes EAST, so the PDF shows the participant's local time.
 */
export async function requestReportShare(
    surveyRunId: string,
    username: string,
    origin: string = window.location.origin,
    timezoneOffset: number = new Date().getTimezoneOffset(),
    fetcher: Fetcher = apiFetch
): Promise<ReportShareResult> {
    try {
        const resp = await fetcher(`/me/reports/${encodeURIComponent(surveyRunId)}/share`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, tz_offset: -timezoneOffset || 0 })
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 404) return { ok: false, error: "This report hasn't been saved, so it can't be downloaded." };
        if (resp.status === 409 && data?.code === "already_downloaded") {
            return { ok: false, alreadyDownloaded: true, error: errorText(data, resp.status), requestStatus: data.request?.status ?? null };
        }
        if (!resp.ok) return { ok: false, error: errorText(data, resp.status) };
        return { ok: true, url: `${origin}${data.path}`, expiresInSeconds: data.expiresInSeconds };
    } catch {
        return { ok: false, error: OFFLINE };
    }
}

/** Ask an admin for one more download of an already-downloaded report. */
export async function requestAnotherDownload(
    surveyRunId: string,
    fetcher: Fetcher = apiFetch
): Promise<{ ok: true; status: DownloadRequestStatus } | { ok: false; error: string }> {
    try {
        const resp = await fetcher(`/me/reports/${encodeURIComponent(surveyRunId)}/download-request`, { method: "POST" });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) return { ok: false, error: errorText(data, resp.status) };
        return { ok: true, status: data.status };
    } catch {
        return { ok: false, error: OFFLINE };
    }
}

/** 300 → "5:00", 9 → "0:09". */
export function formatCountdown(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
