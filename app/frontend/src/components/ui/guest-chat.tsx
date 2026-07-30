import { MessageCircleHeart } from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import { useChatStream } from "@/hooks/useChatStream";
import "./guest-chat.css";

const GREETING =
    "Hi! I'm your CIQ Field Assistant. Ask me about your own readiness scores, how you're trending over the hitch, or ways to manage fatigue — everything here stays private to you.";

// Personal assistant for a returning guest. Grounded ONLY in the signed-in
// user's own data (see /me/chat + RBAC-gated personal tools).
export function GuestChat() {
    const { messages, input, setInput, busy, status, send, newChat, listRef } = useChatStream({
        chatEndpoint: "/me/chat",
        listEndpoint: "/me/chats",
        greeting: GREETING,
    });

    return (
        <div className="gc bg-[color:var(--ciq-card)]/70 flex flex-col overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <MessageCircleHeart className="h-4 w-4 text-[color:var(--ciq-accent-purple)]" />
                    <h2 className="font-display text-lg font-semibold text-[color:var(--ciq-text-strong)]">CIQ Field Assistant</h2>
                </div>
                <button className="gc-new" onClick={newChat} disabled={busy} title="Start a new chat">+ New chat</button>
            </div>

            <div className="gc-log" ref={listRef}>
                {messages.map((m, i) => (
                    <div key={i} className={`gc-msg gc-${m.role}`}>
                        <div className="gc-bubble">
                            {m.role === "assistant"
                                ? (m.text ? <Markdown>{m.text}</Markdown> : (busy ? "…" : ""))
                                : m.text}
                            {m.citations && m.citations.length > 0 && (
                                <div className="gc-cites">
                                    {m.citations.map((c, j) => (
                                        <span className="gc-cite" key={j} title={c.paperTitle || "Source"}>
                                            {(c.paperTitle || "Source")}{c.paperPage ? ` · p.${c.paperPage}` : ""}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
                {status && (
                    <div className="gc-status">
                        {status.replace(/[.…]+$/, "")}<span className="gc-dots" />
                    </div>
                )}
            </div>

            <div className="gc-input">
                <input
                    type="text"
                    value={input}
                    placeholder="Ask about tour readiness, fatigue, or shift guidelines…"
                    disabled={busy}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") send(); }}
                />
                <button onClick={send} aria-label="Send" disabled={!input.trim() || busy}>Send</button>
            </div>
        </div>
    );
}
