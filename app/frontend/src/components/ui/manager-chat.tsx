import { Markdown } from "@/components/ui/markdown";
import { useChatStream } from "@/hooks/useChatStream";

const GREETING =
    "Hi! I'm the CIQ Field Assistant. Ask me about the crew's hitch readiness trends — by department, shift, job title or over time — and I'll ground answers in the dashboard data and the research knowledge base.";

// Optional filter context sent with each turn so answers respect the manager's
// current lens. Parent can pass this in later; defaults to none.
export function ManagerChat({ filters }: { filters?: Record<string, string> }) {
    const { messages, input, setInput, busy, status, send, newChat, listRef } = useChatStream({
        chatEndpoint: "/manager/chat",
        listEndpoint: "/manager/chats",
        greeting: GREETING,
        filters,
    });

    return (
        <div className="ml-card ml-pad ml-chat">
            <div className="ml-sec-h">
                <h2>CIQ Field Assistant</h2>
                <div className="ml-chat-head-right">
                    <button className="ml-chat-new" onClick={newChat} disabled={busy} title="Start a new chat">+ New chat</button>
                    <span className="ml-badge ml-b-cyan">Grounded · beta</span>
                </div>
            </div>

            <div className="ml-chat-log" ref={listRef}>
                {messages.map((m, i) => (
                    <div key={i} className={`ml-chat-msg ml-chat-${m.role}`}>
                        <div className="ml-chat-bubble">
                            {m.role === "assistant"
                                ? (m.text ? <Markdown>{m.text}</Markdown> : (busy ? "…" : ""))
                                : m.text}
                            {m.citations && m.citations.length > 0 && (
                                <div className="ml-chat-cites">
                                    {m.citations.map((c, j) => (
                                        <span className="ml-chat-cite" key={j}
                                            title={c.paperTitle || "Source"}>
                                            {(c.paperTitle || "Source")}{c.paperPage ? ` · p.${c.paperPage}` : ""}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
                {status && (
                    <div className="ml-chat-status">
                        {status.replace(/[.…]+$/, "")}<span className="ml-dots" />
                    </div>
                )}
            </div>

            <div className="ml-chat-input">
                <input
                    type="text"
                    value={input}
                    placeholder="Ask about hitch readiness, fatigue, or shift trends…"
                    disabled={busy}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") send(); }}
                />
                <button onClick={send} aria-label="Send" disabled={!input.trim() || busy}>Send</button>
            </div>
        </div>
    );
}
