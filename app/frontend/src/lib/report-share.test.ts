import { describe, expect, it } from "vitest";

import { formatCountdown, requestAnotherDownload, requestReportShare } from "./report-share";

const respond = (status: number, body: unknown) => async (_input: string, _init: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
});

describe("requestReportShare", () => {
    it("posts the username and local timezone, and builds the phone URL from the origin", async () => {
        const calls: { input: string; init: RequestInit }[] = [];
        const fetcher = async (input: string, init: RequestInit) => {
            calls.push({ input, init });
            return respond(200, { path: "/report-share/abc", expiresInSeconds: 300 })(input, init);
        };
        // Sri Lanka: getTimezoneOffset() is -330 (west), the server wants +330 (east).
        const result = await requestReportShare("run 1", "emp1", "https://ciq.example", -330, fetcher);

        expect(result).toEqual({ ok: true, url: "https://ciq.example/report-share/abc", expiresInSeconds: 300 });
        expect(calls[0].input).toBe("/me/reports/run%201/share");
        expect(JSON.parse(calls[0].init.body as string)).toEqual({ username: "emp1", tz_offset: 330 });
    });

    it("shows the server's message for a wrong username or lockout", async () => {
        const mismatch = "Username doesn't match this report.";
        expect(await requestReportShare("r", "x", "o", 0, respond(403, { error: mismatch }))).toEqual({ ok: false, error: mismatch });
        expect(await requestReportShare("r", "x", "o", 0, respond(429, { error: "Too many wrong usernames." }))).toEqual({
            ok: false,
            error: "Too many wrong usernames."
        });
    });

    it("reports an already-downloaded report with its request status", async () => {
        const used = { error: "Only one download is available.", code: "already_downloaded" };
        expect(await requestReportShare("r", "x", "o", 0, respond(409, { ...used, request: null }))).toEqual({
            ok: false,
            alreadyDownloaded: true,
            error: "Only one download is available.",
            requestStatus: null
        });
        const pending = await requestReportShare("r", "x", "o", 0, respond(409, { ...used, request: { status: "pending" } }));
        expect(pending.ok === false && pending.alreadyDownloaded && pending.requestStatus).toBe("pending");
    });

    it("explains an unsaved report and a network failure", async () => {
        const notFound = await requestReportShare("r", "x", "o", 0, respond(404, { error: "Report not found." }));
        expect(notFound.ok).toBe(false);
        expect(!notFound.ok && notFound.error).toContain("hasn't been saved");

        const offline = await requestReportShare("r", "x", "o", 0, async () => {
            throw new Error("offline");
        });
        expect(offline).toEqual({ ok: false, error: "Could not reach the server. Please try again." });
    });
});

describe("requestAnotherDownload", () => {
    it("posts to the run's download-request route and returns its status", async () => {
        const calls: string[] = [];
        const fetcher = async (input: string, init: RequestInit) => {
            calls.push(`${init.method} ${input}`);
            return respond(200, { status: "pending" })(input, init);
        };
        expect(await requestAnotherDownload("run 1", fetcher)).toEqual({ ok: true, status: "pending" });
        expect(calls).toEqual(["POST /me/reports/run%201/download-request"]);
    });

    it("passes on the server's error", async () => {
        expect(await requestAnotherDownload("r", respond(409, { error: "No request needed." }))).toEqual({ ok: false, error: "No request needed." });
    });
});

describe("formatCountdown", () => {
    it("formats minutes and padded seconds", () => {
        expect(formatCountdown(300)).toBe("5:00");
        expect(formatCountdown(65)).toBe("1:05");
        expect(formatCountdown(9)).toBe("0:09");
        expect(formatCountdown(-3)).toBe("0:00");
    });
});
