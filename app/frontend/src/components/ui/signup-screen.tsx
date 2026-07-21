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
                        className="rounded-xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] px-4 py-3 text-sm text-[color:var(--ciq-text-strong)] placeholder:text-[color:var(--ciq-text-faint)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        autoComplete="new-password"
                        className="rounded-xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-tile-strong)] px-4 py-3 text-sm text-[color:var(--ciq-text-strong)] placeholder:text-[color:var(--ciq-text-faint)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    />
                    {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>}
                    {success && (
                        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
                            Account created! Redirecting to sign in…
                        </p>
                    )}
                    <button
                        type="submit"
                        disabled={loading || success}
                        className="mt-2 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:from-purple-500 hover:to-pink-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {loading ? "Creating account…" : "Sign Up"}
                    </button>
                </form>
                <p className="mt-5 text-center text-sm text-[color:var(--ciq-text-muted)]">
                    Already have an account?{" "}
                    <button
                        type="button"
                        onClick={onSwitchToLogin}
                        className="font-semibold text-purple-400 transition-colors hover:text-purple-300"
                    >
                        Log in
                    </button>
                </p>
            </div>
        </div>
    );
}
