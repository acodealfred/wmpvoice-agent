import { useRef, useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Markdown } from "@/components/ui/markdown";

interface Citation {
    paperId?: string;
    paperTitle?: string;
    paperPage?: number;
}
interface Msg {
    role: "user" | "assistant";
    text: string;
    citations?: Citation[];
}

const GREETING: Msg = {
    role: "assistant",
    text: "Hi! I'm the Wellbeing Assistant. Ask me about the organisation's burnout trends — by department, shift, job title or over time — and I'll ground answers in the dashboard data and the research knowledge base.",
};

// Optional filter context sent with each turn so answers respect the manager's
// current lens. Parent can pass this in later; defaults to none.
export function ManagerChat({ filters }: { filters?: Record<string, string> }) {
    const [messages, setMessages] = useState<Msg[]>([]);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const chatIdRef = useRef<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const greetingTimer = useRef<number | null>(null);

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [messages, status]);

    const cancelGreeting = () => {
        if (greetingTimer.current) { clearInterval(greetingTimer.current); greetingTimer.current = null; }
    };

    // Type the greeting out letter-by-letter, always finishing well under 2s
    // (types several chars per frame for longer text so the total stays bounded).
    const typeGreeting = () => {
        cancelGreeting();
        const full = GREETING.text;
        const DURATION = 1400, TICK = 16;                       // ms
        const perTick = Math.max(1, Math.ceil(full.length / (DURATION / TICK)));
        let i = 0;
        setMessages([{ role: "assistant", text: "" }]);
        greetingTimer.current = window.setInterval(() => {
            i = Math.min(full.length, i + perTick);
            setMessages([{ role: "assistant", text: full.slice(0, i) }]);
            if (i >= full.length) cancelGreeting();
        }, TICK);
    };

    // On mount: restore the latest persisted chat (survives logout/login,
    // refresh, tab nav), or type the greeting when there's no history.
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await apiFetch("/manager/chats", { credentials: "same-origin" });
                if (res.ok) {
                    const { chats } = await res.json();
                    if (alive && chats?.length) {
                        const latest = chats[0].chat_id;
                        const r2 = await apiFetch(`/manager/chats/${latest}`, { credentials: "same-origin" });
                        if (r2.ok && alive) {
                            const data = await r2.json();
                            const restored: Msg[] = (data.messages ?? []).map((m: { role: Msg["role"]; content: string; citations?: Citation[] }) => ({
                                role: m.role, text: m.content, citations: m.citations,
                            }));
                            if (alive && restored.length) {
                                chatIdRef.current = latest;
                                setMessages(restored);
                                return;
                            }
                        }
                    }
                }
            } catch {
                /* non-fatal — fall through to the greeting */
            }
            if (alive) typeGreeting();
        })();
        return () => { alive = false; cancelGreeting(); };
    }, []);

    // Mutate the last (assistant) message in place as tokens stream in.
    const patchLast = (fn: (m: Msg) => Msg) =>
        setMessages(ms => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

    // Start a fresh conversation. The previous chat stays persisted; a new one
    // is created server-side on the next message (chatId omitted).
    const newChat = () => {
        if (busy) return;
        chatIdRef.current = null;
        setInput("");
        setStatus("");
        typeGreeting();
    };

    const send = async () => {
        const text = input.trim();
        if (!text || busy) return;
        setInput("");
        setBusy(true);
        setStatus("Thinking…");
        setMessages(ms => [...ms, { role: "user", text }, { role: "assistant", text: "" }]);

        const toolLabel: Record<string, string> = {
            get_org_overview: "Reading org overview…",
            get_department_breakdown: "Breaking down by group…",
            get_score_trend: "Checking the trend…",
            search_research: "Consulting research…",
        };

        try {
            const res = await apiFetch("/manager/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chatId: chatIdRef.current, message: text, filters: filters ?? {} }),
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            // Parse the SSE stream: events separated by a blank line.
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const blocks = buffer.split("\n\n");
                buffer = blocks.pop() ?? "";
                for (const block of blocks) {
                    let event = "message";
                    let data = "";
                    for (const line of block.split("\n")) {
                        if (line.startsWith("event:")) event = line.slice(6).trim();
                        else if (line.startsWith("data:")) data += line.slice(5).trim();
                    }
                    if (!data) continue;
                    let payload: Record<string, unknown> = {};
                    try { payload = JSON.parse(data); } catch { continue; }

                    if (event === "meta") {
                        chatIdRef.current = (payload.chatId as string) ?? chatIdRef.current;
                    } else if (event === "tool") {
                        setStatus(toolLabel[payload.name as string] ?? "Working…");
                    } else if (event === "token") {
                        setStatus("");
                        patchLast(m => ({ ...m, text: m.text + (payload.delta as string) }));
                    } else if (event === "citations") {
                        patchLast(m => ({ ...m, citations: payload.citations as Citation[] }));
                    } else if (event === "error") {
                        patchLast(m => ({ ...m, text: (m.text || "") + `\n\n⚠️ ${payload.message as string}` }));
                    } else if (event === "done") {
                        setStatus("");
                    }
                }
            }
        } catch {
            patchLast(m => ({ ...m, text: m.text || "⚠️ Couldn't reach the assistant. Please try again." }));
        } finally {
            setStatus("");
            setBusy(false);
        }
    };

    return (
        <div className="ml-card ml-pad ml-chat">
            <div className="ml-sec-h">
                <h2>Wellbeing Assistant</h2>
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
                    placeholder="Ask about burnout trends…"
                    disabled={busy}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") send(); }}
                />
                <button onClick={send} aria-label="Send" disabled={!input.trim() || busy}>Send</button>
            </div>
        </div>
    );
}
