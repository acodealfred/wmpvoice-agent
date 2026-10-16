import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { formatCountdown, requestAnotherDownload, requestReportShare, type DownloadRequestStatus } from "@/lib/report-share";

// "Download PDF" on the participant's report: username → QR code → the phone
// downloads the PDF (ciq/reports/share_routes.py). Each report downloads ONCE; after
// that the dialog offers "Request another download", which an admin approves or
// denies (ciq/reports/download_request_routes.py). A QR link also dies when the
// countdown ends; a new code cancels the previous one.
//
// username → qr → expired (→ username again)
//          ↘ used (already downloaded: request / pending / declined)

type Step = "username" | "qr" | "expired" | "used";

const INPUT_CLASS =
    "ciq-touch rounded-xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] px-4 text-sm text-[color:var(--ciq-text-strong)] placeholder:text-[color:var(--ciq-text-faint)] focus:outline-none focus:ring-2 focus:ring-[color:var(--ciq-accent-blue)]/50";
const PRIMARY_CLASS = "ciq-btn-primary ciq-touch-lg rounded-xl text-sm transition-all disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_CLASS = "ciq-touch-lg rounded-xl text-sm text-[color:var(--ciq-text-muted)] transition-colors hover:opacity-80";

interface ReportQrDialogProps {
    surveyRunId: string;
    onClose: () => void;
}

export function ReportQrDialog({ surveyRunId, onClose }: ReportQrDialogProps) {
    const [step, setStep] = useState<Step>("username");
    const [username, setUsername] = useState("");
    const [requestStatus, setRequestStatus] = useState<DownloadRequestStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState("");
    const [secondsLeft, setSecondsLeft] = useState(0);

    useEffect(() => {
        if (step !== "qr") return;
        const timer = setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000);
        return () => clearInterval(timer);
    }, [step]);

    useEffect(() => {
        if (step === "qr" && secondsLeft <= 0) setStep("expired");
    }, [step, secondsLeft]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!username.trim() || busy) return;
        setBusy(true);
        setError(null);
        const result = await requestReportShare(surveyRunId, username);
        setBusy(false);
        if (!result.ok) {
            if (result.alreadyDownloaded) {
                setRequestStatus(result.requestStatus);
                setStep("used");
            } else {
                setError(result.error);
            }
            return;
        }
        setUrl(result.url);
        setSecondsLeft(result.expiresInSeconds);
        setStep("qr");
    };

    const askAdmin = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const result = await requestAnotherDownload(surveyRunId);
        setBusy(false);
        if (result.ok) setRequestStatus(result.status);
        else setError(result.error);
    };

    return (
        <div
            className="ciq-no-print fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-qr-title"
        >
            <div className="ciq-glass-card w-full max-w-sm p-6 shadow-xl">
                <h2 id="report-qr-title" className="mb-3 text-lg font-bold text-[color:var(--ciq-text-strong)]">
                    Download your report
                </h2>

                {step === "username" && (
                    <form onSubmit={submit} className="flex flex-col gap-4">
                        <p className="text-sm text-[color:var(--ciq-text-muted)]">
                            Enter your username to get a QR code. Scan it with your phone to download the PDF.
                        </p>
                        <input
                            type="text"
                            autoFocus
                            autoComplete="username"
                            autoCapitalize="none"
                            spellCheck={false}
                            placeholder="Username"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            disabled={busy}
                            className={INPUT_CLASS}
                        />
                        {error && <p className="rounded-lg bg-petroleum-flare/10 px-3 py-2 text-sm text-petroleum-flare">{error}</p>}
                        <div className="flex gap-2">
                            <button type="button" onClick={onClose} className={`${SECONDARY_CLASS} flex-1`}>
                                Cancel
                            </button>
                            <button type="submit" disabled={busy || !username.trim()} className={`${PRIMARY_CLASS} flex-1`}>
                                {busy ? "Checking…" : "Continue"}
                            </button>
                        </div>
                    </form>
                )}

                {step === "qr" && (
                    <div className="flex flex-col items-center gap-4">
                        <div className="rounded-xl bg-white p-3">
                            <QRCodeSVG value={url} size={208} marginSize={1} aria-label="QR code to download your report" />
                        </div>
                        <p className="text-center text-sm text-[color:var(--ciq-text-muted)]">
                            Scan with your phone camera, then tap <span className="font-semibold">Download report</span>. Only one download is available for
                            this report.
                        </p>
                        <p className="text-sm text-[color:var(--ciq-text-strong)]">
                            Expires in <span className="font-data font-semibold">{formatCountdown(secondsLeft)}</span>
                        </p>
                        <button type="button" onClick={onClose} className={`${SECONDARY_CLASS} w-full`}>
                            Close
                        </button>
                    </div>
                )}

                {step === "expired" && (
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-[color:var(--ciq-text-muted)]">This QR code has expired. Enter your username again to get a new one.</p>
                        <div className="flex gap-2">
                            <button type="button" onClick={onClose} className={`${SECONDARY_CLASS} flex-1`}>
                                Close
                            </button>
                            <button type="button" onClick={() => setStep("username")} className={`${PRIMARY_CLASS} flex-1`}>
                                Get a new code
                            </button>
                        </div>
                    </div>
                )}

                {step === "used" && (
                    <div className="flex flex-col gap-4">
                        <p className="text-sm font-semibold text-[color:var(--ciq-text-strong)]">Only one download is available for this report.</p>
                        <p className="text-sm text-[color:var(--ciq-text-muted)]">
                            {requestStatus === "pending"
                                ? "Your request for another download has been sent. An admin needs to approve it — try again once they have."
                                : requestStatus === "denied"
                                  ? "Your last request for another download was declined. You can ask again."
                                  : "It has already been downloaded. If you need it again, you can ask an admin for another download."}
                        </p>
                        {error && <p className="rounded-lg bg-petroleum-flare/10 px-3 py-2 text-sm text-petroleum-flare">{error}</p>}
                        <div className="flex gap-2">
                            <button type="button" onClick={onClose} className={`${SECONDARY_CLASS} flex-1`}>
                                Close
                            </button>
                            {requestStatus !== "pending" && (
                                <button type="button" onClick={() => void askAdmin()} disabled={busy} className={`${PRIMARY_CLASS} flex-1`}>
                                    {busy ? "Sending…" : requestStatus === "denied" ? "Request again" : "Request another download"}
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
