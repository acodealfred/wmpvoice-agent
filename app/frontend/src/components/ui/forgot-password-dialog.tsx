import { useEffect, useState } from "react";

// Forgot-password flow from the login page. The user is not logged in, so the
// browser proves it owns the request with the secret `token` returned by
// /password-reset/request (plain fetch, not apiFetch — no session involved).
//
// confirm → username → waiting (admin decides) → approved (2-minute window) → done
//                                              ↘ denied / expired

type Step = "confirm" | "username" | "waiting" | "approved" | "done" | "denied" | "expired";

type ResetRequest = { request_id: string; token: string };

const POLL_MS = 3000;

const INPUT_CLASS =
    "ciq-touch rounded-xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] px-4 text-sm text-[color:var(--ciq-text-strong)] placeholder:text-[color:var(--ciq-text-faint)] focus:outline-none focus:ring-2 focus:ring-[color:var(--ciq-accent-blue)]/50";
const PRIMARY_CLASS = "ciq-btn-primary ciq-touch-lg rounded-xl text-sm transition-all disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_CLASS = "ciq-touch-lg rounded-xl text-sm text-[color:var(--ciq-text-muted)] transition-colors hover:opacity-80";

async function postJson(url: string, body: unknown) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
}

interface ForgotPasswordDialogProps {
    onClose: () => void;
}

export function ForgotPasswordDialog({ onClose }: ForgotPasswordDialogProps) {
    const [step, setStep] = useState<Step>("confirm");
    const [username, setUsername] = useState("");
    const [request, setRequest] = useState<ResetRequest | null>(null);
    const [secondsLeft, setSecondsLeft] = useState(0);
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    // While waiting for the admin, poll the request's status.
    useEffect(() => {
        if (step !== "waiting" || !request) return;
        let cancelled = false;
        const poll = async () => {
            try {
                const { res, data } = await postJson("/password-reset/status", request);
                if (cancelled) return;
                if (!res.ok) {
                    setStep("expired");
                } else if (data.status === "approved") {
                    setSecondsLeft(data.seconds_left ?? 0);
                    setStep("approved");
                } else if (data.status === "denied") {
                    setStep("denied");
                } else if (data.status !== "pending") {
                    setStep("expired");
                }
            } catch {
                // Network blip: keep polling.
            }
        };
        poll();
        const id = window.setInterval(poll, POLL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [step, request]);

    // Once approved, count down the window locally; the server enforces it too.
    useEffect(() => {
        if (step !== "approved") return;
        if (secondsLeft <= 0) {
            setStep("expired");
            return;
        }
        const id = window.setTimeout(() => setSecondsLeft(s => s - 1), 1000);
        return () => window.clearTimeout(id);
    }, [step, secondsLeft]);

    const submitUsername = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const { res, data } = await postJson("/password-reset/request", { username });
            if (!res.ok) {
                setError(data.error || "Could not send the request.");
                return;
            }
            setRequest({ request_id: data.request_id, token: data.token });
            setStep("waiting");
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    const submitPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        if (newPassword !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }
        setLoading(true);
        try {
            const { res, data } = await postJson("/password-reset/complete", {
                ...request,
                new_password: newPassword,
                confirm_password: confirmPassword
            });
            if (res.ok) {
                setStep("done");
            } else if (res.status === 409 || res.status === 404) {
                setStep("expired");
            } else {
                setError(data.error || "Could not update the password.");
            }
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    const restart = () => {
        setRequest(null);
        setNewPassword("");
        setConfirmPassword("");
        setError("");
        setStep("username");
    };

    const countdown = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="forgot-password-title"
        >
            <div className="ciq-glass-card w-full max-w-sm p-6 shadow-xl">
                <h2 id="forgot-password-title" className="mb-3 text-lg font-bold text-[color:var(--ciq-text-strong)]">
                    Reset password
                </h2>

                {step === "confirm" && (
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-[color:var(--ciq-text-muted)]">
                            Are you sure you want to reset your password? An admin will need to approve the request.
                        </p>
                        <div className="flex gap-2">
                            <button type="button" onClick={onClose} className={`${SECONDARY_CLASS} flex-1`}>
                                Cancel
                            </button>
                            <button type="button" onClick={() => setStep("username")} className={`${PRIMARY_CLASS} flex-1`}>
                                Yes, continue
                            </button>
                        </div>
                    </div>
                )}

                {step === "username" && (
                    <form onSubmit={submitUsername} className="flex flex-col gap-4">
                        <input
                            type="text"
                            placeholder="Username"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            required
                            autoFocus
                            autoComplete="username"
                            className={INPUT_CLASS}
                        />
                        {error && <p className="rounded-lg bg-petroleum-flare/10 px-3 py-2 text-sm text-petroleum-flare">{error}</p>}
                        <div className="flex gap-2">
                            <button type="button" onClick={onClose} className={`${SECONDARY_CLASS} flex-1`}>
                                Cancel
                            </button>
                            <button type="submit" disabled={loading} className={`${PRIMARY_CLASS} flex-1`}>
                                {loading ? "Sending…" : "Next"}
                            </button>
                        </div>
                    </form>
                )}

                {step === "waiting" && (
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-[color:var(--ciq-text-muted)]">Request sent. Waiting for an admin to approve it… Keep this window open.</p>
                        <button type="button" onClick={onClose} className={SECONDARY_CLASS}>
                            Cancel
                        </button>
                    </div>
                )}

                {step === "approved" && (
                    <form onSubmit={submitPassword} className="flex flex-col gap-4">
                        <p className="text-sm text-[color:var(--ciq-text-muted)]">
                            Approved. Set your new password within <span className="font-data font-semibold">{countdown}</span>.
                        </p>
                        <input
                            type="password"
                            placeholder="New password (min 8 characters)"
                            value={newPassword}
                            onChange={e => setNewPassword(e.target.value)}
                            required
                            minLength={8}
                            autoFocus
                            autoComplete="new-password"
                            className={INPUT_CLASS}
                        />
                        <input
                            type="password"
                            placeholder="Confirm new password"
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                            required
                            minLength={8}
                            autoComplete="new-password"
                            className={INPUT_CLASS}
                        />
                        {error && <p className="rounded-lg bg-petroleum-flare/10 px-3 py-2 text-sm text-petroleum-flare">{error}</p>}
                        <button type="submit" disabled={loading} className={PRIMARY_CLASS}>
                            {loading ? "Updating…" : "Update password"}
                        </button>
                    </form>
                )}

                {step === "done" && (
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-[color:var(--ciq-text-muted)]">Your password has been updated. Sign in with your new password.</p>
                        <button type="button" onClick={onClose} className={PRIMARY_CLASS}>
                            Back to sign in
                        </button>
                    </div>
                )}

                {(step === "denied" || step === "expired") && (
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-[color:var(--ciq-text-muted)]">
                            {step === "denied"
                                ? "An admin denied this request."
                                : "This request has expired. Send a new request and an admin will need to approve it again."}
                        </p>
                        <div className="flex gap-2">
                            <button type="button" onClick={onClose} className={`${SECONDARY_CLASS} flex-1`}>
                                Close
                            </button>
                            <button type="button" onClick={restart} className={`${PRIMARY_CLASS} flex-1`}>
                                New request
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
