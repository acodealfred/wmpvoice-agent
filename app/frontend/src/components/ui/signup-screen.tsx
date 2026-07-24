import { useState } from "react";
import logo from "@/assets/logo.png";

interface SignupScreenProps {
    onSignupSuccess: () => void;
    onSwitchToLogin: () => void;
}

export function SignupScreen({ onSignupSuccess, onSwitchToLogin }: SignupScreenProps) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState(false);
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const res = await fetch("/api/signup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || "Signup failed");
                return;
            }
            setSuccess(true);
            setTimeout(onSignupSuccess, 1200);
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="ciq-page flex min-h-screen flex-col items-center justify-center">
            <div className="ciq-glass-card w-full max-w-sm p-8 shadow-xl">
                <div className="mb-6 flex flex-col items-center gap-3">
                    <img src={logo} alt="CIQ logo" className="ciq-logo h-14 w-14 rounded-xl" />
                    <h1 className="text-xl font-bold text-[color:var(--ciq-text-strong)]">CIQ Voice Agent</h1>
                    <p className="text-sm text-[color:var(--ciq-text-muted)]">Create your account</p>
                </div>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <input
                        type="text"
                        placeholder="Username"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        required
                        autoComplete="username"
                        className="ciq-touch rounded-xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] px-4 text-sm text-[color:var(--ciq-text-strong)] placeholder:text-[color:var(--ciq-text-faint)] focus:outline-none focus:ring-2 focus:ring-[color:var(--ciq-accent-blue)]/50"
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        autoComplete="new-password"
                        className="ciq-touch rounded-xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] px-4 text-sm text-[color:var(--ciq-text-strong)] placeholder:text-[color:var(--ciq-text-faint)] focus:outline-none focus:ring-2 focus:ring-[color:var(--ciq-accent-blue)]/50"
                    />
                    {error && <p className="rounded-lg bg-petroleum-flare/10 px-3 py-2 text-sm text-petroleum-flare">{error}</p>}
                    {success && (
                        <p className="rounded-lg bg-[color:var(--ciq-accent-green)]/10 px-3 py-2 text-sm text-[color:var(--ciq-accent-green)]">
                            Account created! Redirecting to sign in…
                        </p>
                    )}
                    <button
                        type="submit"
                        disabled={loading || success}
                        className="ciq-btn-primary ciq-touch-lg mt-2 rounded-xl text-sm transition-all disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {loading ? "Creating account…" : "Sign Up"}
                    </button>
                </form>
                <p className="mt-5 text-center text-sm text-[color:var(--ciq-text-muted)]">
                    Already have an account?{" "}
                    <button
                        type="button"
                        onClick={onSwitchToLogin}
                        className="font-semibold text-[color:var(--ciq-accent-blue)] transition-colors hover:opacity-80"
                    >
                        Log in
                    </button>
                </p>
            </div>
        </div>
    );
}
