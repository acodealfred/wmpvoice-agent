import { useState } from "react";
import { AuthUser } from "@/types";
import logo from "@/assets/logo.png";

interface LoginScreenProps {
    onLogin: (user: AuthUser) => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const res = await fetch("/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || "Login failed");
                return;
            }
            onLogin({
                user_id: data.user.user_id,
                name: data.user.name,
                session_id: data.session_id,
            });
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-[#f6f1e9]">
            <div
                className="w-full max-w-sm rounded-2xl border border-white/[0.16] p-8 shadow-xl backdrop-blur-[34px]"
                style={{ background: "rgba(18,25,23,0.72)" }}
            >
                <div className="mb-6 flex flex-col items-center gap-3">
                    <img src={logo} alt="CIQ logo" className="h-14 w-14 rounded-xl" />
                    <h1 className="text-xl font-bold text-[#fffaf2]">CIQ Voice Agent</h1>
                    <p className="text-sm text-[rgba(255,250,242,0.60)]">Sign in to continue</p>
                </div>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <input
                        type="text"
                        placeholder="Username"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        required
                        autoComplete="username"
                        className="rounded-xl border border-white/[0.16] bg-white/[0.08] px-4 py-3 text-sm text-[#fffaf2] placeholder:text-[rgba(255,250,242,0.40)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        autoComplete="current-password"
                        className="rounded-xl border border-white/[0.16] bg-white/[0.08] px-4 py-3 text-sm text-[#fffaf2] placeholder:text-[rgba(255,250,242,0.40)] focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    />
                    {error && (
                        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
                    )}
                    <button
                        type="submit"
                        disabled={loading}
                        className="mt-2 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/20 transition-all hover:from-purple-500 hover:to-pink-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {loading ? "Signing in…" : "Sign In"}
                    </button>
                </form>
            </div>
        </div>
    );
}
